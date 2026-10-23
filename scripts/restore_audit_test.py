"""Preservation checks must never excuse loss of a valid session."""

from datetime import datetime, timedelta
import importlib.util
from pathlib import Path
import unittest

import sqlalchemy as sa

spec = importlib.util.spec_from_file_location(
    "restore_audit", Path(__file__).with_name("restore-audit.py")
)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class SessionPreservationTests(unittest.TestCase):
    def setUp(self):
        self.engine = sa.create_engine("sqlite://")
        self.connection = self.engine.connect()
        self.connection.exec_driver_sql("ATTACH DATABASE ':memory:' AS hearts")
        self.connection.exec_driver_sql("ATTACH DATABASE ':memory:' AS rehearsal_audit")
        self.now = datetime(2026, 10, 22, 12)
        metadata = sa.MetaData()
        tables = [
            sa.Table(
                "account_sessions",
                metadata,
                sa.Column("token_hash", sa.String, primary_key=True),
                sa.Column("expires_at", sa.DateTime, nullable=False),
                sa.Column("credential_hash", sa.String, nullable=False),
                schema=schema,
            )
            for schema in ("hearts", "rehearsal_audit")
        ]
        metadata.create_all(self.connection)
        self.current, self.reference = tables
        rows = [
            dict(
                token_hash="expired",
                expires_at=self.now - timedelta(seconds=1),
                credential_hash="old",
            ),
            dict(
                token_hash="valid",
                expires_at=self.now + timedelta(days=1),
                credential_hash="retained",
            ),
        ]
        for table in tables:
            self.connection.execute(table.insert(), rows)
        record = audit.fingerprint(
            self.connection,
            sa.select(self.reference).order_by(self.reference.c.token_hash),
            list(self.reference.c.keys()),
        )
        record["keys"] = ["token_hash"]
        self.original_manifest = audit.manifests
        audit.manifests = lambda connection: {
            "probeStarted": self.now.isoformat(),
            "tables": {"account_sessions": record},
        }

    def tearDown(self):
        audit.manifests = self.original_manifest
        self.connection.close()
        self.engine.dispose()

    def expire(self):
        self.connection.execute(
            self.current.delete().where(self.current.c.token_hash == "expired")
        )

    def test_only_expired_session_cleanup_is_allowed(self):
        self.expire()
        result = audit.verify(self.connection, originals=True)
        self.assertEqual(result["expiredAccountSessionsCleaned"], 1)
        self.assertTrue(result["originalColumnsPreserved"])

    def test_valid_session_loss_is_rejected(self):
        self.connection.execute(self.current.delete())
        with self.assertRaisesRegex(
            audit.AuditError, "Original records changed in account_sessions"
        ):
            audit.verify(self.connection, originals=True)

    def test_valid_credential_changes_are_rejected(self):
        self.expire()
        self.connection.execute(
            self.current.update()
            .where(self.current.c.token_hash == "valid")
            .values(credential_hash="changed")
        )
        with self.assertRaisesRegex(audit.AuditError, "columns=credential_hash"):
            audit.verify(self.connection, originals=True)

    def test_expired_credentials_must_be_removed_by_the_functional_probe(self):
        with self.assertRaisesRegex(audit.AuditError, "Expired restored credentials"):
            audit.verify(self.connection, originals=True)


if __name__ == "__main__":
    unittest.main()
