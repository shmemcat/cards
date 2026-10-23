"""Private in-container audit of a production restore; output aggregates only."""

from datetime import datetime, timedelta
import hashlib
import json
import os
import secrets
import sys
import urllib.request

import sqlalchemy as sa
from sqlalchemy.engine import make_url


class AuditError(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise AuditError(message)


def engine_for_restore():
    url = make_url(os.environ["DATABASE_URL"])
    require(
        url.host == "db"
        and url.database == "split_rehearsal"
        and url.username == "migrator"
        and url.query.get("options") == "-csearch_path=hearts",
        "Use only the private rehearsal database and hearts schema",
    )
    return sa.create_engine(url.set(drivername="postgresql+psycopg2"))


def table(connection, name, schema="hearts"):
    return sa.Table(name, sa.MetaData(), schema=schema, autoload_with=connection)


def fingerprint(connection, query, columns):
    digest, count = hashlib.sha256(), 0
    for row in connection.execute(query):
        digest.update(
            json.dumps(list(row), default=str, separators=(",", ":")).encode()
        )
        digest.update(b"\n")
        count += 1
    return {"columns": columns, "rows": count, "sha256": digest.hexdigest()}


def manifests(connection):
    return connection.execute(
        sa.text("SELECT value FROM rehearsal_audit.manifest")
    ).scalar_one()


def capture(connection):
    require(
        connection.execute(sa.text("SELECT current_schema()")).scalar_one() == "hearts",
        "Wrong schema",
    )
    revision = connection.execute(
        sa.text("SELECT version_num FROM hearts.alembic_version")
    ).scalar_one()
    require(revision == "019", "Restore requires verified legacy revision 019")
    connection.execute(sa.text("CREATE SCHEMA rehearsal_audit"))
    connection.execute(
        sa.text("CREATE TABLE rehearsal_audit.manifest (value JSONB NOT NULL)")
    )
    names = sa.inspect(connection).get_table_names(schema="hearts")
    records = {}
    for name in names:
        original = table(connection, name)
        columns = list(original.c.keys())
        keys = [column.name for column in original.primary_key]
        require(keys, "Verify primary keys before rehearsal")
        quoted = connection.dialect.identifier_preparer.quote_identifier(name)
        connection.execute(
            sa.text(f"CREATE TABLE rehearsal_audit.{quoted} AS TABLE hearts.{quoted}")
        )
        record = fingerprint(
            connection,
            sa.select(original).order_by(*[original.c[key] for key in keys]),
            columns,
        )
        record["keys"] = keys
        records[name] = record
    legacy = connection.execute(
        sa.text(
            "SELECT count(*) FROM hearts.active_games WHERE is_multiplayer "
            "AND coalesce((state_json::jsonb->>'account_links_version')::integer,0)<1"
        )
    ).scalar_one()
    sequences = [
        list(row)
        for row in connection.execute(
            sa.text(
                "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='hearts' ORDER BY sequencename"
            )
        )
    ]
    data = {
        "revision": revision,
        "tables": records,
        "sequences": sequences,
        "legacyMultiplayer": legacy,
    }
    connection.execute(
        sa.text("INSERT INTO rehearsal_audit.manifest VALUES (CAST(:value AS jsonb))"),
        {"value": json.dumps(data)},
    )
    require(
        legacy == 0,
        "Legacy multiplayer games require a drain before activating split workers",
    )
    return {
        "revision": revision,
        "tables": {name: value["rows"] for name, value in records.items()},
        "legacyMultiplayer": legacy,
    }


def verify(connection, originals=False):
    data = manifests(connection)
    expired = {"euchre_tables": 0, "account_sessions": 0}
    for name, record in data["tables"].items():
        current = table(connection, name)
        query = sa.select(*[current.c[column] for column in record["columns"]])
        expected = {key: record[key] for key in ("columns", "rows", "sha256")}
        if originals:
            reference = table(connection, name, "rehearsal_audit")
            query = query.select_from(
                current.join(
                    reference,
                    sa.and_(
                        *[current.c[key] == reference.c[key] for key in record["keys"]]
                    ),
                )
            )
            if name in expired:
                cutoff = datetime.fromisoformat(data["probeStarted"])
                expired_row = (
                    reference.c.updated_at < cutoff - timedelta(minutes=20)
                    if name == "euchre_tables"
                    else reference.c.expires_at <= cutoff
                )
                expected_query = sa.select(
                    *[reference.c[column] for column in record["columns"]]
                )
                expected_query = expected_query.where(~expired_row).order_by(
                    *[reference.c[key] for key in record["keys"]]
                )
                expected = fingerprint(connection, expected_query, record["columns"])
                expired[name] = record["rows"] - expected["rows"]
                query = query.where(~expired_row)
                remaining = connection.execute(
                    sa.select(sa.func.count())
                    .select_from(
                        current.join(
                            reference,
                            sa.and_(
                                *[
                                    current.c[key] == reference.c[key]
                                    for key in record["keys"]
                                ]
                            ),
                        )
                    )
                    .where(expired_row)
                ).scalar_one()
                require(
                    remaining == 0,
                    "Expired restored credentials were not cleaned up",
                )
        actual = fingerprint(
            connection,
            query.order_by(*[current.c[key] for key in record["keys"]]),
            record["columns"],
        )
        if actual != expected:
            reference = table(connection, name, "rehearsal_audit")
            joined = current.join(
                reference,
                sa.and_(
                    *[current.c[key] == reference.c[key] for key in record["keys"]]
                ),
            )
            changed_columns = [
                column
                for column in record["columns"]
                if connection.execute(
                    sa.select(sa.func.count())
                    .select_from(joined)
                    .where(current.c[column].is_distinct_from(reference.c[column]))
                ).scalar_one()
            ]
            raise AuditError(
                "Original records changed in "
                + name
                + "; columns="
                + ",".join(changed_columns)
                + "; rows="
                + str(actual["rows"])
                + ","
                + str(expected["rows"])
            )
    if not originals:
        for name, value in data["sequences"]:
            actual = connection.execute(
                sa.text(
                    "SELECT last_value FROM pg_sequences WHERE schemaname='hearts' AND sequencename=:name"
                ),
                {"name": name},
            ).scalar_one()
            require(actual == value, "An original sequence changed during migration")
    return {
        "originalColumnsPreserved": True,
        "tablesVerified": len(data["tables"]),
        "expiredEuchreSnapshotsCleaned": expired["euchre_tables"],
        "expiredAccountSessionsCleaned": expired["account_sessions"],
    }


def existing_account(engine):
    from cards_accounts.account_sessions import fingerprint as token_hash

    now = datetime.utcnow()
    raw, csrf = secrets.token_urlsafe(40), secrets.token_hex(32)
    with engine.begin() as connection:
        user = (
            connection.execute(
                sa.text(
                    "SELECT u.id,u.username,u.password_hash,u.profile_icon,p.card_style,s.games_won "
                    "FROM hearts.users u JOIN hearts.user_preferences p ON p.user_id=u.id "
                    "JOIN hearts.user_stats s ON s.user_id=u.id WHERE u.email_verified ORDER BY u.id LIMIT 1"
                )
            )
            .mappings()
            .first()
        )
        require(
            user is not None,
            "A verified existing account with preferences/stats is required",
        )
        connection.execute(
            sa.text(
                "INSERT INTO hearts.account_sessions "
                "(token_hash,user_id,csrf_token,credential_hash,created_at,last_seen_at,expires_at) "
                "VALUES (:hash,:user,:csrf,:credential,:now,:now,:expires)"
            ),
            {
                "hash": token_hash(raw),
                "user": user["id"],
                "csrf": csrf,
                "credential": token_hash(user["password_hash"]),
                "now": now,
                "expires": now + timedelta(hours=1),
            },
        )
        save_ids = (
            connection.execute(
                sa.text(
                    "SELECT game_id FROM hearts.active_games WHERE NOT is_multiplayer ORDER BY id"
                )
            )
            .scalars()
            .all()
        )
        result_count = connection.execute(
            sa.text(
                "SELECT count(*) FROM hearts.euchre_game_results WHERE user_id=:user AND difficulty='multiplayer'"
            ),
            {"user": user["id"]},
        ).scalar_one()

    def get(path):
        request = urllib.request.Request(
            "http://gateway:8080/api/" + path,
            headers={
                "Cookie": "cards_session=" + raw,
                "Origin": os.environ["CARDS_PUBLIC_URL"],
                "X-CSRF-Token": csrf,
            },
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    try:
        session = get("account/session")["user"]
        require(
            session["id"] == str(user["id"]) and session["name"] == user["username"],
            "Existing identity mismatch",
        )
        require(
            session["profile_icon"] == user["profile_icon"], "Existing profile mismatch"
        )
        require(
            session["preferences"]["card_style"] == user["card_style"],
            "Existing preference mismatch",
        )
        require(
            get("hearts/stats")["stats"]["games_won"] == user["games_won"],
            "Existing score mismatch",
        )
        require(
            len(get("euchre/multiplayer-results")["results"]) == result_count,
            "Existing Euchre history mismatch",
        )
        for save_id in save_ids:
            require(
                bool(get("hearts/games/" + save_id)),
                "Existing saved game did not recover",
            )
        return {
            "existingIdentity": True,
            "existingProfile": True,
            "existingPreferences": True,
            "existingScores": True,
            "existingEuchreHistory": True,
            "existingSoloRecovery": bool(save_ids),
            "existingSoloSavesRecovered": len(save_ids),
            "credential": "rehearsal-only opaque session; production credentials not used",
        }
    finally:
        with engine.begin() as connection:
            connection.execute(
                sa.text("DELETE FROM hearts.account_sessions WHERE token_hash=:hash"),
                {"hash": token_hash(raw)},
            )


def main():
    engine = engine_for_restore()
    mode = sys.argv[1]
    try:
        if mode == "existing-account":
            result = existing_account(engine)
        else:
            with engine.begin() as connection:
                if mode == "capture":
                    result = capture(connection)
                elif mode in {"verify", "verify-originals"}:
                    result = verify(connection, originals=mode == "verify-originals")
                elif mode == "mark-probe":
                    data = manifests(connection)
                    data["probeStarted"] = datetime.utcnow().isoformat()
                    connection.execute(
                        sa.text(
                            "UPDATE rehearsal_audit.manifest SET value=CAST(:value AS jsonb)"
                        ),
                        {"value": json.dumps(data)},
                    )
                    result = {"probeMarked": True}
                else:
                    raise AuditError("Unknown audit action")
        print(json.dumps(result))
    finally:
        engine.dispose()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(
            str(error)
            if isinstance(error, AuditError)
            else "Private audit failed: " + type(error).__name__
        ) from None
