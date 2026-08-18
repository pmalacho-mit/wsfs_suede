"""One process per workspace, and what happens when that is violated or lost."""

import asyncio
from uuid import UUID

import pytest

from sqlmodel import Session, select

from conftest import Api, acknowledged, created, listening, open_workspace, serving, version_of
from release.backend.models import Version


async def test_writes_to_one_workspace_are_serialized(api: Api, session: Session):
    await asyncio.gather(*(api.create(f"f{index}.py") for index in range(20)))

    positions = sorted(session.exec(select(Version.position)).all())
    assert positions == list(range(1, 21))


async def test_a_second_process_is_refused_a_workspace_another_holds(api: Api, processes):
    token = (await api.initialize())["token"]
    async with listening(api, token):  # a live stream pins the controller, and its lease
        async with serving(processes()) as elsewhere:
            intruder = Api(elsewhere, api.workspace, user="ada@example.com")
            assert (await intruder.create("a.py")).status_code == 503


async def test_a_second_process_may_serve_a_different_workspace(api: Api, processes):
    token = (await api.initialize())["token"]
    async with listening(api, token):
        async with serving(processes()) as elsewhere:
            neighbour = Api(elsewhere, await open_workspace(elsewhere), user="ada@example.com")
            assert created(await neighbour.create("a.py"))


async def test_the_lease_transfers_once_its_holder_lets_go(processes):
    async with serving(processes()) as first:
        workspace = await open_workspace(first)
        api = Api(first, workspace, user="ada@example.com")
        file = created(await api.create("a.py"))

    async with serving(processes()) as second:
        successor = Api(second, workspace, user="ada@example.com")
        assert [e["id"] for e in (await successor.initialize())["entries"]] == [file]
        acknowledged(await successor.rename(file, await version_of(successor, file), "b.py"))


async def test_a_restart_loses_nothing_and_the_stream_picks_up_where_it_left_off(processes):
    async with serving(processes()) as first:
        workspace = await open_workspace(first)
        api = Api(first, workspace, user="ada@example.com")
        file = created(await api.create("a.py"))
        acknowledged(await api.write(file, await version_of(api, file), "work"))
        before = await api.initialize()

    # Controller memory is rebuildable from zero: postgres remains the truth.
    async with serving(processes()) as second:
        api = Api(second, workspace, user="ada@example.com")
        after = await api.initialize()
        assert after["entries"] == before["entries"]

        async with listening(api, after["token"]) as heard:
            acknowledged(await api.rename(file, await version_of(api, file), "b.py"))
            assert (await heard.until(1))[0]["value"] == "b.py"

        assert (await api.content(file)).json()["content"] == "work"


async def test_an_idle_controller_is_retired_after_its_grace_period(api: Api, registry):
    created(await api.create("a.py"))
    workspace = UUID(api.workspace)

    assert registry.live(workspace) is not None
    await asyncio.sleep(0.4)  # grace_seconds is 0.2 in tests
    assert registry.live(workspace) is None


async def test_a_reconnect_within_the_grace_period_finds_the_same_controller(api: Api, registry):
    workspace = UUID(api.workspace)
    async with listening(api, (await api.initialize())["token"]):
        pinned = registry.live(workspace)
        assert registry.count(workspace) == 1

    await asyncio.sleep(0.05)  # inside the grace window
    async with listening(api, (await api.initialize())["token"]):
        assert registry.live(workspace) is pinned


def test_several_workers_are_refused_unless_someone_says_they_are_pinned(monkeypatch, tmp_path):
    from release.backend.main import SHARDING_ACKNOWLEDGED, create_app

    monkeypatch.setenv("WEB_CONCURRENCY", "4")
    with pytest.raises(RuntimeError, match="one workspace from several"):
        create_app(blob_root=tmp_path / "blobs")

    monkeypatch.setenv(SHARDING_ACKNOWLEDGED, "1")
    create_app(blob_root=tmp_path / "blobs").state.backend.engine.dispose()
