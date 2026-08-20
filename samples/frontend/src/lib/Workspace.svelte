<script lang="ts" module>
  import { createClient } from "@liveblocks/client";
  import { LiveblocksYjsProvider } from "@liveblocks/yjs";
  import * as Y from "yjs";
  import { Editor } from "wsfs_suede.python-monaco-suede";
  import { nameOf, holderOf } from "$lib/paths";
  import { filesystem, MappedDebouncer, provider, type Workspace } from "$wsfs";
  import { WithEvents } from "wsfs_suede.with-events-suede";
  import { SvelteSet } from "svelte/reactivity";
  import { deltaBetween, editsFor } from "$lib/delta";

  type LiveblocksClient = ReturnType<typeof createClient>;
  type LiveblocksRoom = ReturnType<LiveblocksClient["enterRoom"]>;

  export type NonModelEditorProps = Omit<Editor.Props, "file">;

  const typingDebouncer = new MappedDebouncer({
    idleMs: 500,
    maxWaitMs: 2000,
  });

  /** What the editor hands to `onEditor`, named once. */
  type CodeEditor = Parameters<NonNullable<Editor.Props["onEditor"]>>[0];

  /**
   * Something a person did to a file, named.
   *
   * The editor reports that its model changed and says nothing about why, so
   * this is assembled from the parts that DO say: a paste announces itself,
   * undo and redo are flagged on the change, and what is left is read off the
   * shape of the change -- text arriving, text going, or one swapped for the
   * other. Downstream this is worth more than "it changed": it is what a log
   * of a session is made of, and it is what tells a person's work apart from
   * an update arriving from the room.
   */
  export type UserAction =
    | { did: "typed"; text: string }
    | { did: "pasted"; text: string }
    | { did: "deleted"; length: number }
    | { did: "replaced"; text: string; length: number }
    | { did: "undid" }
    | { did: "redid" };

  /** What a content change was, given what the editor already told us. */
  const asAction = (
    change: { isUndoing: boolean; isRedoing: boolean; changes: readonly { text: string; rangeLength: number }[] },
    pasted: boolean,
  ): UserAction | undefined => {
    if (change.isUndoing) return { did: "undid" };
    if (change.isRedoing) return { did: "redid" };

    const text = change.changes.map((edit) => edit.text).join("");
    const length = change.changes.reduce((total, edit) => total + edit.rangeLength, 0);

    if (pasted) return { did: "pasted", text };
    if (text.length > 0 && length > 0) return { did: "replaced", text, length };
    if (text.length > 0) return { did: "typed", text };
    if (length > 0) return { did: "deleted", length };
    return undefined;
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

    /**
     * `content` is what the workspace holds, and it is needed for two
     * different reasons: the editor opens on it, and an empty room is filled
     * from it. Without the first, opening a file writes the empty editor
     * straight back over it.
     */
    share(content: string) {
      const { id, path, liveblocks, editorProps } = this;
      this.sharedText ??= new SharedTextFile(
        id,
        path,
        content,
        liveblocks,
        editorProps,
        // The transaction, not the promise: a snapshot has to be able to
        // name the version it just asked for, and the answer comes far later.
        () => {
          const { transaction, settled } = this.workspace.write(
            this.path,
            this.sharedText!.source,
          );
          void settled;
          return transaction;
        },
      );
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
      return this.sharedText?.store();
    }

    /** Whether there is anything to store -- see `SharedTextFile.dirty`. */
    get dirty() {
      return this.sharedText?.dirty === true;
    }
  }

  class PsuedoParent {
    path: string;

    constructor(path: string) {
      this.path = $state(path);
    }
  }

  /**
   * One text file, shared with whoever else has it open.
   *
   * It owns its own editor wiring, because the events worth having are the
   * editor's: a person focusing this file and a person changing it are facts
   * about a human, and this is the only place that can see them. Everything
   * else -- storing versions here, an assistant panel elsewhere -- hangs off
   * those events rather than reaching for the editor again.
   */
  export class SharedTextFile extends WithEvents<{
    /** The person put their cursor in this file. */
    focused: [editor: CodeEditor];
    blurred: [editor: CodeEditor];
    /**
     * The person did something to this text. Not somebody else in the room,
     * and not the shared doc arriving -- see `#watch` for how those are told
     * apart from a person.
     */
    acted: [action: UserAction, editor: CodeEditor];
  }> {
    readonly id: Id;
    readonly file: Editor.Model;
    readonly parent: PsuedoParent;
    readonly doc: Y.Doc;
    readonly text: Y.Text;
    readonly room: LiveblocksRoom;
    readonly provider: LiveblocksYjsProvider;
    readonly props: NonModelEditorProps;

    /**
     * Whether this holds anything that has not been stored as a version.
     *
     * The question it answers is "does what the user is looking at exist
     * anywhere else yet" -- which is what anything about to send this file
     * somewhere needs to know, so it can store first rather than send what
     * was there a moment ago.
     */
    dirty = $state(false);

    /**
     * Whether the room has said what it holds.
     *
     * Nothing may be written into this text before it has -- not the editor,
     * not a script -- because until then there is no telling whether a write
     * is filling an empty file or duplicating one.
     */
    ready = $state(false);

    readonly #persist: () => string;

    constructor(
      id: Id,
      path: string,
      content: string,
      liveblocks: LiveblocksClient,
      props: Omit<Editor.Props, "file">,
      /** Submits a version and hands back the transaction that will carry it. */
      persist: () => string,
    ) {
      super();
      this.id = id;
      this.#persist = persist;
      this.doc = new Y.Doc();
      this.text = this.doc.getText("content");
      this.room = liveblocks.enterRoom(id);
      this.provider = new LiveblocksYjsProvider(this.room.room, this.doc);
      this.parent = new PsuedoParent(holderOf(path));
      this.file = new Editor.Model({
        name: nameOf(path),
        parent: this.parent,
        // The editor opens on this and the shared text takes over. Without
        // it the editor opens on nothing, and the editor writes what it is
        // showing back through the file provider -- over the file.
        source: content,
        sourceSync: this.text,
      });
      this.#fill(content);
      // Its own wiring, layered over whatever the caller wanted, so a
      // consumer passing `onEditor` still gets it.
      this.props = {
        ...props,
        onEditor: (editor) => this.#watch(editor, props.onEditor?.(editor)),
      };
    }

    /**
     * Fills an empty room from the workspace, once, and only once the room
     * has SAID it is empty.
     *
     * The first person to open a file arrives to a room with nothing in it,
     * and a room with nothing in it stored over the file is the file gone.
     * But filling one before it has answered is worse: Yjs merges, so the
     * content the room was about to deliver arrives on top of the copy just
     * inserted and the file says everything twice.
     *
     * There is no way to know what a room holds until it says, so this waits
     * for it to say. A room that never answers leaves the file unopened,
     * which is recoverable; a file saved with its contents doubled is not.
     */
    #fill(content: string) {
      const fill = () => {
        if (this.#disposed) return;
        if (content.length > 0 && this.text.length === 0)
          this.doc.transact(() => this.text.insert(0, content));
        this.ready = true;
      };
      if (this.provider.synced) return fill();
      this.provider.once("synced", fill);
    }

    /**
     * Stores a version now, and stops being dirty.
     *
     * Clearing first is deliberate: a keystroke landing while the write is in
     * flight has to leave this dirty again, and it will.
     */
    store() {
      if (typingDebouncer.has(this.id)) typingDebouncer.clear(this.id);
      if (!this.ready) return undefined;
      this.dirty = false;
      return this.#persist();
    }

    /**
     * Makes the shared text say `value`, changing as little as possible.
     *
     * The difference is worked out properly rather than as one span from the
     * first change to the last -- see `delta.ts`. What reaches the room is
     * what actually moved, so cursors between two edits stay where they are
     * and a merge has something to work with.
     */
    replace(value: string): boolean {
      if (this.source === value) return false;
      this.doc.transact(() => {
        for (const edit of editsFor(deltaBetween(this.source, value)))
          if ("insert" in edit) this.text.insert(edit.at, edit.insert);
          else this.text.delete(edit.at, edit.remove);
      });
      return true;
    }

    /**
     * The editor's own events, and the one judgement call in here.
     *
     * The model changing is the only signal that catches everything a person
     * can do -- typing, backspace, paste, undo -- and it also fires for every
     * update arriving from the room. Focus is what separates the two: a
     * change while this editor has the caret is this person's. The mistake it
     * can still make is attributing somebody else's edit that landed while
     * the caret was here, which stores the same text this client would have
     * stored anyway.
     */
    #watch(editor: CodeEditor, theirs: { dispose: () => void } | undefined) {
      // A paste says so just before the change it causes, and nothing else
      // distinguishes pasted text from typed text after the fact.
      let pasted = false;

      const attached = [
        editor.onDidFocusEditorText(() => this.fire("focused", editor)),
        editor.onDidBlurEditorText(() => this.fire("blurred", editor)),
        editor.onDidPaste(() => (pasted = true)),
        editor.onDidChangeModelContent((change) => {
          const was = pasted;
          pasted = false;
          if (!editor.hasTextFocus()) return;
          const action = asAction(change, was);
          if (action !== undefined) this.fire("acted", action, editor);
        }),
        // Storing is a listener like any other, so that anything else wanting
        // to know what a person did hooks in beside it rather than instead.
        this.subscribe({
          acted: () => {
            this.dirty = true;
            typingDebouncer.enqueue(this.id, () => this.store());
          },
        }),
        theirs,
      ];

      return {
        dispose: () => {
          for (const attachment of attached)
            typeof attachment === "function" ? attachment() : attachment?.dispose();
          // Closing is the last chance to keep what was typed into it.
          if (this.dirty) this.store();
        },
      };
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

  /**
   * One entry, as anything about to describe this workspace needs it.
   *
   * All four tokens, not just the content one, because together they are the
   * entry: what it is called, where it lives, whether it is gone, and what is
   * in it. A snapshot naming all four can be rebuilt into the filesystem as
   * it stood -- and it stays rebuildable even if the server later refuses one
   * of those transactions, because what it records is what the user was
   * looking at, which happened whether or not anybody agreed to it.
   */
  export type Held = {
    entry: Id;
    path: string;
    name: string;
    versions: {
      name: string;
      parent: string;
      deleted: string;
      content: string | null;
    };
    open: boolean;
    /** On screen right now. Two panels side by side are both on screen. */
    visible: boolean;
    /**
     * What the user is looking at is not any of the versions above yet.
     *
     * Never true in a snapshot taken with `resolveDirty`, which is the point
     * of that option.
     */
    dirty: boolean;
    /**
     * The transaction this snapshot submitted for it, if it submitted one.
     *
     * Its content version does not exist yet -- the token above is still the
     * old one -- so this is what names the version the user was actually
     * looking at.
     */
    stored?: string;
  };

  export type Snapshot = {
    taken: Date;
    entries: Held[];
    /** The subset the user can actually see, which is the useful default. */
    visible: Held[];
  };

  export type Taking = {
    /**
     * Submit every dirty editor first, in ONE pass, and record what was
     * submitted.
     *
     * Without it a caller has to check `dirty`, store, and check again --
     * and something typed in between leaves it looping, or worse, describing
     * a state that was never on screen. One pass says: this is what the user
     * had at the moment I asked. Anything typed after belongs to the next
     * snapshot.
     */
    resolveDirty?: boolean;
  };

  /**
   * Which panels are on screen, kept up to date as the layout is moved.
   *
   * "In front" is not the same question as "visible": dockview shows one
   * panel per GROUP, so two groups side by side means two visible panels and
   * neither of them stops being visible when the other is clicked. The panel
   * api answers it directly, and says when the answer changes -- so this can
   * be read live rather than worked out at the moment somebody asks.
   */
  class InView {
    readonly #showing = new SvelteSet<Id>();
    readonly #watching = new Map<Id, { dispose: () => void }>();

    /**
     * Read as a whole rather than asked per entry, so that anything
     * rendering from it depends on the SET and not on whichever entries
     * happened to exist the first time it looked.
     */
    get showing(): ReadonlySet<Id> {
      return this.#showing;
    }

    watch(panel: { id: string; api: { isVisible: boolean; onDidVisibilityChange: (listen: (event: { isVisible: boolean }) => void) => { dispose: () => void } } }) {
      this.forget(panel.id);
      const settle = (visible: boolean) =>
        visible ? this.#showing.add(panel.id) : this.#showing.delete(panel.id);
      settle(panel.api.isVisible);
      this.#watching.set(
        panel.id,
        panel.api.onDidVisibilityChange(({ isVisible }) => settle(isVisible)),
      );
    }

    forget(entry: Id) {
      this.#watching.get(entry)?.dispose();
      this.#watching.delete(entry);
      this.#showing.delete(entry);
    }

    dispose() {
      for (const entry of [...this.#watching.keys()]) this.forget(entry);
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
    onSnapshot,
  }: {
    workspace: Workspace;
    liveblocks: LiveblocksClient;
    /** Every editor as it mounts -- for type tracking later, and for a test
     *  that wants to drive one the way a person does. */
    onEditor?: NonModelEditorProps["onEditor"];
    /** Handed the snapshot taker once there is one, for anything outside
     *  this component that needs to describe what the user is looking at. */
    onSnapshot?: (take: (options?: Taking) => Snapshot) => void;
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

    const openInProgress = new Set<Id>();
    const openFiles = new Map<Id, OpenFile>();
    const inView = new InView();
    cleanup.add(inView);

    /**
     * Everything this workspace holds, as it stands right now.
     *
     * Taken rather than watched: whoever asks is about to send it somewhere,
     * and what matters is that it describes the moment they asked. `dirty`
     * is the one to read first -- an entry showing it has a version named
     * here that the user has already moved past, so store before sending.
     */
    const snapshot = ({ resolveDirty = false }: Taking = {}): Snapshot => {
      // One pass, before anything is read, so every entry below is described
      // as of the same moment.
      const stored = new Map<Id, string>();
      if (resolveDirty)
        for (const [entry, open] of openFiles) {
          if (!open.dirty) continue;
          const transaction = open.store();
          if (transaction !== undefined) stored.set(entry, transaction);
        }

      const index = workspace.index();
      // Copied up front: reading the set is what makes a live view of this
      // re-render, and reading it per entry would not happen at all in a
      // workspace that is still empty.
      const showing = new Set(inView.showing);
      const entries: Held[] = [];
      for (const entry of workspace.entries().values()) {
        const path = index.of(entry.id);
        if (path === undefined || entry.type === "folder") continue;
        const open = openFiles.get(entry.id);
        entries.push({
          entry: entry.id,
          path,
          name: entry.name,
          versions: {
            name: entry.name_version,
            parent: entry.parent_version,
            deleted: entry.deleted_version,
            content: entry.content_version ?? null,
          },
          open: open !== undefined,
          visible: showing.has(entry.id),
          dirty: open?.dirty === true,
          ...(stored.has(entry.id) ? { stored: stored.get(entry.id) } : {}),
        });
      }
      return {
        taken: new Date(),
        entries,
        visible: entries.filter((held) => held.visible),
      };
    };


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
        { snapshot },
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

    const override: FileOverride = {
      get: (path) => {
        const id = tree.mapping.of(path);
        if (id) return openFiles.get(id)?.sharedText?.source;
      },
      put: (path, value) => {
        const id = tree.mapping.of(path);
        if (!id) return false;
        const sharedText = openFiles.get(id)?.sharedText;
        // Not ready means the room has not said what it holds, and writing
        // into it now is how a file ends up saying everything twice. Refused,
        // so the write goes to the workspace the ordinary way instead.
        if (!sharedText?.ready) return false;
        // Only if it actually said something new. The editor writes what it
        // is showing back through here as it opens a file, and storing that
        // would be a version identical to the one before it -- which is waste
        // at best, and at worst a second write racing the first with the same
        // token to present.
        if (sharedText.replace(value)) openFiles.get(id)?.store();
        return true;
      },
    };

    Editor.provideFiles(provider(workspace, override), { searchRoot: "" });
    onSnapshot?.(snapshot);

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
      tabsAPI.onDidAddPanel((panel) => inView.watch(panel)),
      tabsAPI.onDidRemovePanel((panel) => {
        tree.deselect(panel.id);
        inView.forget(panel.id);
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
            const opened = new OpenFile(
              entry,
              liveblocks,
              editorProps,
              workspace,
            );
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

{#snippet assistant({
  params: { snapshot },
}: PanelProps<"grid", { snapshot: () => Snapshot }>)}
  <section class="assistant" data-region="assistant">
    <h2>AI Chat</h2>
    <!-- Not the assistant, but what the assistant will be handed: whatever
         the user can see when they send a message. Rendered because a live
         answer is easier to trust when you can watch it change. -->
    <p class="note">What I would be given:</p>
    <ul data-region="in-view">
      {#each snapshot().visible as held (held.entry)}
        <li data-path={held.path} data-dirty={held.dirty}>
          {held.path}{held.dirty ? " •" : ""}
        </li>
      {:else}
        <li class="note">nothing open</li>
      {/each}
    </ul>
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
    grid-template-rows: auto auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--wsfs-sunken, #fbfbfd);
    border-left: 1px solid var(--wsfs-line, #e5e7eb);
  }

  .assistant ul {
    margin: 0;
    padding: 0 0.75rem;
    list-style: none;
    font: 0.8rem/1.8 ui-monospace, monospace;
    color: var(--wsfs-muted, #6b7280);
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
