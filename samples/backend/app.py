"""A sample host application, of the kind wsfs is meant to be mounted into.

Everything here is the HOST's: its own users, its own workspaces, its own idea
of who may reach one. wsfs is handed two table names and a dependency, and
decides nothing else -- which is the whole point of the exercise, and the
reason this lives outside `release/`.

The test suite drives wsfs through this app rather than through a fixture of
its own, so the integration path is the one under test.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import FastAPI, Header, HTTPException
from fastapi import Path as APIPath
from sqlmodel import Field, select
from sqlmodel.ext.asyncio.session import AsyncSession

from wsfs_suede.release.backend.blobs import FilesystemBlobs
from wsfs_suede.release.backend.main import Backend, create_router
from wsfs_suede.release.backend.models import build_models
from wsfs_suede.wsfs_suede__sqlmodel_utils_suede.associations import WithID
from wsfs_suede.wsfs_suede__sqlmodel_utils_suede.postgres.db import Database
from wsfs_suede.wsfs_suede__sqlmodel_utils_suede.tablenames import tablename


class Account(WithID, tablename("plural"), table=True):
    """The host's users. wsfs never reads this table -- it stores ids that
    point at it."""

    email: str = Field(index=True, unique=True, nullable=False)


class Project(WithID, tablename("plural"), table=True):
    """The host's workspaces, with whatever else a host would keep here."""

    name: str = Field(default="", nullable=False)


MODELS = build_models(user_table=Account, workspace_table=Project)


async def enrolled(session: AsyncSession, email: str) -> Account:
    known = (await session.exec(select(Account).where(Account.email == email))).first()
    if known is not None:
        return known
    account = Account(email=email)
    session.add(account)
    await session.commit()
    return account


# pyright: reportUnusedFunction=false
def create_sample_app(
    *,
    database: Database | None = None,
    blob_root: Path = Path("/tmp/wsfs-blobs"),
    heartbeat_seconds: float = 15.0,
    grace_seconds: float = 30.0,
    max_blob_bytes: int = 64 * 1024 * 1024,
) -> FastAPI:
    database = database or Database()
    app = FastAPI(title="wsfs sample host")

    async def authorize(
        workspace_id: Annotated[UUID, APIPath()],
        x_user_email: Annotated[str, Header()],
    ) -> UUID:
        """The host's policy, in the one place a host would put it: who this
        caller is, and whether they may reach this workspace."""
        async with database.session() as session:
            project = await session.get(Project, workspace_id)
            if project is None:
                raise HTTPException(404, "no such workspace")
            return (await enrolled(session, x_user_email)).id

    @app.post("/projects", status_code=201)
    async def open_project() -> dict[str, str]:
        async with database.session() as session:
            project = Project()
            session.add(project)
            await session.commit()
            return {"id": str(project.id)}

    backend = Backend.over(
        MODELS,
        database,
        FilesystemBlobs(blob_root),
        heartbeat_seconds=heartbeat_seconds,
        grace_seconds=grace_seconds,
        max_blob_bytes=max_blob_bytes,
    )
    app.include_router(create_router(backend=backend, authorize=authorize))
    app.state.wsfs = backend
    return app
