The sample frontend.

A workspace filesystem in a browser: the tree down the left, open files as tabs
in the middle, and a terminal under any `.py` file. Layout is dockview, the
tree is `@pierre/trees`, the editor is monaco, and the terminal runs pyodide.

It reads the client out of `release/frontend` directly rather than out of a
published package, so a change there shows up here without a build step.

    # a database and the sample backend
    docker compose -f ../../tests/compose.yml up -d test-db
    DB_HOST=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' wsfs-tests-test-db-1):5432 \
      PYTHONPATH="../..:../backend" \
      python3 -c "import uvicorn; from app import create_sample_app; uvicorn.run(create_sample_app(), port=8099)"

    # and the page
    npm run dev

Vite proxies `/wsfs` and `/projects` to the backend, so the browser talks to
one origin and nothing here needs CORS.

Three seams are worth reading, because they are the whole point:

`FileTree.svelte` mirrors paths in both directions -- a gesture becomes a
transaction, and the tree's shape is then whatever the effective view says, so
a refused rename snaps back without anybody undoing it.

`Editor.svelte` opens the file's document. While it is open, that document is
the truth: the workspace flushes it on a debounce, and anything reading the
file meanwhile is answered by the document rather than by the last write.

`workspace.svelte.ts` hands the kernel the same filesystem the editor writes
through, which is why `import sibling` finds what is on screen rather than what
was last saved.

## Browser tests

`tests/frontend/*.test.ts` covers the client's logic with no DOM. The rest --
that the tree, the context menu and the editor really drive a workspace --
needs a browser, and lives beside the components as `*.test.svelte`, run by
[sweater-vest-suede](../../sweater-vest-suede/README.md).

```sh
docker compose -f ../compose.yml up -d --build   # the sample host, on :8099
npm run dev                                      # this app, on :5173
npm run report -- --server http://<devcontainer-ip>:5173 --closet /tests
```

Assertions land on a SECOND client in the same workspace rather than on the
one under test: a client showing its own optimistic work proves nothing about
what was stored, and a second one only ever sees what the backend streamed
back.

Two things about the environment, both worth knowing before the failures make
no sense:

**The stack is on no network of its own.** The report driver finds the
devcontainer's network by elimination, so a compose-created bridge makes that
ambiguous and it refuses to start. `../compose.yml` publishes the database on
the default bridge and puts the backend in the host's namespace instead.

**The browser reaches this page by IP, which is an insecure origin**, and
browsers withhold `crypto.subtle` from those. The byte store the client hashes
with is injectable, so the tests pass one that does not need it -- see
`counted()` in `src/lib/testing.ts`. Blob content would still need the real
thing, because the server verifies bytes against their sha256; every browser
test here is text. Serving the page on `localhost` inside the container would
remove the workaround: the forwarding that does it exists in
`browser-control-container-suede`, but the report driver does not pass it
through yet.
