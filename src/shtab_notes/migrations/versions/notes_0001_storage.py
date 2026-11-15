"""Initial tables for private and shared notes."""

import sqlalchemy as sa
from alembic import op

revision = "notes_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notes_workspaces",
        sa.Column("key", sa.String(36), primary_key=True),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("folders", sa.JSON, nullable=False),
        sa.Column("imports", sa.JSON, nullable=False),
    )
    op.create_table(
        "notes_entries",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column(
            "owner_id",
            sa.Uuid,
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("visibility", sa.String(7), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("folder", sa.Text, nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("pinned", sa.Boolean, nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False),
        sa.CheckConstraint(
            "visibility IN ('private', 'shared')", name="ck_notes_visibility"
        ),
    )
    op.create_index("ix_notes_entries_owner_id", "notes_entries", ["owner_id"])
    op.create_index("ix_notes_entries_visibility", "notes_entries", ["visibility"])


def downgrade() -> None:
    op.drop_table("notes_entries")
    op.drop_table("notes_workspaces")
