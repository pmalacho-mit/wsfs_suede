<script lang="ts">
  /**
   * The whole browser suite, in ONE component, on purpose.
   *
   * The report driver opens a tab per test component and runs them all at
   * once, and only one tab is ever focused; a `config` Sweater's `serial` is
   * one container's queue, and two containers run alongside each other. Both
   * roads lead to two tests typing at the same moment, and a rename input
   * that loses focus mid-word fails somewhere else entirely. So: one file,
   * one category, and every test in it named after its own subject.
   *
   * The one other rule of sharing a page: no two tests may name the same
   * file. The editor registers a workspace's paths in a filesystem that is
   * global to the page, and a repeated name collides there rather than in
   * the backend, where the workspaces are genuinely separate.
   */
  import { Sweater } from "sweater-vest-suede";

  import FileTree, { Model as FileTreeModel } from "$lib/FileTree.svelte";
  import Shell from "$lib/Workspace.svelte";
  import type { Client } from "$lib/testing.svelte";
  import { drivable, solo } from "$lib/liveblocks";
  import {
    alongside,
    clickRow,
    closeTab,
    drawn,
    everythingIn,
    focused,
    menuOnEmptySpace,
    opened,
    quiet,
    region,
    regions,
    renaming,
    rowFor,
    selected,
    tabs,
    until,
  } from "$lib/testing.svelte";

  /**
   * A room with nobody else in it, and a connection the test can answer for.
   *
   * WHAT THIS CANNOT DO, and it is worth knowing before trusting it: `solo`
   * answers as a genuinely EMPTY room. That was right while the client filled
   * a room from the file; the host fills it now, on the real collaboration
   * server, which this knows nothing about. So the shared document here is
   * always empty, and the two tests that turn on the shared document holding
   * the file cannot pass against it.
   *
   * Swapping `solo()` for `clientAs(ADA)` makes them pass -- verified, one of
   * them in three seconds on its own -- but eighteen tests each opening a
   * real room is minutes rather than seconds, so it is not the default. See
   * AUDIT.md.
   *
   * The CONNECTION is drivable either way: whether this client's work is
   * reaching anybody is a question about a network, and no room, real or
   * fake, answers it on demand.
   */
  const collaboration = solo();
  const room = drivable(collaboration);

  /**
   * Type the way a person does, which is the only kind of edit that counts.
   *
   * `model.applyEdits` is what a PROGRAM does: it carries no provenance, and
   * with no focus either there is nothing to attribute it to. `UserEdits`
   * ignores it deliberately -- a peer's edit arriving through the binding
   * looks exactly the same, and treating those as this person's work would
   * have every member of a room storing every other member's typing.
   *
   * So the test has to be a person: focus the editor, put the caret where the
   * text goes, and let the editor route it.
   */
  const typeInto = (editor: any, text: string) => {
    const model = editor.getModel()!;
    const line = model.getLineCount();
    editor.focus();
    editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
    editor.trigger("keyboard", "type", { text });
  };

  /**
   * Wait for a file's room to be open before asserting anything about
   * sharing.
   *
   * Opening one is not free the first time: the host has to create the room
   * with the collaboration server, ask what it holds, and fill it, which is
   * three round trips and takes a second or two. Typing before that is
   * typing into a document nothing is carrying yet.
   */
  const shared = async (take: any, path: string) =>
    await until(
      `${path} to be shared`,
      () => take().entries.find((one: any) => one.path === path)?.stage === "open",
      () => JSON.stringify(take().entries.find((one: any) => one.path === path)),
      45_000,
    );

  class Pocket {
    root = $state<HTMLElement>();
    workspace = $state<Client>();
    /** The tree's model, which is what a `FileTree` is given. */
    tree = $state<FileTreeModel>();
    /** The monaco editor, once one has mounted, for tests that type. */
    editor = $state<any>();
    /** The snapshot taker, once the shell has one. */
    take = $state<any>();
    opened = $state<string[]>([]);
  }

  /** Puts a workspace on the screen, with the model the tree renders from. */
  const showing = (pocket: Pocket, workspace: Client) => {
    pocket.tree = new FileTreeModel(workspace.workspace);
    pocket.workspace = workspace;
  };

  /** Wait for a client to hold `path`, whoever's client it is. */
  const holds = (client: Client, path: string) => () => client.paths.includes(path);

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

  const WANTED = ["explorer", "documents", "assistant"] as const;

  const laidOut = (root: HTMLElement) => () =>
    WANTED.every((name) => !!region(root, name));

  /**
   * A report card gives each test a slice of one screen, and nine tests make
   * that slice shorter than the shell it is showing. The capture is taken of
   * a clone, so telling the clone how tall it is renders the whole thing.
   */
  const tall = { height: 500, style: { height: "500px" } };

  /** Where a region sits, so an assertion can talk about left and right. */
  const box = (root: HTMLElement, name: string) =>
    region(root, name)!.getBoundingClientRect();

  /** The text of a held file, or nothing at all -- binaries have none. */
  const texted = (held: { kind: string; text?: string } | undefined) =>
    held?.kind === "text" ? (held.text ?? "") : "";

  const action = (label: string): HTMLButtonElement => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`no "${label}" in the menu`);
    return button;
  };
</script>

<Sweater config category="Sample app" orientation="vertical" mode="serial" />

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
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    await workspace.workspace.create("notes.md", "hello").settled;
    await workspace.workspace.folder("src").settled;

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
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
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
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("anchor.md", "").settled;
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
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
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
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("before.md", "x").settled;
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
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
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
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("doomed.md", "x").settled;
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
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the empty space below the entries adds a file at the root"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    // One entry, so there is plenty of empty tree below it to click on.
    await workspace.workspace.create("ledger.md", "").settled;
    const { root } = await harness.definition("root");
    await until("the first entry is drawn", () => !!rowFor(root, "ledger.md"), () =>
      drawn(root).join(" | "),
    );

    await menuOnEmptySpace(region(root, "tree")!);
    // Captured with the menu open: the two actions an entry cannot offer.
    void harness.capture("png", tall);
    harness.expect(action("Add file")).toBeTruthy();
    harness.expect(action("Add folder")).toBeTruthy();

    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action("Add file"));
      await userEvent.keyboard("root-note.md{Enter}");
    });

    await until("the other client sees it", holds(other, "root-note.md"), () =>
      other.paths.join(" | "),
    );
    // At the ROOT, not beside or inside anything.
    harness.expect(other.paths).toContain("root-note.md");
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the same menu adds a folder at the root"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("beacon.md", "").settled;
    const { root } = await harness.definition("root");
    await until("the first entry is drawn", () => !!rowFor(root, "beacon.md"), () =>
      drawn(root).join(" | "),
    );

    await menuOnEmptySpace(region(root, "tree")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action("Add folder"));
      await userEvent.keyboard("library{Enter}");
    });

    await until("the other client sees it", holds(other, "library"), () =>
      other.paths.join(" | "),
    );
    // And as a FOLDER: an empty one has no children to give it away, so only
    // the entry's own type can say which it is.
    harness.expect(other.workspace.index().at("library")?.type).toBe("folder");
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the shell lays the workspace out as three regions, left to right"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    await workspace.workspace.create("main.py", "print('hi')").settled;
    await workspace.workspace.folder("shelf").settled;

    const { root } = await harness.definition("root");
    await until("the three regions", laidOut(root), () => regions(root).join(" | "));
    await until("the tree drew the workspace", () => !!rowFor(root, "main.py"), () =>
      drawn(root).join(" | "),
    );

    const explorer = box(root, "explorer");
    const documents = box(root, "documents");
    const assistant = box(root, "assistant");

    // A pixel of slack: the grid draws a sash between the regions.
    harness.expect(explorer.right).toBeLessThanOrEqual(documents.left + 1);
    harness.expect(documents.right).toBeLessThanOrEqual(assistant.left + 1);

    // The tree reaches the bottom edge of the explorer, which is what makes
    // the space under the last entry a place worth right-clicking.
    const tree = box(root, "tree");
    harness.expect(Math.abs(tree.bottom - explorer.bottom)).toBeLessThan(2);

    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={collaboration}
          entering={room.entering}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the shell docks a selected file in the middle region"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    await workspace.workspace.create("essay.md", "hello").settled;

    const { root } = await harness.definition("root");
    await until("the three regions", laidOut(root), () => regions(root).join(" | "));
    await until("the file is drawn", () => !!rowFor(root, "essay.md"), () =>
      drawn(root).join(" | "),
    );

    await clickRow(rowFor(root, "essay.md")!);

    const named = () => tabs(root).find((tab) => tab.textContent?.includes("essay.md"));
    await until("a tab for the file", () => !!named(), () =>
      tabs(root).map((tab) => tab.textContent).join(" | "),
    );

    // In the MIDDLE region: the tree hands the path to the dock, and the dock
    // is the only region that takes panels.
    const documents = box(root, "documents");
    const tab = named()!.getBoundingClientRect();
    harness.expect(tab.left).toBeGreaterThanOrEqual(documents.left - 1);
    harness.expect(tab.right).toBeLessThanOrEqual(documents.right + 1);

    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={collaboration}
          entering={room.entering}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the shell creates a file the way a person does, and says nothing in the console"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    const console = quiet();
    harness.onAbort(console.stop);

    const { root } = await harness.definition("root");
    await until("the three regions", laidOut(root), () => regions(root).join(" | "));

    // Right-click the empty explorer -> Add file.
    await menuOnEmptySpace(region(root, "tree")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action("Add file"));
    });

    // The row is there, being named, and the box is EMPTY -- the user types a
    // name rather than correcting one nobody chose. Promptly, too: a
    // placeholder that shows for a moment is a placeholder that was seen.
    await until(
      "an empty rename box",
      () => renaming(root)?.value === "",
      () => `value ${JSON.stringify(renaming(root)?.value)}`,
      1000,
    );
    void harness.capture("png", tall);

    // Nothing has been created yet: a draft is the tree's alone, and the
    // workspace has not been asked for anything.
    harness.expect(workspace.paths).toEqual([]);

    await harness.withUserFocus(async (userEvent) => {
      await userEvent.keyboard("sketch.py{Enter}");
    });

    await until("the file exists", () => workspace.paths.includes("sketch.py"), () =>
      workspace.paths.join(" | "),
    );

    // And it opened, in the middle region, with its empty content: a real
    // editor, not a panel still explaining itself.
    await until(
      "a tab for the file",
      () => tabs(root).some((tab) => tab.textContent?.includes("sketch.py")),
      () => tabs(root).map((tab) => tab.textContent).join(" | "),
    );
    await until(
      "the editor mounted",
      () =>
        everythingIn(region(root, "documents")!).some((element) =>
          element.classList.contains("monaco-editor"),
        ),
      () => region(root, "documents")!.textContent?.trim() ?? "",
    );

    const middle = region(root, "documents")!.textContent ?? "";
    harness.expect(middle).not.toContain("No such file");
    harness.expect(middle).not.toContain("Opening sketch.py");
    harness.expect(middle).not.toContain("Loading sketch.py");

    void harness.capture("png", tall);
    harness.expect(console.ours().join(" | ")).toBe("");
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={collaboration}
          entering={room.entering}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a blank name creates nothing, and says why"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    const console = quiet();
    harness.onAbort(console.stop);

    await workspace.workspace.create("kept.md", "").settled;
    const { root } = await harness.definition("root");
    await until("the first entry is drawn", () => !!rowFor(root, "kept.md"), () =>
      drawn(root).join(" | "),
    );

    await menuOnEmptySpace(region(root, "tree")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action("Add file"));
      await userEvent.keyboard("{Enter}");
    });

    await until("the draft is gone", () => renaming(root) === undefined, () => "still naming");
    harness.expect(drawn(root)).toEqual(["kept.md"]);
    harness.expect(other.paths).toEqual(["kept.md"]);
    harness.expect(console.complaints().join(" ")).toContain("Name cannot be empty");
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={collaboration}
          entering={room.entering}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a name a sibling already has creates nothing, and says why"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    const console = quiet();
    harness.onAbort(console.stop);

    await workspace.workspace.create("taken.md", "first").settled;
    const { root } = await harness.definition("root");
    await until("the first entry is drawn", () => !!rowFor(root, "taken.md"), () =>
      drawn(root).join(" | "),
    );
    await until("the other client has it", holds(other, "taken.md"), () =>
      other.paths.join(" | "),
    );

    await menuOnEmptySpace(region(root, "tree")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action("Add file"));
      await userEvent.keyboard("taken.md{Enter}");
    });

    await until("the draft is gone", () => renaming(root) === undefined, () => "still naming");
    // One entry, still, and the one that was already there keeps its content.
    harness.expect(drawn(root)).toEqual(["taken.md"]);
    harness.expect(other.paths).toEqual(["taken.md"]);
    harness.expect(console.complaints().join(" ")).toContain("already exists");
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={collaboration}
          entering={room.entering}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="an open buffer is what a reader gets, and what reaches the server"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("draft.md", "before").settled;
    const { root } = await harness.definition("root");
    await until("the three regions", laidOut(root), () => regions(root).join(" | "));
    await until("the file is drawn", () => !!rowFor(root, "draft.md"), () =>
      drawn(root).join(" | "),
    );

    await clickRow(rowFor(root, "draft.md")!);
    await until(
      "the editor mounted",
      () =>
        everythingIn(region(root, "documents")!).some((element) =>
          element.classList.contains("monaco-editor"),
        ),
      () => region(root, "documents")!.textContent?.trim() ?? "",
    );

    // Typed into the editor itself, through its own model -- which is what
    // the shared text is bound to, so this takes the whole path a keystroke
    // does. Monaco's own textarea cannot be driven from here: it lives in a
    // shadow root, so `document.activeElement` is the host and user-event
    // types at that instead.
    await until("the editor handed itself over", () => pocket.editor !== undefined);
    // Focused, because typing is what stores a version and focus is how a
    // person is told apart from an update arriving from the room.
    pocket.editor!.focus();
    // Opened on what the file holds, rather than on nothing -- an editor
    // that opens empty writes empty straight back over the file.
    await until(
      "the editor opened on the file",
      () => pocket.editor!.getModel()?.getValue() === "before",
      () => JSON.stringify(pocket.editor!.getModel()?.getValue()),
    );
    typeInto(pocket.editor!, " after");

    // Nothing writes the shared text back to the workspace except the file
    // itself, on a debounce -- so this is the assertion that the editor is
    // not a place work goes to be lost.
    // The whole text, not just the new part: anything less would pass while
    // the file was being replaced by what the editor happened to be showing.
    await until(
      "the other client has the typing",
      () => texted(other.workspace.holding("draft.md")) === "before after",
      () => JSON.stringify(other.workspace.holding("draft.md")),
      15_000,
    );
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={collaboration}
          entering={room.entering}
          onEditor={(editor) => ((p.editor = editor), { dispose: () => {} })}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="somebody else renaming a folder carries its contents, and costs the tree nothing"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("keep.md", "").settled;
    await workspace.workspace.folder("box").settled;
    await workspace.workspace.create("box/inner.md", "").settled;

    const { root } = await harness.definition("root");
    await until(
      "the workspace is drawn",
      () => !!rowFor(root, "keep.md") && !!rowFor(root, "box"),
      () => drawn(root).join(" | "),
    );
    await until("the other client has it", holds(other, "box/inner.md"), () =>
      other.paths.join(" | "),
    );

    // Two things for the tree to lose: an expanded folder, and a focused row.
    await clickRow(rowFor(root, "box")!);
    await until("the folder is open", () => !!rowFor(root, "box/inner.md"), () =>
      drawn(root).join(" | "),
    );
    await clickRow(rowFor(root, "keep.md")!);
    await until("a focused row", () => focused(root) === "keep.md", () =>
      String(focused(root)),
    );

    // Somebody else moves the folder. ONE change reaches this client -- the
    // folder's own name -- and the entry under it is carried by the tree,
    // because the tree is holding ids rather than re-deriving paths.
    await other.workspace.move("box", "crate").settled;

    await until("the folder followed", () => !!rowFor(root, "crate"), () =>
      drawn(root).join(" | "),
    );
    // Still DRAWN, which means the folder is still open: a reset would have
    // closed it, and closing it is how the old tree lost the user's place.
    await until("what was inside it followed too", () => !!rowFor(root, "crate/inner.md"), () =>
      drawn(root).join(" | "),
    );
    harness.expect(rowFor(root, "box")).toBeUndefined();
    harness.expect(focused(root)).toBe("keep.md");
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="what the tree announces is already true of the workspace"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    await workspace.workspace.create("told.md", "x").settled;
    const { root, tree } = await harness.definition("root", "tree");
    await until("the file is drawn", () => !!rowFor(root, "told.md"), () =>
      drawn(root).join(" | "),
    );

    // What the workspace said about the announced path, AT the moment it was
    // announced. A gesture has to square the tree's own bookkeeping before
    // the workspace is told, so without holding the news back these would
    // both be the other way round.
    const asked: string[] = [];
    const known = (path: string) =>
      workspace.workspace.index().at(path) === undefined ? "unknown" : "known";
    harness.onAbort(
      tree.subscribe({
        renamed: ({ path }) => asked.push(`renamed ${known(path)}`),
        removed: ({ path }) => asked.push(`removed ${known(path)}`),
      }),
    );

    await menuOn(rowFor(root, "told.md")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action("Rename"));
      await userEvent.keyboard("{Control>}a{/Control}heard.md{Enter}");
    });
    await until("the rename was announced", () => asked.length > 0, () =>
      asked.join(" | "),
    );

    await menuOn(rowFor(root, "heard.md")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action("Delete"));
    });
    await until("the delete was announced", () => asked.length > 1, () =>
      asked.join(" | "),
    );

    // Told where it IS, and told it is gone -- both already true, so a
    // listener that reads at the path it was handed gets an answer.
    harness.expect(asked).toEqual(["renamed known", "removed unknown"]);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the tree shows which panel is in front, and lets go when it closes"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    await workspace.workspace.create("front.md", "one").settled;
    await workspace.workspace.create("behind.md", "two").settled;

    const { root } = await harness.definition("root");
    await until("both drawn", () => !!rowFor(root, "front.md") && !!rowFor(root, "behind.md"), () =>
      drawn(root).join(" | "),
    );

    // Opening one highlights its row.
    await clickRow(rowFor(root, "front.md")!);
    await until("the row is highlighted", () => selected(root) === "front.md", () =>
      String(selected(root)),
    );

    // Opening another moves the highlight, because the front moved.
    await clickRow(rowFor(root, "behind.md")!);
    await until("the highlight followed", () => selected(root) === "behind.md", () =>
      String(selected(root)),
    );
    await until(
      "both files are open",
      () => tabs(root).length === 2,
      () => tabs(root).map((tab) => tab.textContent).join(" | "),
    );

    // Closing the one in front lets its row go, and hands the highlight to
    // whatever came forward -- not to nothing.
    closeTab(tabs(root).find((tab) => tab.textContent?.includes("behind.md"))!);
    await until("the front went back", () => selected(root) === "front.md", () =>
      `${selected(root)} of ${tabs(root).length}`,
    );

    // And the last one closing leaves nothing highlighted, so the row can be
    // clicked to open it again.
    closeTab(tabs(root).find((tab) => tab.textContent?.includes("front.md"))!);
    await until("nothing is highlighted", () => selected(root) === undefined, () =>
      String(selected(root)),
    );

    await clickRow(rowFor(root, "front.md")!);
    await until(
      "clicking it opens it again",
      () => tabs(root).some((tab) => tab.textContent?.includes("front.md")),
      () => tabs(root).map((tab) => tab.textContent).join(" | "),
    );
    harness.expect(selected(root)).toBe("front.md");
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={collaboration}
          entering={room.entering}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the assistant is offered what the user can actually see"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    await workspace.workspace.create("seen.md", "one").settled;
    await workspace.workspace.create("hidden.md", "two").settled;

    const { root } = await harness.definition("root");
    await until("the three regions", laidOut(root), () => regions(root).join(" | "));
    await until("both drawn", () => !!rowFor(root, "seen.md") && !!rowFor(root, "hidden.md"), () =>
      drawn(root).join(" | "),
    );

    const offered = () =>
      [...region(root, "assistant")!.querySelectorAll("[data-path]")]
        .map((item) => item.getAttribute("data-path"))
        .sort();

    harness.expect(offered()).toEqual([]);

    await clickRow(rowFor(root, "seen.md")!);
    await until("the open file is offered", () => offered().join() === "seen.md", () =>
      offered().join(" | "),
    );

    // Opened on top of it, in the same group. One panel per group is on
    // screen, so the first is now open and NOT visible -- which is the
    // distinction the assistant needs and "which file is open" cannot make.
    await clickRow(rowFor(root, "hidden.md")!);
    await until("the one in front replaces it", () => offered().join() === "hidden.md", () =>
      offered().join(" | "),
    );

    // And it keeps up as the layout moves, rather than being worked out when
    // somebody finally asks.
    closeTab(tabs(root).find((tab) => tab.textContent?.includes("hidden.md"))!);
    await until("the one behind comes back", () => offered().join() === "seen.md", () =>
      offered().join(" | "),
    );
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={collaboration}
          entering={room.entering}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a snapshot resolves what the user has not stored, in one pass"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("draft.py", "start").settled;
    const { root, take } = await harness.definition("root", "take");
    await until("the file is drawn", () => !!rowFor(root, "draft.py"), () =>
      drawn(root).join(" | "),
    );

    await clickRow(rowFor(root, "draft.py")!);
    await until("the editor handed itself over", () => pocket.editor !== undefined);
    pocket.editor!.focus();
    await until(
      "the editor opened on the file",
      () => pocket.editor!.getModel()?.getValue() === "start",
      () => JSON.stringify(pocket.editor!.getModel()?.getValue()),
    );

    // Every token, not just the content one: this is what makes a snapshot
    // enough to rebuild the filesystem as it stood.
    const before = take().entries.find((held: any) => held.path === "draft.py");
    harness.expect(Object.keys(before.versions).sort()).toEqual([
      "content",
      "deleted",
      "name",
      "parent",
    ]);
    harness.expect(before.dirty).toBe(false);
    harness.expect(before.stored).toBeUndefined();

    await shared(pocket.take, "draft.py");
    typeInto(pocket.editor!, " more");

    await until(
      "it went dirty",
      () => take().entries.some((held: any) => held.dirty),
      () =>
        JSON.stringify(
          take().entries.find((one: any) => one.path === "draft.py"),
        ),
    );

    // One pass: it comes back already resolved, naming the transaction that
    // carries what the user was looking at -- whose content version does not
    // exist yet, which is exactly why the transaction has to be named.
    const resolved = take({ resolveDirty: true }).entries.find(
      (held: any) => held.path === "draft.py",
    );
    if (resolved.dirty) throw new Error(`still dirty -- ${JSON.stringify(resolved)}`);
    harness.expect(typeof resolved.stored).toBe("string");
    harness.expect(resolved.versions.content).not.toBe(resolved.stored);

    // And it was a real submission, not a promise to make one.
    await until(
      "the other client has what was snapshotted",
      () => texted(other.workspace.holding("draft.py")) === "start more",
      () =>
        JSON.stringify({
          other: other.workspace.holding("draft.py"),
          resolved,
          here: take().entries.find((one: any) => one.path === "draft.py"),
        }),
      15_000,
    );
    harness.expect(take().entries.some((held: any) => held.dirty)).toBe(false);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={collaboration}
          entering={room.entering}
          onEditor={(editor) => ((p.editor = editor), { dispose: () => {} })}
          onSnapshot={(take) => (p.take = take)}
        />
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

  /* The shell fills what it is given; a report card is not a viewport. */
  .stage {
    height: 460px;
    border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    border-radius: 6px;
    overflow: hidden;
  }

  .panel {
    height: 320px;
    overflow: auto;
    border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    border-radius: 6px;
  }
</style>
