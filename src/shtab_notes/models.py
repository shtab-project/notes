from shtab_core.models import User
from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    Uuid,
)

metadata = MetaData()

workspaces = Table(
    "notes_workspaces",
    metadata,
    Column("key", String(36), primary_key=True),
    Column("revision", Integer, nullable=False),
    Column("folders", JSON, nullable=False),
    Column("imports", JSON, nullable=False),
)

notes = Table(
    "notes_entries",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column(
        "owner_id",
        Uuid,
        ForeignKey(User.__table__.c.id, ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("visibility", String(7), nullable=False, index=True),
    Column("title", String(200), nullable=False),
    Column("folder", Text, nullable=False),
    Column("body", Text, nullable=False),
    Column("pinned", Boolean, nullable=False),
    Column("created_at", String(40), nullable=False),
    Column("updated_at", String(40), nullable=False),
    Column("published_at", String(40)),
    CheckConstraint("visibility IN ('private', 'shared')", name="ck_notes_visibility"),
)
