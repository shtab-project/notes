"""Store the publication time for shared notes."""

import sqlalchemy as sa
from alembic import op

revision = "notes_0002"
down_revision = "notes_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("notes_entries", sa.Column("published_at", sa.String(40)))


def downgrade() -> None:
    op.drop_column("notes_entries", "published_at")
