"""Add strictly opt-in, per-game turn sounds without changing legacy users."""

from alembic import op
import sqlalchemy as sa

revision = "accounts_002"
down_revision = "accounts_001"
branch_labels = None
depends_on = None


def upgrade():
    if not sa.inspect(op.get_bind()).has_table("account_turn_sound_options"):
        op.create_table(
            "account_turn_sound_options",
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("game", sa.String(16), primary_key=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default="0"),
        )


def downgrade():
    op.drop_table("account_turn_sound_options")
