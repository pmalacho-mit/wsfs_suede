<script lang="ts" module>
  import { createClient } from "@liveblocks/client";
  import { Editor } from "wsfs_suede.python-monaco-suede";
  import { nameOf, holderOf } from "$lib/paths";
  import {
    filesystem,
    MappedDebouncer,
    provider,
    type Workspace,
  } from "$wsfs";
  import {
    become,
    Rooms,
    type Room,
    type Sending,
    type Stored,
  } from "$lib/collab/room.svelte";
  import { enteringWith } from "$lib/collab/collaborator";
  import type { editor } from "monaco-editor";
  import { UserEdits } from "./edits";
  import { cleaner } from "./utils";

  type LiveblocksClient = ReturnType<typeof createClient>;

  export type NonModelEditorProps = Omit<Editor.Props, "file">;

  const typingDebouncer = new MappedDebouncer({
    idleMs: 500,
    maxWaitMs: 2000,
  });

  export class OpenFile {
    readonly id: Id;
    readonly rooms: Rooms;
    readonly editorProps: NonModelEditorProps;
    readonly workspace: Workspace;

    sharedText = $state<SharedTextFile>();
    path = $state("");

    constructor(
      { id, path }: FileTreeModel.Entry,
      rooms: Rooms,
      editorProps: NonModelEditorProps,
      workspace: Workspace,
    ) {
      this.id = id;
      this.path = path;
      this.rooms = rooms;
      this.editorProps = editorProps;
      this.workspace = workspace;
    }

    move(path: string) {
      this.path = path;
      this.sharedText?.path(path);
    }

    /**
     * `content` is what the workspace holds, and it is needed for two
     * different reasons: the editor opens on it, and an empty room is filled
     * from it. Without the first, opening a file writes the empty editor
     * straight back over it.
     */
    share(content: string) {
      const { id, path, rooms, editorProps } = this;
      this.sharedText ??= new SharedTextFile(
        id,
        path,
        content,
        rooms,
        editorProps,
        this.workspace,
      );
    }
  }

  class PsuedoParent {
    path: string;

    constructor(path: string) {
      this.path = $state(path);
    }
  }

  /**
   * One text file, shared with whoever else has it open (via yjs / liveblocks).
   *
   * It owns its own editor wiring, because the events worth having are the
   * editor's: a person focusing this file and a person changing it are facts
   * about a human, and this is the only place that can see them. Everything
   * else -- storing versions here, an assistant panel elsewhere -- hangs off
   * those events rather than reaching for the editor again.
   */
  export class SharedTextFile {
    readonly id: Id;
    readonly workspace: Workspace;
    readonly file: Editor.Model;
    readonly parent: PsuedoParent;
    readonly props: NonModelEditorProps;
    readonly initialContent: string;

    /** Every room this workspace holds -- one stream feeds all of them. */
    readonly rooms: Rooms;

    /**
     * The protocol, shared with the two-browser suite.
     *
     * Everything about whether this document still speaks for the file lives
     * in there -- see `collab/room.svelte.ts`. What is left here is the
     * editor: binding it at the right moment, and telling the room what the
     * person at the keyboard did.
     *
     * Undefined until the room has synced AND reconciled, which is also how
     * anything rendering this knows not to show an editor yet.
     */
    shared = $state<Room>();

    readonly cleanup = cleaner();

    editor = $state<editor.IStandaloneCodeEditor>();
    userEdits = $state<UserEdits>();

    /**
     * Whether this holds anything that has NOT been submitted as a version.
     *
     * The question it answers is "does what the user is looking at exist
     * anywhere else yet" -- which is what anything about to send this file
     * somewhere needs to know, so it can store first rather than send what
     * was there a moment ago.
     */
    dirty = $state(false);

    constructor(
      id: Id,
      path: string,
      content: string,
      rooms: Rooms,
      props: Omit<Editor.Props, "file">,
      workspace: Workspace,
    ) {
      this.id = id;
      this.initialContent = content;
      this.workspace = workspace;
      this.parent = new PsuedoParent(holderOf(path));
      this.file = new Editor.Model({
        name: nameOf(path),
        parent: this.parent,
        source: content,
      });

      /**
       * Opened, then bound -- and never the other way about.
       *
       * `Rooms.open` does not resolve until the document has been RECEIVED and
       * reconciled against what the server holds. Binding before that is not a
       * cosmetic race: `MonacoBinding` makes the model say whatever the
       * `Y.Text` says the moment it is constructed, so binding an
       * unsynchronised document does not show an empty file, it MAKES one --
       * and the next store writes that over the real content.
       *
       * This is what the old `subscribe("status")` wiring got wrong. Liveblocks
       * says `connected` when the SOCKET is up, which is a strictly earlier
       * moment than the Yjs provider having the document.
       */
      this.rooms = rooms;
      void rooms
        .open(id)
        .then((room) => {
          if (this.#disposed) return;
          this.shared = room;
          this.file.sourceSync = room.text;
          if (this.editor) this.#watching(this.editor);
        })
        /**
         * A room that never syncs leaves the editor on the content the
         * workspace handed it, unshared and unbound -- which is a worse
         * experience than collaborating and a much better one than an empty
         * file. `sourceSync` stays undefined, so `source` falls back to the
         * model, and `store` answers that it was held.
         */
        .catch((reason) => console.error(`room ${id} did not open`, reason));

      this.props = {
        ...props,
        onEditor: (editor) => {
          this.editor = editor;
          const disposable = props.onEditor?.(editor);
          const userEdits = this.#watching(editor);
          return {
            dispose: () => {
              disposable?.dispose();
              userEdits.dispose();
            },
          };
        },
      };
    }

    /**
     * What the person at this keyboard did, and what it costs.
     *
     * The two things that follow from an edit are here TOGETHER because they
     * are the same fact seen twice: this file now holds something that exists
     * nowhere else. `dirty` is that fact for anything about to describe the
     * screen; the debounced store is that fact being fixed.
     *
     * Only the user's own edits count. A peer's keystroke arriving through
     * y-monaco changes this model too, and treating that as this person's work
     * would have every member of a room storing every other member's typing --
     * which is why `UserEdits` exists rather than `onDidChangeModelContent`.
     */
    #watching(editor: editor.IStandaloneCodeEditor): UserEdits {
      this.userEdits?.dispose();
      const userEdits = new UserEdits(editor, this.file.sourceSync);
      this.userEdits = userEdits;
      userEdits.subscribe({
        edited: () => {
          this.dirty = true;
          typingDebouncer.enqueue(this.id, () => void this.store());
        },
      });
      return userEdits;
    }

    /**
     * Stores a version now, and stops being dirty.
     *
     * Clearing first is deliberate: a keystroke landing while the write is in
     * flight has to leave this dirty again, and it will.
     *
     * MAY ANSWER THAT IT DID NOT. A room that is not reaching the others, or
     * that owes a repair, must not write what it is showing back -- see
     * `rooms.speaking`. Nothing is lost by that: the text stays in the shared
     * document and goes when the room recovers. It does mean a caller cannot
     * assume a transaction came back, which is why this says which happened
     * rather than returning an id that might be a lie.
     */
    store(): Promise<Stored> {
      const sent = this.send();
      if (sent.held) return Promise.resolve(sent);
      return sent.settled.then((answer) => ({
        held: false as const,
        transaction: sent.transaction,
        rejected: answer.rejected,
      }));
    }

    /**
     * The same write, answered with the transaction and not waited on.
     *
     * What a snapshot uses: it describes the moment it was asked for, and
     * waiting on the server would describe a later one.
     */
    send(): Sending {
      const { id, file } = this;
      const room = this.shared;
      const sent: Sending =
        room === undefined
          ? { held: true, why: "the room is not open yet" }
          : room.send(file.path);
      /**
       * Cleared only when the write actually went.
       *
       * A HELD WRITE LEAVES THIS DIRTY, and that is the whole point of saying
       * so: `dirty` means "what the user is looking at exists nowhere else
       * yet", which is exactly what is still true when a room out of touch
       * declines to publish it. Clearing here regardless -- which is what this
       * did before rooms could decline -- would show a saved file that had
       * never been saved.
       *
       * Clearing FIRST, before the answer, is still deliberate: a keystroke
       * landing while the write is in flight has to leave this dirty again,
       * and it will.
       */
      if (!sent.held) {
        typingDebouncer.clear(id);
        this.dirty = false;
      }
      return sent;
    }

    /** The transaction a snapshot can name for this file, if there is one. */
    storing(): string | undefined {
      const sent = this.send();
      return sent.held ? undefined : sent.transaction;
    }

    /**
     * Makes the shared text say `value`, changing as little as possible.
     *
     * This shouldn't be used with changes coming from the server
     * (we rely on yjs / liveblocks for that).
     *
     * Instead, this is for cases when a user's local environment wants to update
     * their content (and thus they are responsible for it -- e.g. python writes, monaco refactors)
     */
    forceReplace(value: string): boolean {
      if (this.source === value) return false;
      const yText = this.file.sourceSync;
      if (yText) become(yText, value);
      else if (this.editor) this.editor.getModel()?.setValue(value);
      return true;
    }

    path(path: string) {
      this.file.name = nameOf(path);
      this.parent.path = holderOf(path);
    }

    get source() {
      return (
        this.file.sourceSync?.toString() ??
        this.editor?.getModel()?.getValue() ??
        this.initialContent
      );
    }

    #disposed = false;

    dispose() {
      if (this.#disposed) return;
      this.#disposed = true;
      this.cleanup();
      this.userEdits?.dispose();
      this.rooms.close(this.id);
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
  import { InView } from "./inview.svelte";

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

  const cleanup = cleaner();

  const onAPI = async (api: Grid) => {
    cleanup();

    const tree = new FileTreeModel(workspace);

    /**
     * One registry for the whole workspace, and therefore ONE subscription to
     * the stream feeding every room. A room that subscribed for itself would
     * have to be open before it could hear anything -- which is exactly the
     * case `rooms.opening` exists to cover, and would leave every file that
     * was ever closed and reopened quietly behind.
     */
    const rooms = new Rooms(workspace, enteringWith(liveblocks));

    const openInProgress = new Set<Id>();
    const openFiles = new Map<Id, OpenFile>();
    const inView = new InView();
    cleanup.add(inView, () => rooms.dispose());

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
          const shared = open.sharedText;
          if (!shared?.dirty) continue;
          /**
           * The transaction is known SYNCHRONOUSLY or not at all. A snapshot
           * describes the moment it was asked for, so waiting on the write
           * would describe a later one -- and a room that is holding its
           * writes has no transaction to name at any point. Such an entry
           * stays `dirty` in the snapshot, which is the honest answer: what
           * the user is looking at exists nowhere else yet.
           */
          const transaction = shared.storing();
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
          dirty: open?.sharedText?.dirty === true,
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
        /**
         * A room that has not said what it holds is not a room this write can
         * go into: editing a document that has not received its own content
         * merges the two rather than replacing one with the other, which is
         * how a file ends up saying everything twice. Refused, so the write
         * goes to the workspace the ordinary way and the room picks it up as
         * an ordinary gap when it does sync.
         *
         * This is the `ready` check that used to be commented out here. It
         * was right; what was missing was something that could answer it,
         * and `Room.ready` -- synced AND reconciled -- is that.
         */
        if (sharedText?.shared?.ready !== true) return false;

        // Only if it actually said something new. The editor writes what it
        // is showing back through here as it opens a file, and storing that
        // would be a version identical to the one before it -- which is waste
        // at best, and at worst a second write racing the first with the same
        // token to present.
        if (sharedText.forceReplace(value)) void sharedText.store();
        return true;
      },
      /**
       * Bytes replacing a file somebody has open as text.
       *
       * The write is NOT taken -- `false` sends it down the ordinary path, so
       * it lands as a version like any other. What this door is for is the
       * second half of that: telling the room its file stopped being the text
       * it is showing, so the editor stops claiming to speak for it. Refusing
       * was never on the table (a door that can refuse is a door that can
       * lose data) and merging is not possible -- there is nothing to merge
       * bytes into.
       *
       * The remote case reaches the same conclusion by a different route: a
       * write from another client arrives over the stream and the room finds
       * out by READING the file, because nothing in a token says whether it
       * names text or bytes. This is that conclusion reached one step earlier,
       * by a caller already holding the bytes.
       */
      replaced: async (path, bytes, mime) => {
        const id = tree.mapping.of(path);
        if (!id) return false;
        const room = openFiles.get(id)?.sharedText?.shared;
        if (room === undefined) return false;

        /**
         * TAKEN, and that is the only reason to be here at all.
         *
         * Nothing is merged -- there is nothing to merge bytes into -- so the
         * write itself would be identical down the ordinary path. What taking
         * it buys is the TOKEN: the room has to be told which version ended
         * it, and the only way to know that before the round trip is to be
         * the one who sent it.
         *
         * Awaited because the kernel's caller is: a script that writes a file
         * and reads it back expects to have been told.
         */
        const { transaction, settled } = workspace.write(path, bytes, mime);
        const answer = await settled;
        if (!answer.rejected) room.tookAway(transaction, mime);
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
      () => openFiles.forEach((open) => open.sharedText?.dispose()),
      tabsAPI.onDidActivePanelChange(({ panel }) => tree.select(panel?.id)),
      tabsAPI.onDidAddPanel((panel) => inView.watch(panel)),
      tabsAPI.onDidRemovePanel((panel) => {
        tree.deselect(panel.id);
        inView.forget(panel.id);
        // Closing is the last chance to keep what was typed, and letting the
        // file go is what makes reopening it start clean rather than resume.
        openFiles.get(panel.id)?.sharedText?.dispose();
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
            const opened = new OpenFile(entry, rooms, editorProps, workspace);
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
          openFiles.get(id)?.sharedText?.dispose();
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
    font:
      0.8rem/1.8 ui-monospace,
      monospace;
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
