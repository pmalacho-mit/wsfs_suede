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

  export class OpenFile {
    readonly id: Id;
    readonly liveblocks: LiveblocksClient;
    readonly editorProps: NonModelEditorProps;

    sharedText = $state<SharedTextFile>();
    path = $state("");

    constructor(
      { id, path }: FileTreeModel.Entry,
      liveblocks: LiveblocksClient,
      editorProps: NonModelEditorProps,
    ) {
      this.id = id;
      this.path = path;
      this.liveblocks = liveblocks;
      this.editorProps = editorProps;
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
      this.sharedText ??= new SharedTextFile(id, path, liveblocks, editorProps);
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

    path(path: string) {
      this.file.name = nameOf(path);
      this.parent.path = holderOf(path);
    }

    get source() {
      return this.text.toString();
    }

    dispose() {
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
  }: { workspace: Workspace; liveblocks: LiveblocksClient } = $props();

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
        // TODO:
        // must apply `value` as delta to the existing yjs source
        // (not just delete and insert, since that ruins collaboration)
        // then write new value to workspace.
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

    const editorProps: NonModelEditorProps = {
      onEditor: (editor) => {
        // useful later for type tracking
        return {
          dispose: () => {},
        };
      },
    };

    cleanup.add(
      () => openFiles.forEach((open) => open.dispose()),
      tabsAPI.onDidActivePanelChange(({ panel }) => tree.select(panel?.id)),
      tabsAPI.onDidRemovePanel((panel) => tree.deselect(panel.id)),
      tree.subscribe({
        open: async (entry) => {
          const panel = tab(entry);
          if (panel) return panel.api.setActive();
          const { id, path } = entry;
          if (openInProgress.has(id)) return;
          openInProgress.add(id);
          const title = nameOf(path);
          const opened = new OpenFile(entry, liveblocks, editorProps);
          openFiles.set(id, opened);
          await _tabsAPI!.addComponentPanel(
            "file",
            { opened, kernelPool, workspace },
            { id, title },
          );
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
