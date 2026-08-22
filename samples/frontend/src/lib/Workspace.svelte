<script lang="ts" module>
  import { createClient, type Status } from "@liveblocks/client";
  import {
    //getYjsProviderForRoom,
    type LiveblocksYjsProvider,
  } from "@liveblocks/yjs";
  import * as Y from "yjs";
  import { Editor } from "wsfs_suede.python-monaco-suede";
  import { nameOf, holderOf } from "$lib/paths";
  import {
    deltaBetween,
    editsFor,
    filesystem,
    MappedDebouncer,
    provider,
    type Workspace,
  } from "$wsfs";
  import type { editor } from "monaco-editor";
  import { UserEdits, type UserEdit } from "./edits";
  import { cleaner } from "./utils";

  type LiveblocksClient = ReturnType<typeof createClient>;
  type LiveblocksRoom = ReturnType<LiveblocksClient["enterRoom"]>;

  export type NonModelEditorProps = Omit<Editor.Props, "file">;

  /**
   * Everything an open file's editor is wired with.
   *
   * `onUserEdit` is separated from the editor's own props because it is not
   * one: it is answered by `UserEdits`, which only exists once there is an
   * editor to watch, and it names the person at the keyboard rather than
   * every change the model reports.
   */
  export type EditorHooks = NonModelEditorProps & {
    onUserEdit?: (edit: UserEdit) => void;
  };

  const typingDebouncer = new MappedDebouncer({
    idleMs: 500,
    maxWaitMs: 2000,
  });

  export class OpenFile {
    readonly id: Id;
    readonly liveblocks: LiveblocksClient;
    readonly editorProps: EditorHooks;
    readonly workspace: Workspace;

    sharedText = $state<SharedTextFile>();
    path = $state("");

    constructor(
      { id, path }: FileTreeModel.Entry,
      liveblocks: LiveblocksClient,
      editorProps: EditorHooks,
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
    readonly doc: Y.Doc;
    readonly room: LiveblocksRoom;
    /**
     * changes to get things working just for UI demo purposes
     */
    //readonly provider: LiveblocksYjsProvider;
    readonly props: NonModelEditorProps;
    readonly initialContent: string;

    readonly cleanup = cleaner();

    status = $state<Status>();
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
      liveblocks: LiveblocksClient,
      props: EditorHooks,
      workspace: Workspace,
    ) {
      this.id = id;
      this.initialContent = content;
      this.workspace = workspace;
      this.room = liveblocks.enterRoom(id);
      /**
       * changes to get things working just for UI demo purposes
       */
      //this.provider = getYjsProviderForRoom(this.room.room);
      this.doc = new Y.Doc(); // this.provider.getYDoc();
      this.parent = new PsuedoParent(holderOf(path));
      this.file = new Editor.Model({
        name: nameOf(path),
        parent: this.parent,
        source: content,
      });
      /**
       * changes to get things working just for UI demo purposes
       */
      this.doc.getText(id);

      // this.cleanup.add(
      //   this.room.room.subscribe("status", (status) => {
      //     this.status = status;
      //     if (status !== "connected" || this.file.sourceSync) return;
      //     this.file.sourceSync = this.doc.getText("content");
      //     this.userEdits?.dispose();
      //     if (this.editor)
      //       this.userEdits = new UserEdits(this.editor, this.file.sourceSync);
      //   }),
      // );
      const { onUserEdit, ...editorProps } = props;
      this.props = {
        ...editorProps,
        onEditor: (editor) => {
          this.editor = editor;
          const disposable = editorProps.onEditor?.(editor);
          this.userEdits?.dispose();
          const userEdits = new UserEdits(this.editor, this.file.sourceSync);
          // Not unsubscribed on its own: disposing a `UserEdits` clears its
          // listeners, and this one outlives nothing else.
          if (onUserEdit) userEdits.subscribe({ edited: onUserEdit });
          this.userEdits = userEdits;
          return {
            dispose: () => {
              disposable?.dispose();
              userEdits?.dispose();
            },
          };
        },
      };
    }

    /**
     * Stores a version now, and stops being dirty.
     *
     * Clearing first is deliberate: a keystroke landing while the write is in
     * flight has to leave this dirty again, and it will.
     */
    store() {
      const { id, file, source } = this;
      typingDebouncer.clear(id);
      this.dirty = false;
      const { transaction } = this.workspace.write(file.path, source);
      return transaction;
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
      if (yText)
        this.doc.transact(() => {
          for (const edit of editsFor(deltaBetween(this.source, value)))
            if ("insert" in edit) yText.insert(edit.at, edit.insert);
            else yText.delete(edit.at, edit.remove);
        });
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
      this.room.leave();
      //this.provider.destroy();
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
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import FolderTreeIcon from "@lucide/svelte/icons/folder-tree";
  import { InView } from "./inview.svelte";
  import PanelHeading from "./shell/PanelHeading.svelte";
  import Assistant from "./assistant/Assistant.svelte";
  import { Conversation } from "./assistant/conversation.svelte";
  import { Nudge } from "./assistant/nudge";
  import type { Outcome } from "./Runner.svelte";

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

  const conversation = new Conversation();
  const nudge = new Nudge();

  /**
   * What the assistant is asked on the person's behalf when they take the
   * offer of help. It quotes the failure, because "help me" on its own says
   * less than the traceback already on screen does.
   */
  const stuckOn = ({ because }: Extract<Outcome, { ok: false }>) =>
    `My last run ended in an error:\n\n\`\`\`\n${because}\n\`\`\`\n\nCan you help me work out why?`;

  const snippets = { explorer, dock, assistant };
  const tabs = { file: FileView };
  type Grid = ViewAPI<"grid", typeof snippets>;

  const cleanup = cleaner();

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
          if (!open.sharedText?.dirty) continue;
          const transaction = open.sharedText?.store();
          stored.set(entry, transaction);
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
        { snapshot, conversation },
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
        //if (!sharedText?.ready) return false; // dropped ready as I was mid-trying to have sync happen after a doc loaded,
        // but ultimately concluded that was the WRONG way. if ready is necessary, you can add it back into your design

        // Only if it actually said something new. The editor writes what it
        // is showing back through here as it opens a file, and storing that
        // would be a version identical to the one before it -- which is waste
        // at best, and at worst a second write racing the first with the same
        // token to present.
        if (sharedText?.forceReplace(value))
          openFiles.get(id)?.sharedText?.store();
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

    /** The paths the person can see, which is what a question carries. */
    const inViewPaths = () => snapshot().visible.map(({ path }) => path);

    /**
     * A run that ended badly is the only reason to offer help, and typing
     * again is the only reason needed to withdraw it.
     */
    const finished = (outcome: Outcome) => {
      if (outcome.ok) return nudge.withdraw();
      nudge.offer(() => conversation.ask(stuckOn(outcome), inViewPaths()));
    };

    const editorProps: EditorHooks = {
      onEditor,
      onUserEdit: () => nudge.withdraw(),
    };

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
            const opened = new OpenFile(
              entry,
              liveblocks,
              editorProps,
              workspace,
            );
            openFiles.set(id, opened);
            await tabsAPI.addComponentPanel(
              "file",
              { opened, kernelPool, workspace, onFinished: finished },
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

  onDestroy(() => {
    cleanup();
    conversation.dispose();
    nudge.withdraw();
  });
</script>

{#snippet explorer({
  params: { model },
}: PanelProps<"grid", { model: FileTreeModel }>)}
  <section
    class="bg-sidebar grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r"
    data-region="explorer"
  >
    <PanelHeading label="Explorer" icon={FolderTreeIcon} />
    <FileTree {model} />
  </section>
{/snippet}

{#snippet dock({
  params: { onready },
}: PanelProps<
  "grid",
  { onready: (api: ViewAPI<"dock", typeof tabs>) => void }
>)}
  <div class="h-full min-h-0 w-full min-w-0" data-region="documents">
    <DockView
      theme={appearance.theme}
      components={tabs}
      watermark={{ snippet: nothingOpen }}
      onReady={({ api }) => onready(api)}
    />
  </div>
{/snippet}

{#snippet nothingOpen()}
  <div
    class="bg-background text-muted-foreground grid h-full w-full place-items-center gap-2 text-sm"
    data-region="nothing-open"
  >
    <div class="flex flex-col items-center gap-2">
      <FileTextIcon class="size-6" />
      Open a file from the explorer.
    </div>
  </div>
{/snippet}

{#snippet assistant({
  params: { snapshot, conversation },
}: PanelProps<
  "grid",
  { snapshot: () => Snapshot; conversation: Conversation }
>)}
  <div class="h-full min-h-0 border-l">
    <Assistant
      {conversation}
      attached={snapshot().visible.map(({ path }) => path)}
    />
  </div>
{/snippet}

<div class="bg-background h-full min-h-0 w-full {chrome}" data-region="shell">
  <GridView
    {snippets}
    orientation={Orientation.HORIZONTAL}
    proportionalLayout={false}
    onReady={({ api }) => onAPI(api)}
  />
</div>
