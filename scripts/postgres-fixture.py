"""Synthetic PostgreSQL data only, inside the isolated Compose database service."""

import hashlib
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
import sys

from sqlalchemy import MetaData, create_engine, inspect, text
from sqlalchemy.engine import make_url

url = make_url(os.environ["DATABASE_URL"])
if (
    url.host != "db"
    or url.database not in {"split_rehearsal", "split_legacy", "split_restored"}
    or url.username != "migrator"
):
    raise RuntimeError("Use only this rehearsal's private disposable database")
engine = create_engine(url.set(drivername="postgresql+psycopg2"))
mode = sys.argv[1]


def seed():
    from alembic import command
    from alembic.config import Config
    from cards_accounts.auth_utils import hash_password
    from cards_accounts.account_sessions import fingerprint

    config = Config()
    config.set_main_option(
        "script_location", str(Path(__file__).parent / "postgres-legacy")
    )
    config.set_main_option("version_locations", "/legacy/versions")
    with engine.begin() as connection:
        assert not inspect(connection).get_table_names()
        connection.execute(text("CREATE SCHEMA hearts"))
        connection.execute(text("SET search_path TO hearts"))
        config.attributes["connection"] = connection
        command.upgrade(config, "019")
        metadata = MetaData()
        metadata.reflect(connection)
        now = datetime.utcnow()
        password = hash_password("preserved-password-123")
        user_id = connection.execute(
            metadata.tables["users"]
            .insert()
            .values(
                username="preserved",
                email="preserved@example.test",
                password_hash=password,
                email_verified=True,
                verification_token="preserved-verification",
                created_at=datetime(2020, 1, 1),
                auth_version=9,
                profile_icon="cat",
            )
            .returning(metadata.tables["users"].c.id)
        ).scalar_one()
        values = {
            "account_sessions": dict(
                token_hash=fingerprint("preserved-session"),
                user_id=user_id,
                csrf_token="c" * 64,
                credential_hash=fingerprint(password),
                created_at=now,
                last_seen_at=now,
                expires_at=now + timedelta(days=1),
            ),
            "password_reset_tokens": dict(
                user_id=user_id,
                token_hash="preserved-recovery",
                created_at=now,
                expires_at=now + timedelta(days=1),
            ),
            "user_stats": dict(
                user_id=user_id, games_played=8, games_won=5, moon_shots=3
            ),
            "user_preferences": dict(user_id=user_id, card_style="flourish"),
            "difficulty_stats": dict(
                user_id=user_id, category="easy", games_played=8, games_won=5
            ),
            "game_results": dict(
                user_id=user_id, difficulty="easy", won=True, completed_at=now
            ),
            "active_games": dict(
                user_id=user_id,
                game_id="preserved-save",
                created_at=now,
                updated_at=now,
                state_json='{"account_links_version":1,"preserved":"save"}',
            ),
            "euchre_game_results": dict(
                user_id=user_id,
                game_id="preserved-euchre",
                difficulty="easy",
                won=True,
                conceded=False,
                score=10,
                opponent_score=5,
                completed_at=now,
                recorded_at=now,
            ),
            "euchre_tables": dict(
                code="KEEPME",
                updated_at=now,
                snapshot=json.dumps(
                    {
                        "seats": [
                            {
                                "userId": user_id,
                                "name": "preserved",
                                "token": "preserved-seat",
                            },
                            None,
                            None,
                            None,
                        ],
                        "participants": [],
                        "unseated": {},
                    }
                ),
            ),
        }
        for name, row in values.items():
            connection.execute(metadata.tables[name].insert().values(**row))


def fingerprints():
    with engine.connect() as connection:
        result = {}
        for name in (
            "alembic_version",
            "users",
            "account_sessions",
            "password_reset_tokens",
            "user_stats",
            "user_preferences",
            "difficulty_stats",
            "game_results",
            "active_games",
            "euchre_tables",
            "euchre_game_results",
        ):
            rows = (
                connection.execute(
                    text(
                        f'SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text'
                    )
                )
                .scalars()
                .all()
            )
            assert rows, f"Missing synthetic records in {name}"
            result[name] = {
                "rows": len(rows),
                "sha256": hashlib.sha256("\n".join(rows).encode()).hexdigest(),
            }
        print(json.dumps(result))


def privileges():
    owned = {
        "accounts_runtime": {
            "users",
            "account_sessions",
            "password_reset_tokens",
            "account_deletion_requests",
            "account_id_sequence",
        },
        "hearts_runtime": {
            "active_games",
            "user_stats",
            "user_preferences",
            "difficulty_stats",
            "game_results",
            "hearts_account_deletions",
        },
        "euchre_runtime": {
            "euchre_tables",
            "euchre_game_results",
            "euchre_account_deletions",
        },
    }
    versions = {
        "accounts_runtime": {"cards_accounts_alembic_version"},
        "hearts_runtime": {"hearts_alembic_version", "hearts_account_schema_version"},
        "euchre_runtime": {"euchre_alembic_version", "euchre_account_schema_version"},
    }
    checks = 0
    with engine.connect() as connection:
        schema = connection.execute(text("SELECT current_schema()")).scalar_one()
        tables = inspect(connection).get_table_names()
        for role in owned:
            flags = connection.execute(
                text(
                    "SELECT rolsuper, rolcreaterole, rolcreatedb, rolinherit FROM pg_roles WHERE rolname=:role"
                ),
                {"role": role},
            ).one()
            assert not any(flags), (role, flags)
            assert not connection.execute(
                text("SELECT has_schema_privilege(:role,:schema,'CREATE')"),
                {"role": role, "schema": schema},
            ).scalar_one()
            for other in owned.keys() - {role}:
                assert not connection.execute(
                    text("SELECT pg_has_role(:role,:other,'MEMBER')"),
                    {"role": role, "other": other},
                ).scalar_one()
            for table in tables:
                for privilege in (
                    "SELECT",
                    "INSERT",
                    "UPDATE",
                    "DELETE",
                    "TRUNCATE",
                    "REFERENCES",
                    "TRIGGER",
                ):
                    expected = (
                        table in owned[role]
                        and privilege in {"SELECT", "INSERT", "UPDATE", "DELETE"}
                    ) or (table in versions[role] and privilege == "SELECT")
                    actual = connection.execute(
                        text("SELECT has_table_privilege(:role,:table,:privilege)"),
                        {
                            "role": role,
                            "table": f"{schema}.{table}",
                            "privilege": privilege,
                        },
                    ).scalar_one()
                    assert actual == expected, (
                        role,
                        table,
                        privilege,
                        actual,
                        expected,
                    )
                    checks += 1
            for table in set().union(*owned.values()):
                sequence = (
                    connection.execute(
                        text("SELECT pg_get_serial_sequence(:table,'id')"),
                        {"table": f"{schema}.{table}"},
                    ).scalar()
                    if table
                    not in {
                        "account_sessions",
                        "hearts_account_deletions",
                        "euchre_account_deletions",
                        "euchre_tables",
                    }
                    else None
                )
                if sequence:
                    for privilege in ("USAGE", "SELECT", "UPDATE"):
                        actual = connection.execute(
                            text(
                                "SELECT has_sequence_privilege(:role,:sequence,:privilege)"
                            ),
                            {
                                "role": role,
                                "sequence": sequence,
                                "privilege": privilege,
                            },
                        ).scalar_one()
                        assert actual == (
                            table in owned[role] and privilege != "UPDATE"
                        ), (role, sequence, privilege)
                        checks += 1
        print(json.dumps({"roles": len(owned), "permissionChecks": checks}))


if mode == "seed":
    seed()
elif mode == "fingerprints":
    fingerprints()
elif mode == "privileges":
    privileges()
else:
    raise SystemExit("Use seed, fingerprints, or privileges")
engine.dispose()
