<script lang="ts">
  import { Sweater } from "sweater-vest-suede";

  import FileTree from "$lib/FileTree.svelte";
  import { Open } from "$lib/workspace.svelte";
  import { alongside, drawn, opened, rowFor, until } from "$lib/testing";

  class Pocket {
    root = $state<HTMLElement>();
    workspace = $state<Open>();
    opened = $state<string[]>([]);
  }

  /** Wait for a client to hold `path`, whoever's client it is. */
  const holds = (client: Open, path: string) => () => client.paths.includes(path);

  const menuOn = async (row: HTMLElement) => {
    const { top, left } = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: left + 4,
        clientY: top + 4,
      }),
    );
    await new Promise(requestAnimationFrame);
  };

  const action = (label: string): HTMLButtonElement => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`no "${label}" in the menu`);
    return button;
  };
</script>

<Sweater config category="File tree" orientation="vertical" mode="serial" />

<Sweater
  name="runs on a trustworthy origin"
  body={async (harness) => {
    harness.set(new Pocket());
    // Stated once, so the failure has a name. The client hashes queued
    // payloads with `crypto.subtle`, which browsers withhold from insecure
    // origins -- reached at the devcontainer's ADDRESS, every test below
    // fails on a missing namespace instead. `--forward 5173` is what puts
    // this page on the browser's own localhost, where it is trusted.
    harness.expect(window.isSecureContext).toBe(true);
    harness.expect(typeof crypto.subtle?.digest).toBe("function");
  }}
>
  {#snippet vest(_p: Pocket)}
    <p class="note">Origin: {typeof window === "undefined" ? "?" : window.origin}</p>
  {/snippet}
</Sweater>

<Sweater
  name="draws what the workspace holds"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    pocket.workspace = workspace;
    harness.onAbort(() => workspace.dispose());

    await workspace.workspace.create("notes.md", "hello");
    await workspace.workspace.folder("src");

    const { root } = await harness.definition("root");
    await until(
      "both entries drawn",
      () => !!rowFor(root, "notes.md") && !!rowFor(root, "src"),
      () => drawn(root).join(" | "),
    );

    harness.expect(rowFor(root, "notes.md")).toBeTruthy();
    // The regression the trailing separator fixes: an EMPTY folder has no
    // children to give it away, so only its type can say it is one.
    harness.expect(rowFor(root, "src")).toBeTruthy();
    void harness.capture("png");
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.workspace}
        <FileTree workspace={p.workspace} onopen={(path) => (p.opened = [...p.opened, path])} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the menu adds a file, and the server keeps it"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    pocket.workspace = workspace;
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("anchor.md", "");
    const { root } = await harness.definition("root");
    await until("the anchor is drawn", () => !!rowFor(root, "anchor.md"), () =>
      drawn(root).join(" | "),
    );

    await menuOn(rowFor(root, "anchor.md")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action("New file"));
      await userEvent.keyboard("greeting.py{Enter}");
    });

    // The other client is the one that matters: it only ever sees what the
    // backend actually stored and streamed back.
    await until("the other client sees it", holds(other, "greeting.py"), () =>
      other.paths.join(" | "),
    );
    harness.expect(other.paths).toContain("greeting.py");
    void harness.capture("png");
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.workspace}
        <FileTree workspace={p.workspace} onopen={() => {}} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the menu renames a file, and the rename is a move"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    pocket.workspace = workspace;
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("before.md", "x");
    const { root } = await harness.definition("root");
    await until("the file is drawn", () => !!rowFor(root, "before.md"), () =>
      drawn(root).join(" | "),
    );
    await until("the other client has it", holds(other, "before.md"), () =>
      other.paths.join(" | "),
    );

    await menuOn(rowFor(root, "before.md")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action("Rename"));
      await userEvent.keyboard("{Control>}a{/Control}after.md{Enter}");
    });

    await until("the rename reached the server", holds(other, "after.md"), () =>
      other.paths.join(" | "),
    );
    harness.expect(other.paths).not.toContain("before.md");
    void harness.capture("png");
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.workspace}
        <FileTree workspace={p.workspace} onopen={() => {}} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the menu deletes a file everywhere"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    pocket.workspace = workspace;
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("doomed.md", "x");
    const { root } = await harness.definition("root");
    await until("the file is drawn", () => !!rowFor(root, "doomed.md"), () =>
      drawn(root).join(" | "),
    );
    await until("the other client has it", holds(other, "doomed.md"), () =>
      other.paths.join(" | "),
    );

    await menuOn(rowFor(root, "doomed.md")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action("Delete"));
    });

    await until(
      "the delete reached the server",
      () => !other.paths.includes("doomed.md"),
      () => other.paths.join(" | "),
    );
    harness.expect(other.paths).not.toContain("doomed.md");
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.workspace}
        <FileTree workspace={p.workspace} onopen={() => {}} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<style>
  .note {
    margin: 0;
    padding: 0.5rem;
    font: 12px ui-monospace, monospace;
  }

  .panel {
    height: 320px;
    overflow: auto;
    border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    border-radius: 6px;
  }
</style>
