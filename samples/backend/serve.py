"""Serve the sample host, for a browser or a benchmark to talk to.

The test suite builds this app in-process; this is the same app with a port
and a schema, so a frontend has something to point at. ONE WORKER, because
one process per workspace is the invariant the controller rests on.

    python -m samples.backend.serve            # http://0.0.0.0:8099
"""

from __future__ import annotations

import os

import uvicorn
from sqlmodel import SQLModel, create_engine

from .app import create_sample_app
from ...wsfs_suede__sqlmodel_utils_suede.postgres.config import (
    ConfigFromEnvironment,
    config_to_url,
)


def create_tables() -> None:
    """Stand-in for the migration this does not have yet (see TODO.md §2)."""
    engine = create_engine(config_to_url(ConfigFromEnvironment(), addon="psycopg"))
    SQLModel.metadata.create_all(engine)
    engine.dispose()


def main() -> None:
    create_tables()
    uvicorn.run(
        create_sample_app(),
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8099")),
        log_level="warning",
    )


if __name__ == "__main__":
    main()
