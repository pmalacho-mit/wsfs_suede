"""The shape of the tree: naming, nesting, and what a deletion reaches."""

from uuid import UUID

from sqlmodel import Session

from conftest import Api, acknowledged, created, version_of
from release.backend import tree


async def test_a_name_is_only_taken_within_its_own_folder(api: Api):
    first = created(await api.create("src", type="folder"))
    second = created(await api.create("test", type="folder"))

    assert created(await api.create("main.py", parent=first))
    assert created(await api.create("main.py", parent=second))
    assert created(await api.create("main.py"))


async def test_the_snapshot_carries_every_entry_with_its_parent(api: Api):
    folder = created(await api.create("src", type="folder"))
    nested = created(await api.create("deep", type="folder", parent=folder))
    leaf = created(await api.create("a.py", parent=nested))

    entries = {entry["id"]: entry for entry in (await api.initialize())["entries"]}

    assert "parent" not in entries[folder]
    assert entries[nested]["parent"] == folder
    assert entries[leaf]["parent"] == nested


async def test_deleting_a_folder_closes_it_to_new_entries_all_the_way_down(api: Api):
    outer = created(await api.create("outer", type="folder"))
    inner = created(await api.create("inner", type="folder", parent=outer))
    acknowledged(await api.delete(outer, await version_of(api, outer)))

    # `inner` is not itself a tombstone -- it is merely no longer reachable.
    assert (await api.create("a.py", parent=inner)).status_code == 409
    assert next(e for e in (await api.initialize())["entries"] if e["id"] == inner).get("deleted") is None


async def test_nothing_may_be_moved_into_an_unreachable_folder(api: Api):
    outer = created(await api.create("outer", type="folder"))
    inner = created(await api.create("inner", type="folder", parent=outer))
    loose = created(await api.create("a.py"))
    acknowledged(await api.delete(outer, await version_of(api, outer)))

    response = await api.reparent(loose, await version_of(api, loose), inner)
    assert response.json()["reason"] == "the destination was deleted"


async def test_ancestors_run_from_the_parent_to_the_root(api: Api, session: Session):
    workspace = UUID(api.workspace)
    outer = created(await api.create("outer", type="folder"))
    inner = created(await api.create("inner", type="folder", parent=outer))
    leaf = created(await api.create("a.py", parent=inner))

    assert list(tree.ancestors(session, workspace, leaf)) == [UUID(inner), UUID(outer)]
    assert list(tree.ancestors(session, workspace, outer)) == []
    assert tree.descends_from(session, workspace, UUID(leaf), UUID(outer))
    assert not tree.descends_from(session, workspace, UUID(outer), UUID(leaf))


async def test_an_entry_descends_from_itself(api: Api, session: Session):
    folder = created(await api.create("src", type="folder"))
    assert tree.descends_from(session, UUID(api.workspace), UUID(folder), UUID(folder))
