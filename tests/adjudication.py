"""Every typed refusal the contract names, and the two it does not."""

from conftest import Api, acknowledged, created, refused, version_of


async def test_a_create_needs_a_live_folder_to_land_in(api: Api):
    folder = created(await api.create("src", type="folder"))
    await api.delete(folder, await version_of(api, folder))

    assert refused(await api.create("main.py", parent=folder))["reason"] == "parent was deleted"


async def test_a_create_cannot_land_inside_a_file(api: Api):
    file = created(await api.create("notes.txt"))

    assert refused(await api.create("nested", parent=file))["reason"] == "parent was deleted"


async def test_siblings_cannot_share_a_name(api: Api):
    created(await api.create("main.py"))

    reason = refused(await api.create("main.py"))["reason"]
    assert reason == "entry with name already exists within destination"


async def test_a_deleted_name_is_free_again(api: Api):
    first = created(await api.create("main.py"))
    acknowledged(await api.delete(first, await version_of(api, first)))

    assert created(await api.create("main.py")) != first


async def test_renaming_onto_a_live_sibling_is_refused(api: Api):
    created(await api.create("a.py"))
    other = created(await api.create("b.py"))

    reason = refused(await api.rename(other, await version_of(api, other), "a.py"))["reason"]
    assert reason == "entry with name already exists within destination"


async def test_a_rename_against_a_stale_version_is_refused_with_the_current_one(api: Api):
    file = created(await api.create("a.py"))
    stale = await version_of(api, file)
    acknowledged(await api.rename(file, stale, "b.py"))

    refusal = refused(await api.rename(file, stale, "c.py"))
    assert refusal["reason"] == "entry was already renamed"
    assert refusal["version"] == await version_of(api, file)


async def test_a_rename_of_a_deleted_entry_is_refused(api: Api):
    file = created(await api.create("a.py"))
    acknowledged(await api.delete(file, await version_of(api, file)))

    assert refused(await api.rename(file, await version_of(api, file), "b.py"))["reason"] == "entry was deleted"


async def test_a_move_into_a_deleted_folder_is_refused(api: Api):
    folder = created(await api.create("src", type="folder"))
    file = created(await api.create("a.py"))
    acknowledged(await api.delete(folder, await version_of(api, folder)))

    reason = refused(await api.reparent(file, await version_of(api, file), folder))["reason"]
    assert reason == "the destination was deleted"


async def test_a_move_into_the_entrys_own_subtree_is_refused(api: Api):
    outer = created(await api.create("outer", type="folder"))
    inner = created(await api.create("inner", type="folder", parent=outer))
    deeper = created(await api.create("deeper", type="folder", parent=inner))

    for destination in (outer, inner, deeper):
        refusal = refused(await api.reparent(outer, await version_of(api, outer), destination))
        assert refusal["reason"] == "the destination is inside the entry"


async def test_a_move_that_would_collide_with_a_sibling_is_refused(api: Api):
    folder = created(await api.create("src", type="folder"))
    created(await api.create("a.py", parent=folder))
    loose = created(await api.create("a.py"))

    reason = refused(await api.reparent(loose, await version_of(api, loose), folder))["reason"]
    assert reason == "entry with name already exists within destination"


async def test_a_move_against_a_stale_version_is_refused(api: Api):
    folder = created(await api.create("src", type="folder"))
    file = created(await api.create("a.py"))
    stale = await version_of(api, file)
    acknowledged(await api.rename(file, stale, "b.py"))

    assert refused(await api.reparent(file, stale, folder))["reason"] == "entry had already been moved"


async def test_a_write_against_a_stale_version_names_the_version_it_lost_to(api: Api):
    file = created(await api.create("a.py"))
    stale = await version_of(api, file)
    acknowledged(await api.write(file, stale, "first"))

    refusal = refused(await api.write(file, stale, "second"))
    assert refusal["reason"] == "content was already updated"
    assert refusal["version"] == await version_of(api, file)


async def test_a_write_to_a_deleted_entry_is_refused_so_the_client_can_park_it(api: Api):
    file = created(await api.create("a.py"))
    version = await version_of(api, file)
    acknowledged(await api.delete(file, version))

    assert refused(await api.write(file, version, "work"))["reason"] == "entry was deleted"


async def test_a_write_naming_bytes_that_were_never_stored_is_refused(api: Api):
    file = created(await api.create("blob.bin"))

    refusal = refused(
        await api.write_blob(
            file, await version_of(api, file), hash="0" * 64, size=3, mime="application/x-thing"
        )
    )
    assert refusal["reason"] == "content bytes were never stored"


async def test_deleting_what_is_already_deleted_is_acknowledged(api: Api):
    file = created(await api.create("a.py"))
    acknowledged(await api.delete(file, await version_of(api, file)))

    # A second delete achieved what its caller asked for, so there is nothing
    # to refuse -- and the contract has no reason string that would be honest.
    acknowledged(await api.delete(file, await version_of(api, file)))


async def test_a_stale_delete_names_what_it_would_have_destroyed_unseen(api: Api):
    file = created(await api.create("a.py"))
    stale = await version_of(api, file)
    acknowledged(await api.write(file, stale, "unsaved work"))

    assert refused(await api.delete(file, stale))["reason"] == (
        "later versions modified the content of the entry"
    )


async def test_a_stale_delete_reports_a_rename_too(api: Api):
    file = created(await api.create("a.py"))
    stale = await version_of(api, file)
    acknowledged(await api.rename(file, stale, "b.py"))
    acknowledged(await api.write(file, await version_of(api, file), "work"))

    assert refused(await api.delete(file, stale))["reason"] == (
        "later versions modified the content and name of the entry"
    )


async def test_an_unknown_entry_is_refused_rather_than_crashing(api: Api):
    unknown = "00000000-0000-4000-8000-000000000000"
    assert refused(await api.delete(unknown, unknown))["reason"] == "entry was deleted"
