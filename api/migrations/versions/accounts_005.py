"""Save whether a player sees uniform or individual card backs."""

from alembic import op
import sqlalchemy as sa

revision = "accounts_005"
down_revision = "accounts_004"
branch_labels = None
depends_on = None


def upgrade():
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("account_card_backs")
    }
    if "display_mode" not in columns:
        op.add_column(
            "account_card_backs",
            sa.Column(
                "display_mode", sa.String(16), nullable=False, server_default="uniform"
            ),
        )


def downgrade():
    with op.batch_alter_table("account_card_backs") as table:
        table.drop_column("display_mode")
