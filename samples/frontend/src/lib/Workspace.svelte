<script lang="ts" module>
  import { createClient } from "@liveblocks/client";
  import { LiveblocksYjsProvider } from "@liveblocks/yjs";
  import * as Y from "yjs";
  import { Editor } from "wsfs_suede.python-monaco-suede";
  import { nameOf, holderOf } from "$lib/paths";
  import { filesystem, provider, type Workspace } from "$wsfs";

  type LiveblocksClient = ReturnType<typeof createClient>;
  type LiveblocksRoom = ReturnType<LiveblocksClient["enterRoom"]>;

  export type NonModelEditorProps = Omit<Editor.Props, "file">;

  /** How long a burst of typing settles before it becomes one version. */
  const SETTLES_IN = 400;

  /**
   * Stores a version when the person at this editor stops typing.
   *
   * Watching the shared doc instead would make every client in the room write
   * every other client's keystrokes back to the workspace -- the same content,
   * once per person, each one a new version. And it would put the write
   * somewhere that cannot tell a person from an update arriving.
   *
   * So it hangs off the editor, which is where one person's actions are.
   */
  const versionsAsTyped = (
    editor: Parameters<NonNullable<Editor.Props["onEditor"]>>[0],
    file: OpenFile,
  ) => {
    let settling: ReturnType<typeof setTimeout> | undefined;
    const typed = editor.onDidChangeModelContent(() => {
      clearTimeout(settling);
      settling = setTimeout(() => {
        settling = undefined;
        file.store();
      }, SETTLES_IN);
    });
    return {
      dispose: () => {
        typed.dispose();
        // Closing is the last chance to keep what was typed into it.
        if (settling === undefined) return;
        clearTimeout(settling);
        file.store();
      },
    };
  };

  /**
   * The one span in which `from` and `to` differ.
   *
   * Everything before it and after it is already shared, so only the middle
   * has to be said. This is what keeps `put` from deleting the file and
   * writing it again: that would say the same thing and MEAN something else --
   * every collaborator's cursor thrown to the top, an edit landing in the same
   * moment discarded rather than merged, and a change the size of the file
   * sent for a one-line difference.
   *
   * @returns where to start, how much to remove, and what to put there
   */
  const difference = (
    from: string,
    to: string,
  ): [at: number, remove: number, insert: string] => {
    const shortest = Math.min(from.length, to.length);

    let start = 0;
    while (start < shortest && from[start] === to[start]) start += 1;

    // Bounded by what the prefix left, so the two never claim the same run.
    let end = 0;
    while (
      end < shortest - start &&
      from[from.length - 1 - end] === to[to.length - 1 - end]
    )
      end += 1;

    return [start, from.length - start - end, to.slice(start, to.length - end)];
  };

  export class OpenFile {
    readonly id: Id;
    readonly liveblocks: LiveblocksClient;
    readonly editorProps: NonModelEditorProps;
    readonly workspace: Workspace;

    sharedText = $state<SharedTextFile>();
    path = $state("");

    constructor(
      { id, path }: FileTreeModel.Entry,
      liveblocks: LiveblocksClient,
      editorProps: NonModelEditorProps,
      workspace: Workspace,
    ) {
      this.id = id;
      this.path = path;
      this.liveblocks = liveblocks;
      this.editorProps = editorProps;
      this.workspace = workspace;
    }

    move(path: string) {
      this.path = path;
      this.sharedText?.path(path);
    }

    dispose() {
      this.sharedText?.dispose();
    }

    share() {
      const { id, path, liveblocks, editorProps } = this;
      this.sharedText ??= new SharedTextFile(id, path, liveblocks, {
        ...editorProps,
        onEditor: (editor) => {
          const typing = versionsAsTyped(editor, this);
          const theirs = editorProps.onEditor?.(editor);
          return {
            dispose: () => {
              typing.dispose();
              theirs?.dispose();
            },
          };
        },
      });
    }

    /**
     * Writes what the editor is showing to the workspace, now.
     *
     * The moment to call this is a moment the USER made: they stopped typing,
     * or they ran the code, or they closed the file. Anything that wants a
     * version stored says so by calling this, rather than by arranging for
     * something to notice.
     */
    store() {
      const source = this.sharedText?.source;
      if (source === undefined) return;
      void this.workspace.write(this.path, source).settled;
    }
  }

  class PsuedoParent {
    path: string;

    constructor(path: string) {
      this.path = $state(path);
    }
  }

  export class SharedTextFile implements Editor.Props {
    readonly file: Editor.Model;
    readonly parent: PsuedoParent;
    readonly doc: Y.Doc;
    readonly text: Y.Text;
    readonly room: LiveblocksRoom;
    readonly provider: LiveblocksYjsProvider;
    readonly props: NonModelEditorProps;

    constructor(
      id: Id,
      path: string,
      liveblocks: LiveblocksClient,
      props: Omit<Editor.Props, "file">,
    ) {
      this.doc = new Y.Doc();
      this.text = this.doc.getText("content");
      this.room = liveblocks.enterRoom(id);
      this.provider = new LiveblocksYjsProvider(this.room.room, this.doc);
      this.parent = new PsuedoParent(holderOf(path));
      this.file = new Editor.Model({
        name: nameOf(path),
        parent: this.parent,
        sourceSync: this.text,
      });
      this.props = props;
    }

    /**
     * Makes the shared text say `value`, changing as little as possible.
     *
     * What lands in the room is the difference, not the file -- see
     * `difference` for why that distinction is the whole point.
     */
    replace(value: string) {
      if (this.source === value) return;
      const [at, remove, insert] = difference(this.source, value);
      this.doc.transact(() => {
        if (remove > 0) this.text.delete(at, remove);
        if (insert.length > 0) this.text.insert(at, insert);
      });
    }

    path(path: string) {
      this.file.name = nameOf(path);
      this.parent.path = holderOf(path);
    }

    get source() {
      return this.text.toString();
    }

    #disposed = false;

    dispose() {
      if (this.#disposed) return;
      this.#disposed = true;
      this.room.leave();
      this.provider.destroy();
      this.doc.destroy();
    }
  }

  const ROOT = "/home/pyodide";

  export type KernelPool = WarmPool<Kernel>;
</script>

<script lang="ts">
  import {
    DockView,
    GridView,
    Orientation,
    type PanelProps,
    themes,
    type ViewAPI,
  } from "wsfs_suede.dockview-svelte-suede";
  import "wsfs_suede.dockview-svelte-suede/styles/dockview.css";
  import { LayoutPriority } from "dockview";
  import FileTree, {
    Model as FileTreeModel,
    type Id,
  } from "$lib/FileTree.svelte";
  import { appearance } from "$lib/appearance.svelte";
  import FileView from "./FileView.svelte";
  import { onDestroy } from "svelte";
  import type { FileOverride } from "../../../../release/frontend/adapters";
  import { Kernel } from "wsfs_suede.python-web-kernel-suede";
  import { WarmPool } from "./pool";
  import fs from "wsfs_suede.python-web-kernel-suede/fs";

  let {
    workspace,
    liveblocks,
    onEditor,
  }: {
    workspace: Workspace;
    liveblocks: LiveblocksClient;
    /** Every editor as it mounts -- for type tracking later, and for a test
     *  that wants to drive one the way a person does. */
    onEditor?: NonModelEditorProps["onEditor"];
  } = $props();

  const chrome = $derived(themes[appearance.theme].className);

  const snippets = { explorer, dock, assistant };
  const tabs = { file: FileView };
  type Grid = ViewAPI<"grid", typeof snippets>;

  type Dispose = (() => void) | { dispose: () => void };
  const cleanup = Object.assign(
    () => {
      for (const entry of cleanup.set)
        typeof entry === "function" ? entry() : entry.dispose();
      cleanup.set.clear();
    },
    {
      set: new Set<Dispose>(),
      add: (...entries: Dispose[]) =>
        entries.forEach((entry) => cleanup.set.add(entry)),
    },
  );

  const onAPI = async (api: Grid) => {
    cleanup();

    const tree = new FileTreeModel(workspace);

    type TabsAPI = ViewAPI<"dock", typeof tabs>;
    let _tabsAPI: TabsAPI | undefined = undefined;

    const dock = await api.addSnippetPanel(
      "dock",
      { onready: (api) => (_tabsAPI = api) },
      {
        priority: LayoutPriority.High,
      },
    );

    const [explorer, assistant] = await Promise.all([
      api.addSnippetPanel(
        "explorer",
        { model: tree },
        {
          size: 260,
          minimumWidth: 170,
          maximumWidth: 520,
          position: { direction: "left", referencePanel: dock.reference },
        },
      ),
      api.addSnippetPanel(
        "assistant",
        {},
        {
          size: 340,
          minimumWidth: 200,
          maximumWidth: 640,
          position: { direction: "right", referencePanel: dock.reference },
        },
      ),
    ]);

    if (_tabsAPI === undefined)
      throw new Error("Tabs API did not initialize in time");

    const tabsAPI: TabsAPI = _tabsAPI!;

    const tab = (idOrEntry: FileTreeModel.Entry | FileTreeModel.Entry["id"]) =>
      tabsAPI.getPanel(
        typeof idOrEntry === "string" ? idOrEntry : idOrEntry.id,
      );

    const openInProgress = new Set<Id>();
    const openFiles = new Map<Id, OpenFile>();

    const override: FileOverride = {
      get: (path) => {
        const id = tree.mapping.of(path);
        if (id) return openFiles.get(id)?.sharedText?.source;
      },
      put: (path, value) => {
        const id = tree.mapping.of(path);
        if (!id) return false;
        const sharedText = openFiles.get(id)?.sharedText;
        if (!sharedText) return false;
        // A script writing a file is a moment of its own, so the version is
        // stored at once rather than waiting for typing that is not coming.
        sharedText.replace(value);
        openFiles.get(id)?.store();
        return true;
      },
    };

    Editor.provideFiles(provider(workspace, override), { searchRoot: "" });

    const kernelPool = new WarmPool<Kernel>({
      create: () =>
        new Kernel({
          fs: fs.readWrite({ ...filesystem(workspace, override), root: ROOT }),
          input: async (prompt) => window.prompt(prompt) ?? "",
        }),
    });

    const editorProps: NonModelEditorProps = { onEditor };

    cleanup.add(
      () => openFiles.forEach((open) => open.dispose()),
      tabsAPI.onDidActivePanelChange(({ panel }) => tree.select(panel?.id)),
      tabsAPI.onDidRemovePanel((panel) => {
        tree.deselect(panel.id);
        // Closing is the last chance to keep what was typed, and letting the
        // file go is what makes reopening it start clean rather than resume.
        openFiles.get(panel.id)?.dispose();
        openFiles.delete(panel.id);
      }),
      tree.subscribe({
        open: async (entry) => {
          const panel = tab(entry);
          if (panel) return panel.api.setActive();
          const { id, path } = entry;
          if (openInProgress.has(id)) return;
          openInProgress.add(id);
          try {
            const title = nameOf(path);
            const opened = new OpenFile(entry, liveblocks, editorProps, workspace);
            openFiles.set(id, opened);
            await tabsAPI.addComponentPanel(
              "file",
              { opened, kernelPool, workspace },
              { id, title },
            );
          } finally {
            // However it went. Left set, a file that has been opened once can
            // never be opened again -- and closing its panel is exactly when
            // somebody tries.
            openInProgress.delete(id);
          }
        },
        renamed: ({ id, path }) => {
          openFiles.get(id)?.move(path);
          const panel = tab(id);
          if (panel === undefined) return;
          panel.api.updateParameters({ workspace, path });
          panel.api.setTitle(nameOf(path));
        },
        removed: ({ id }) => {
          tab(id)?.api.close();
          openFiles.get(id)?.dispose();
          openFiles.delete(id);
        },
      }),
    );
  };

  onDestroy(cleanup);
</script>

{#snippet explorer({
  params: { model },
}: PanelProps<"grid", { model: FileTreeModel }>)}
  <section class="explorer" data-region="explorer">
    <h2>Explorer</h2>
    <FileTree {model} />
  </section>
{/snippet}

{#snippet dock({
  params: { onready },
}: PanelProps<
  "grid",
  { onready: (api: ViewAPI<"dock", typeof tabs>) => void }
>)}
  <div class="documents" data-region="documents">
    <DockView
      theme={appearance.theme}
      components={tabs}
      onReady={({ api }) => onready(api)}
    />
  </div>
{/snippet}

{#snippet assistant({}: PanelProps<"grid", {}>)}
  <section class="assistant" data-region="assistant">
    <h2>AI Chat</h2>
    <p>Nothing here yet.</p>
  </section>
{/snippet}

<div class="shell {chrome}" data-region="shell">
  <GridView
    {snippets}
    orientation={Orientation.HORIZONTAL}
    proportionalLayout={false}
    onReady={({ api }) => onAPI(api)}
  />
</div>

<style>
  .shell {
    height: 100%;
    width: 100%;
    min-height: 0;
    background: var(--wsfs-ground, #f7f7f9);
  }

  :global(:root) {
    --wsfs-ground: #f7f7f9;
    --wsfs-raised: #ffffff;
    --wsfs-sunken: #fbfbfd;
    --wsfs-line: #e5e7eb;
    --wsfs-muted: #6b7280;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"])) {
      --wsfs-ground: #131316;
      --wsfs-raised: #1a1a1f;
      --wsfs-sunken: #17171b;
      --wsfs-line: #2a2a31;
      --wsfs-muted: #9ca3af;
    }
  }

  .explorer {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--wsfs-sunken, #fbfbfd);
    border-right: 1px solid var(--wsfs-line, #e5e7eb);
  }

  .explorer h2 {
    margin: 0;
    padding: 0.6rem 0.75rem 0.5rem;
    font:
      600 0.68rem/1 ui-sans-serif,
      system-ui,
      sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--wsfs-muted, #6b7280);
  }

  .documents {
    height: 100%;
    width: 100%;
    min-width: 0;
    min-height: 0;
  }

  .assistant {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--wsfs-sunken, #fbfbfd);
    border-left: 1px solid var(--wsfs-line, #e5e7eb);
  }

  .assistant h2 {
    margin: 0;
    padding: 0.6rem 0.75rem 0.5rem;
    font:
      600 0.68rem/1 ui-sans-serif,
      system-ui,
      sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--wsfs-muted, #6b7280);
  }

  .assistant p {
    margin: 0;
    padding: 0.75rem;
    font:
      0.85rem/1.6 ui-sans-serif,
      system-ui,
      sans-serif;
    color: var(--wsfs-muted, #6b7280);
  }
</style>
