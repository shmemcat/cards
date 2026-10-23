from alembic import context
from cards_accounts.extensions import db

connection = context.config.attributes["connection"]
context.configure(
    connection=connection,
    target_metadata=db.metadata,
    version_table="cards_accounts_alembic_version",
    compare_type=True,
)
with context.begin_transaction():
    context.run_migrations()
