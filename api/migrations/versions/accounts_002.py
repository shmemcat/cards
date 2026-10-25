"""Add strictly opt-in, per-game turn sounds without changing legacy users."""

from alembic import op

revision = "accounts_002"
down_revision = "accounts_001"
branch_labels = None
depends_on = None


def upgrade():
    from cards_accounts.models import TurnSoundOption

    TurnSoundOption.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    op.drop_table("account_turn_sound_options")
