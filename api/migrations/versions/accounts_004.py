"""Save card-back choices with each account, separately for each game."""

from alembic import op
import sqlalchemy as sa

revision = "accounts_004"
down_revision = "accounts_003"
branch_labels = None
depends_on = None


def upgrade():
    if not sa.inspect(op.get_bind()).has_table("account_card_backs"):
        op.create_table(
            "account_card_backs",
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("game", sa.String(16), primary_key=True),
            sa.Column("design", sa.String(64), nullable=False, server_default="argyle"),
        )


def downgrade():
    op.drop_table("account_card_backs")
