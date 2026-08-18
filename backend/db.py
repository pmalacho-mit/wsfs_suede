"""Engines and sessions.

Handlers stay synchronous SQLModel, run in a worker thread under the workspace
controller's lock: the controller already provides the async seam, so the ORM
does not need one.
"""

from __future__ import annotations

from sqlalchemy import Engine
from sqlalchemy.pool import NullPool
from sqlmodel import create_engine

from wsfs_suede__sqlmodel_utils_suede.postgres.config import (
    Config,
    ConfigFromEnvironment,
    config_to_url,
)


def _url(config: Config | None) -> str:
    return config_to_url(config or ConfigFromEnvironment(), addon="psycopg")


def engine(config: Config | None = None, *, echo: bool = False) -> Engine:
    """The request pool. Each submit() briefly holds one connection."""
    return create_engine(_url(config), pool_pre_ping=True, echo=echo)


def lease_engine(config: Config | None = None) -> Engine:
    """Connections for advisory locks, which are session-level: recycling one
    silently drops the lock, so these never come from the request pool."""
    return create_engine(_url(config), poolclass=NullPool)
