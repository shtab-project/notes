import asyncio

from alembic import context
from shtab_core.config import settings
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import create_async_engine

from shtab_notes.models import metadata

config = context.config


def include_name(name, type_, parent_names):
    # Autogenerate не должен предлагать удаление таблиц ядра и других плагинов.
    return type_ != "table" or name.startswith("notes_")


def configure(**kwargs):
    context.configure(
        target_metadata=metadata,
        version_table="notes_alembic_version",
        include_name=include_name,
        compare_type=True,
        **kwargs,
    )


def run(connection):
    configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_async():
    engine = create_async_engine(settings.database_url, poolclass=pool.NullPool)
    try:
        async with engine.connect() as connection:
            await connection.run_sync(run)
    finally:
        await engine.dispose()


if context.is_offline_mode():
    configure(
        url=settings.database_url,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()
elif (connection := config.attributes.get("connection")) is not None:
    run(connection)
else:
    asyncio.run(run_async())
