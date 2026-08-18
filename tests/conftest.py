"""Fixtures, and a client that speaks the protocol rather than HTTP."""

import asyncio
import json
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from sqlalchemy import Engine, text
from sqlmodel import Session, SQLModel, create_engine

# Imported for the side effect: models swaps SQLModel.metadata for one carrying
# the library's naming convention, and registers every table.
from release.backend import models  # noqa: F401
from release.backend.blobs import digest_of
from release.backend.main import create_app
from wsfs_suede__sqlmodel_utils_suede.postgres.config import (
    ConfigFromEnvironment,
    config_to_url,
)


@pytest.fixture(scope="session")
def engine() -> Iterator[Engine]:
    engine = create_engine(config_to_url(ConfigFromEnvironment(), addon="psycopg"))
    yield engine
    engine.dispose()


@pytest.fixture(scope="session", autouse=True)
def schema(engine: Engine) -> Iterator[None]:
    # a `--keep`ed stack can carry tables (and enum types) over from a prior run
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    yield
    SQLModel.metadata.drop_all(engine)


@pytest.fixture(autouse=True)
def clean_tables(engine: Engine) -> None:
    """Empty every table before each test, so ordering can't couple them."""
    tables = ", ".join(f'"{table.name}"' for table in SQLModel.metadata.sorted_tables)
    with engine.begin() as connection:
        connection.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    with Session(engine) as session:
        yield session


@pytest.fixture
def processes(tmp_path):
    """Build an independent backend process over the same database."""
    built = 0

    def build() -> FastAPI:
        nonlocal built
        built += 1
        return create_app(
            blob_root=tmp_path / f"blobs-{built}", heartbeat_seconds=0.05, grace_seconds=0.2
        )

    return build


@pytest.fixture
def app(processes) -> FastAPI:
    return processes()


@pytest.fixture
def registry(app: FastAPI):
    return app.state.backend.registry


@asynccontextmanager
async def serving(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """One process serving workspaces -- the topology the design assumes."""
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    )
    running = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
            yield client
    finally:
        server.should_exit = True
        await asyncio.wait_for(running, timeout=10)
        app.state.backend.engine.dispose()


@pytest.fixture
async def instance(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with serving(app) as client:
        yield client


class Api:
    """One client instance: its own transaction counter, its own outbox."""

    def __init__(self, http: httpx.AsyncClient, workspace: str, user: str) -> None:
        self.http = http
        self.workspace = workspace
        self.user = user
        self.client = uuid4().hex
        self._counter = 0

    def transaction(self) -> str:
        self._counter += 1
        return f"{self.client}:{self._counter}"

    @property
    def _headers(self) -> dict[str, str]:
        return {"X-User-Email": self.user}

    async def submit(self, **request: Any) -> httpx.Response:
        request.setdefault("transaction", self.transaction())
        return await self.http.post(
            f"/workspaces/{self.workspace}/transactions",
            json=request,
            headers=self._headers,
        )

    async def create(self, name: str, *, type: str = "file", parent: str | None = None, **kw):
        return await self.submit(op="create", type=type, name=name, parent=parent, **kw)

    async def rename(self, id: str, version: str, name: str, **kw):
        return await self.submit(op="rename", id=id, version=version, name=name, **kw)

    async def reparent(self, id: str, version: str, parent: str | None, **kw):
        return await self.submit(op="reparent", id=id, version=version, parent=parent, **kw)

    async def delete(self, id: str, version: str, **kw):
        return await self.submit(op="delete", id=id, version=version, **kw)

    async def write(self, id: str, version: str, content: str, **kw):
        return await self.submit(op="write", type="text", id=id, version=version, content=content, **kw)

    async def write_blob(self, id: str, version: str, *, hash: str, size: int, mime: str, **kw):
        return await self.submit(
            op="write", type="binary", id=id, version=version, hash=hash, size=size, mime=mime, **kw
        )

    async def store(self, data: bytes, mime: str = "application/octet-stream") -> str:
        digest = digest_of(data)
        response = await self.http.put(f"/blobs/{digest}", content=data, headers={"Content-Type": mime})
        assert response.status_code == 200, response.text
        return digest

    async def initialize(self, outbox: list[dict] | None = None) -> dict:
        response = await self.http.post(
            f"/workspaces/{self.workspace}/initialize",
            json={"outbox": outbox or []},
            headers=self._headers,
        )
        assert response.status_code == 200, response.text
        return response.json()

    async def content(self, id: str, version: str | None = None) -> httpx.Response:
        query = "" if version is None else f"?version={version}"
        return await self.http.get(
            f"/workspaces/{self.workspace}/entries/{id}/content{query}", headers=self._headers
        )

    def stream(self, token: str):
        return self.http.stream("GET", f"/workspaces/{self.workspace}/stream?token={token}")


async def open_workspace(http: httpx.AsyncClient) -> str:
    response = await http.post("/workspaces")
    assert response.status_code == 201, response.text
    return response.json()["id"]


@pytest.fixture
async def workspace(instance: httpx.AsyncClient) -> str:
    return await open_workspace(instance)


@pytest.fixture
async def api(instance: httpx.AsyncClient, workspace: str) -> Api:
    return Api(instance, workspace, user="ada@example.com")


@pytest.fixture
async def other(instance: httpx.AsyncClient, workspace: str) -> Api:
    """A second client in the same workspace -- another tab, or another user."""
    return Api(instance, workspace, user="grace@example.com")


def created(response: httpx.Response) -> str:
    assert response.status_code == 200, response.text
    return response.json()["id"]


def acknowledged(response: httpx.Response) -> dict:
    assert response.status_code == 200, response.text
    assert response.json()["rejected"] is False
    return response.json()


def refused(response: httpx.Response) -> dict:
    assert response.status_code == 409, response.text
    assert response.json()["rejected"] is True
    return response.json()


async def version_of(api: Api, entry_id: str) -> str:
    snapshot = await api.initialize()
    return next(e["version"] for e in snapshot["entries"] if e["id"] == entry_id)


class Listener:
    """Everything one SSE connection has seen, as it arrives."""

    def __init__(self) -> None:
        self.events: list[dict] = []

    async def _drain(self, response: httpx.Response) -> None:
        async for line in response.aiter_lines():
            if line.startswith("data: "):
                self.events.append(json.loads(line.removeprefix("data: ")))

    async def until(self, count: int, timeout: float = 5.0) -> list[dict]:
        deadline = time.monotonic() + timeout
        while len(self.events) < count and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert len(self.events) >= count, f"expected {count}, saw {self.events}"
        return self.events


@asynccontextmanager
async def listening(api: Api, token: str) -> AsyncIterator[Listener]:
    listener = Listener()
    async with api.stream(token) as response:
        assert response.status_code == 200, await response.aread()
        reading = asyncio.create_task(listener._drain(response))
        await asyncio.sleep(0.1)  # let the replay drain and the subscription land
        try:
            yield listener
        finally:
            reading.cancel()
