"""Opening a workspace, and who is allowed to say so."""

import httpx

from conftest import Api, acknowledged, created, open_workspace, version_of


async def test_a_workspace_starts_empty_and_is_addressable_by_its_id(instance: httpx.AsyncClient):
    workspace = await open_workspace(instance)
    api = Api(instance, workspace, user="ada@example.com")

    assert (await api.initialize())["entries"] == []


async def test_workspaces_do_not_see_each_other(instance: httpx.AsyncClient, api: Api):
    created(await api.create("mine.py"))
    neighbour = Api(instance, await open_workspace(instance), user="ada@example.com")

    assert (await neighbour.initialize())["entries"] == []


async def test_a_request_must_say_who_is_making_it(instance: httpx.AsyncClient, workspace: str):
    response = await instance.post(f"/workspaces/{workspace}/initialize", json={"outbox": []})

    assert response.status_code == 422


async def test_a_tree_is_built_from_creates_and_read_back_whole(api: Api):
    folder = created(await api.create("src", type="folder"))
    file = created(await api.create("main.py", parent=folder))

    tree = {entry["name"]: entry for entry in (await api.initialize())["entries"]}

    assert tree["src"]["type"] == "folder"
    assert tree["main.py"] == {
        "id": file,
        "version": tree["main.py"]["version"],
        "type": "file",
        "name": "main.py",
        "parent": folder,
    }


async def test_a_write_is_readable_at_the_version_it_produced(api: Api):
    file = created(await api.create("main.py"))
    acknowledged(await api.write(file, await version_of(api, file), "print('hi')"))

    assert (await api.content(file)).json() == {
        "type": "text",
        "content": "print('hi')",
        "version": await version_of(api, file),
    }


async def test_two_users_share_one_workspace(api: Api, other: Api):
    file = created(await api.create("shared.py"))
    acknowledged(await other.write(file, await version_of(other, file), "theirs"))

    assert (await api.content(file)).json()["content"] == "theirs"
