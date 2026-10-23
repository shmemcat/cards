"""Aggregate-only checks; snapshots stay inside disposable PostgreSQL tmpfs."""

import importlib.util
import json
from pathlib import Path
import sys

import sqlalchemy as sa

spec = importlib.util.spec_from_file_location(
    "restore_audit", Path(__file__).with_name("restore-audit.py")
)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def main():
    engine = audit.engine_for_restore()
    try:
        with engine.begin() as c:
            mode = sys.argv[1]
            if mode == "deletions":
                result = dict(
                    pending=c.execute(
                        sa.text(
                            "SELECT count(*) FROM account_deletion_requests WHERE status <> 'completed'"
                        )
                    ).scalar_one()
                )
            elif mode == "capture":
                records = {}
                for name in [
                    "users",
                    "user_preferences",
                    "user_stats",
                    "difficulty_stats",
                    "game_results",
                    "euchre_game_results",
                    "active_games",
                    "euchre_tables",
                    "account_deletion_requests",
                    "hearts_account_deletions",
                    "euchre_account_deletions",
                ]:
                    t = audit.table(c, name)
                    cols = list(t.c.keys())
                    records[name] = audit.fingerprint(
                        c, sa.select(t).order_by(*list(t.primary_key)), cols
                    )
                c.execute(
                    sa.text(
                        "CREATE TABLE IF NOT EXISTS rehearsal_audit.cutover_state (value JSONB NOT NULL)"
                    )
                )
                c.execute(sa.text("DELETE FROM rehearsal_audit.cutover_state"))
                c.execute(
                    sa.text(
                        "INSERT INTO rehearsal_audit.cutover_state VALUES (CAST(:value AS jsonb))"
                    ),
                    dict(value=json.dumps(records)),
                )
                result = dict(capturedTables=len(records))
            elif mode == "verify":
                records = c.execute(
                    sa.text("SELECT value FROM rehearsal_audit.cutover_state")
                ).scalar_one()
                for name, expected in records.items():
                    t = audit.table(c, name)
                    actual = audit.fingerprint(
                        c,
                        sa.select(*[t.c[col] for col in expected["columns"]]).order_by(
                            *list(t.primary_key)
                        ),
                        expected["columns"],
                    )
                    audit.require(
                        actual == expected, "Cutover changed saved records in " + name
                    )
                result = dict(
                    preservedTables=len(records), newRecordsAndCredentialsPreserved=True
                )
            else:
                raise audit.AuditError("Unknown cutover audit action")
        print(json.dumps(result))
    finally:
        engine.dispose()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(
            str(error)
            if isinstance(error, audit.AuditError)
            else "Cutover audit failed: " + type(error).__name__
        ) from None
