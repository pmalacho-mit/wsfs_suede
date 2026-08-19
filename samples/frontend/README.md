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

`Tree.svelte` mirrors paths in both directions -- a gesture becomes a
transaction, and the tree's shape is then whatever the effective view says, so
a refused rename snaps back without anybody undoing it.

`Editor.svelte` opens the file's document. While it is open, that document is
the truth: the workspace flushes it on a debounce, and anything reading the
file meanwhile is answered by the document rather than by the last write.

`workspace.svelte.ts` hands the kernel the same filesystem the editor writes
through, which is why `import sibling` finds what is on screen rather than what
was last saved.
