"""Add a per-game turn indicator choice and its own volume."""

from alembic import op
import sqlalchemy as sa

revision = "accounts_003"
down_revision = "accounts_002"
branch_labels = None
depends_on = None


def upgrade():
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns(
            "account_turn_sound_options"
        )
    }
    if "sound" not in columns:
        op.add_column(
            "account_turn_sound_options",
            sa.Column("sound", sa.String(24), nullable=False, server_default="pop"),
        )
    if "volume" not in columns:
        op.add_column(
            "account_turn_sound_options",
            sa.Column("volume", sa.Float(), nullable=False, server_default="0.15"),
        )


def downgrade():
    with op.batch_alter_table("account_turn_sound_options") as table:
        table.drop_column("volume")
        table.drop_column("sound")
