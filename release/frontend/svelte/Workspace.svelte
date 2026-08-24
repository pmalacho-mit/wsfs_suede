<script lang="ts" module>
  import { createClient } from "@liveblocks/client";
  import type { Output } from "../../../wsfs_suede.python-web-kernel-suede";
  import { Editor } from "../../../wsfs_suede.python-monaco-suede";
  import { nameOf, holderOf } from "./paths";
  import { filesystem, MappedDebouncer, provider, type Workspace } from "../";
  import {
    become,
    Rooms,
    type Enter,
    type Room,
    type Sending,
    type Written,
  } from "./room.svelte";
  import { enteringWith, hostedIn, persisting } from "./collaborator";
  import type { editor } from "monaco-editor";
  import { UserEdits, type UserEdit } from "./edits";
  import { cleaner } from "./utils";

  type LiveblocksClient = ReturnType<typeof createClient>;

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
    readonly rooms: Rooms;
    readonly editorProps: EditorHooks;
    readonly workspace: Workspace;

    sharedText = $state<SharedTextFile>();
    path = $state("");

    constructor(
      { id, path }: FileTreeModel.Entry,
      rooms: Rooms,
      editorProps: EditorHooks,
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

  /** One run of this file, and what it produced. */
  export type Execution = {
    at: string;
    outputs: Output.Specific[];
    ok: boolean;
    /** What the kernel said if it ended badly and did not say so in outputs. */
    failure?: string;
  };

  export class SharedTextFile {
    readonly id: Id;
    readonly workspace: Workspace;
    readonly file: Editor.Model;
    readonly parent: PsuedoParent;
    readonly props: EditorHooks;
    readonly initialContent: string;

    /** Every room the containing workspace holds -- one event stream feeds all of them. */
    readonly rooms: Rooms;

    /**
     * Every run of this file, oldest first.
     */
    executions = $state<Execution[]>([]);

    /**
     * The protocol, shared with the two-browser suite.
     *
     * Undefined until the room has synced AND reconciled, which is also how
     * anything rendering this knows not to show an editor yet.
     */
    shared = $state<Room>();

    /** The room being opened, before `shared` is answered for. */
    opening = $state<Room>();

    readonly cleanup = cleaner();

    editor = $state<editor.IStandaloneCodeEditor>();
    userEdits = $state<UserEdits>();

    /**
     * Whether this holds anything that has NOT been submitted as a version.
     *
     * The question it answers is "does what the user is looking at exist
     * anywhere else yet" -- which is what anything about to send this file
     * somewhere needs to know, so it can store first.
     */
    dirty = $state(false);

    constructor(
      id: Id,
      path: string,
      content: string,
      rooms: Rooms,
      props: EditorHooks,
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
      this.opening = rooms.get(id);
      void rooms
        .open(id)
        .then((room) => {
          if (this.#disposed) return;
          this.#carryInWhatWasTypedWhileOpening(room);
          this.shared = room;
          this.file.sourceSync = room.text;
          this.userEdits?.attach(room.text);
          /**
           * And store it, because the store it already asked for was refused.
           *
           * Typing enqueues a debounced store, and a store made before the
           * room is open is answered "the room is not open yet" and held --
           * correctly, since there was nowhere to put it. But nothing asked
           * again. The file stayed dirty until the person typed one more
           * character, and if they did not, what they had written sat in a
           * model on one machine: not on the server, not in the room, not in
           * a draft, and gone with the tab.
           *
           * Opening is the moment that stops being true, so it is the moment
           * to ask again.
           */
          if (this.dirty) void this.store();
        })
        /**
         * A room that never syncs leaves the editor on the content the
         * workspace handed it, unshared and unbound -- which is a worse
         * experience than collaborating and a much better one than an empty
         * file. `sourceSync` stays undefined, so `source` falls back to the
         * model, and `store` answers that it was held.
         */
        .catch((reason) => {
          /**
           * Silent when the registry has gone: the open was interrupted by
           * the workspace being put away, and there is nobody left to show
           * the document to. Anything else is worth saying.
           */
          if (rooms.gone) return;
          console.error(`room ${id} did not open`, reason);
        });

      const { onUserEdit, ...editorProps } = props;
      this.props = {
        ...editorProps,
        onEditor: (editor) => {
          this.editor = editor;
          const disposable = editorProps.onEditor?.(editor);
          const userEdits = this.#watching(editor, onUserEdit);
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
     * Typing that happened while the room was still opening.
     *
     * Opening is two round trips and a socket, and a person who opens a file
     * and types straight away is typing into a model that is bound to
     * nothing yet. `MonacoBinding` makes the model say whatever the `Y.Text`
     * says the moment it is constructed -- so without this, that typing is
     * not lost slowly or quietly at the far end. It is discarded on screen,
     * at the moment collaboration starts, in front of the person who typed
     * it, and the only sign is that the characters go away.
     *
     * Carried in as EDITS rather than as a value, because the document is the
     * shared one: what arrives has to be the insertions it actually was, so
     * that everybody else's copy merges them rather than being overwritten.
     *
     * ONLY WHEN THE ROOM STILL SAYS WHAT THIS EDITOR OPENED ON. Then the
     * difference between the two is this person's typing and nothing else,
     * which is the whole reason replaying it is safe. If the room is somewhere
     * else -- somebody stored while this was opening, or it is holding work
     * from a session that closed before a store landed -- then the difference
     * is their text as well, and replaying it would carry theirs away. That
     * case is left as it was: the room wins, because it is the only one of
     * the two that more than one person can see.
     */
    #carryInWhatWasTypedWhileOpening(room: Room) {
      if (!this.dirty) return;
      const typed = this.editor?.getModel()?.getValue();
      if (typed === undefined) return;
      const holds = room.text.toString();
      if (holds === typed || holds !== this.initialContent) return;
      become(room.text, typed);
    }

    /**
     * What the person at this keyboard did, and what it costs.
     */
    #watching(
      editor: editor.IStandaloneCodeEditor,
      announce?: (edit: UserEdit) => void,
    ): UserEdits {
      this.userEdits?.dispose();
      const userEdits = new UserEdits(editor, this.file.sourceSync);
      this.userEdits = userEdits;
      userEdits.subscribe({
        edited: (edit) => {
          this.dirty = true;
          typingDebouncer.enqueue(this.id, () => this.store());
          announce?.(edit);
        },
      });
      return userEdits;
    }

    /**
     * Stores a version now, and stops being dirty.
     */
    store(): Promise<Written> {
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
          ? {
              held: true,
              why: "the room is not open yet",
              draft: null,
              settled: null,
            }
          : room.send();
      /**
       * Cleared once the text has left this machine, whichever way it left.
       */
      if (!sent.held || sent.draft !== null) {
        typingDebouncer.clear(id);
        this.dirty = false;
      }
      return sent;
    }

    /** The transaction a snapshot can name for this file, if there is one. */
    /**
     * The version this file's text was put on the server as, whichever way.
     *
     * Undefined only when there was no text to put anywhere.
     */
    storing(): string | undefined {
      const sent = this.send();
      return sent.held ? (sent.draft ?? undefined) : sent.transaction;
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

    /**
     * Put away anything typed here that is not anywhere else yet.
     *
     * Closing a tab is not a decision to throw work away, and this is the one
     * moment where it was: what a person types lives in the editor's model
     * until a document holds it, and the model goes with the panel.
     *
     * WHEN A DOCUMENT HOLDS IT this is one ordinary store -- the text is
     * already in the shared document, so there is nothing to carry and no
     * question of clobbering anybody.
     *
     * WHEN NONE DOES YET, which is the fast case -- opened, typed and shut
     * inside the second or so a room takes to open -- the text is in the
     * model and nowhere at all. It cannot go by the ordinary write, because a
     * document is on its way and writing around one is refused. So it goes
     * the way the document itself would have sent it: this panel is, at this
     * instant, the only thing holding the file's text, which is exactly what
     * `shares` is for.
     *
     * Not awaited, because a closing panel has nothing to wait with. It does
     * not need to: the transaction is in the durable outbox before this
     * returns, and the outbox is what promises delivery.
     */
    keepWhatWasTyped() {
      if (!this.dirty) return;
      if (this.shared !== undefined) return void this.store();
      const typed = this.editor?.getModel()?.getValue();
      if (typed === undefined || typed === this.initialContent) return;
      void this.workspace
        .shares(this.id, typed)
        .settled.catch(() => undefined);
      /**
       * No longer holding anything nobody else has. The transaction is in the
       * outbox, which is a better place than this model -- and saying so
       * matters when the page does not actually go after all, as a page put
       * into the back/forward cache and then come back to has not.
       */
      typingDebouncer.clear(this.id);
      this.dirty = false;
    }

    dispose() {
      if (this.#disposed) return;
      this.keepWhatWasTyped();
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
  export type EntrySnapshot = {
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
    /** How far opening this file's room has got. Diagnostic. */
    stage: string;
    /** Whether this file's editor is being watched for the user's own edits. */
    watching: boolean;
    /** Whether this file's room may write it back right now. Diagnostic. */
    speaks: boolean;
    /**
     * How many runs of this file go with it.
     *
     * On the snapshot rather than counted where it is shown, so the thing
     * that DECIDES what accompanies a question and the thing that displays it
     * read one number.
     */
    executions: number;
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
    entries: EntrySnapshot[];
    /** The subset the user can actually see, which is the useful default. */
    visible: EntrySnapshot[];
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
  } from "../../../wsfs_suede.dockview-svelte-suede";
  import "wsfs_suede.dockview-svelte-suede/styles/dockview.css";
  import { LayoutPriority } from "dockview";
  import FileTree, { Model as FileTreeModel, type Id } from "./FileTree.svelte";
  import { appearance } from "./appearance.svelte";
  import FileView from "./FileView.svelte";
  import { onDestroy } from "svelte";
  import type { FileOverride } from "../adapters";
  import { Kernel } from "../../../wsfs_suede.python-web-kernel-suede";
  import { WarmPool } from "./pool";
  import fs from "../../../wsfs_suede.python-web-kernel-suede/fs";
  import { FileText, FolderTree } from "@lucide/svelte";
  import { InView } from "./inview.svelte";
  import PanelHeading from "./shell/PanelHeading.svelte";
  import Assistant from "./assistant/Assistant.svelte";
  import { Conversation } from "./assistant/conversation.svelte";
  import { Nudge } from "./assistant/nudge";
  import type { Outcome } from "./Runner.svelte";

  let {
    workspace,
    liveblocks,
    entering,
    onEditor,
    onSnapshot,
  }: {
    workspace: Workspace;
    liveblocks: LiveblocksClient;
    /**
     * How a room joins the shared document, for a caller that has to say.
     *
     * `Provider` is this codebase's own type, not Liveblocks', and two of its
     * members -- whether this client is holding changes, and waiting until it
     * is not -- are questions a real provider answers about a real
     * connection. A test that wants to say "given a room reaching nobody"
     * has to be able to answer them itself, and no amount of pretending to
     * be a Liveblocks room lets it.
     */
    entering?: Enter;
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

    /**
     * One registry for the whole workspace, and therefore ONE subscription to
     * the stream feeding every room. A room that subscribed for itself would
     * have to be open before it could hear anything -- which is exactly the
     * case `rooms.opening` exists to cover, and would leave every file that
     * was ever closed and reopened quietly behind.
     */
    const rooms = new Rooms(
      workspace,
      entering ?? enteringWith(liveblocks),
      hostedIn(workspace),
      persisting,
    );

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
           * would describe a later one.
           *
           * A room that is holding its writes still names one: the draft the
           * text went into. That is the whole point of drafts -- the server
           * can rebuild it, so a snapshot naming it is as portable as one
           * naming a version. Only text that went nowhere at all leaves an
           * entry dirty here.
           */
          const transaction = shared.storing();
          if (transaction !== undefined) stored.set(entry, transaction);
        }

      const index = workspace.index();
      // Copied up front: reading the set is what makes a live view of this
      // re-render, and reading it per entry would not happen at all in a
      // workspace that is still empty.
      const showing = new Set(inView.showing);
      const entries: EntrySnapshot[] = [];
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
          stage: open?.sharedText?.rooms?.get(entry.id)?.opening ?? "no room",
          watching: open?.sharedText?.userEdits !== undefined,
          speaks: open?.sharedText?.rooms?.get(entry.id)?.speaks === true,
          executions: open?.sharedText?.executions.length ?? 0,
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
        /**
         * The editor writing back what it is already showing.
         *
         * It does this as it opens a file, and storing it is never right. At
         * best it is a version identical to the one before it. At worst --
         * and this is the one that cost somebody a line -- a write of this
         * person's own is still in flight, so what the panel opened on is the
         * text from BEFORE it, and putting that back is that write undone by
         * the act of looking at the file.
         *
         * Taken and dropped rather than passed on, because there is nothing
         * in it: it is a copy of what this panel is holding. A write that
         * says something new -- a script's, an assistant's -- is not this,
         * and goes on down.
         */
        if (sharedText !== undefined && value === sharedText.source) return true;
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
       * The remote case reaches the same conclusion by a different route: a
       * write from another client arrives over the stream and the room finds
       * out by READING the file, because nothing in a token says whether it
       * names text or bytes. This is that conclusion reached one step
       * earlier, by a caller already holding the bytes.
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

    /**
     * A run, recorded: a snapshot of what the person could see, and then the
     * output against it. Both are transactions, so both go through the outbox
     * and survive being offline -- which is the only reason either is worth
     * recording at all.
     *
     * The snapshot is taken as the run STARTS, because that is the state the
     * output is evidence about; taking it afterwards would name whatever the
     * file had become by then.
     */
    const started = async ({
      entry,
      result,
    }: {
      entry: string | undefined;
      at: string;
      result: Promise<Outcome>;
    }) => {
      if (entry === undefined) return;
      const showing = snapshot().visible.map((held) => held.entry);
      const taken = workspace.snapshot(
        showing.includes(entry) ? showing : [entry, ...showing],
      );
      const outcome = await result;
      const open = openFiles.get(entry)?.sharedText;
      const outputs = open?.executions.at(-1)?.outputs ?? [];
      /**
       * Awaited so a snapshot that was refused -- naming a version the server
       * never issued -- does not leave an execution pointing at nothing.
       */
      const kept = await taken.settled;
      if (kept.rejected) return;
      void workspace.executed(entry, taken.transaction, outputs, outcome.ok);
    };

    const editorProps: EditorHooks = {
      onEditor,
      onUserEdit: () => nudge.withdraw(),
    };

    /**
     * The page going away is a close that nobody clicked.
     *
     * A panel being shut is where unsaved typing is put away, and nothing
     * shuts the panels when the whole page goes -- but "I typed the last bit
     * and then closed the browser" is an ordinary way to stop working, and it
     * has to keep the last bit.
     *
     * `pagehide` rather than `beforeunload`, for the reason the debouncer
     * gives: registering `beforeunload` disqualifies the page from the
     * back/forward cache in several browsers, and this needs no prompt.
     */
    const keepWhatNobodySaved = () =>
      openFiles.forEach((open) => open.sharedText?.keepWhatWasTyped());
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", keepWhatNobodySaved);
      cleanup.add(() =>
        window.removeEventListener("pagehide", keepWhatNobodySaved),
      );
    }

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
              {
                opened,
                kernelPool,
                workspace,
                onFinished: finished,
                onRun: started,
              },
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
    <PanelHeading label="Explorer" icon={FolderTree} />
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
      <FileText class="size-6" />
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
  <div class="h-full min-h-0 border-l" data-region="assistant">
    <Assistant
      {conversation}
      attached={snapshot().visible.map(({ path, executions }) => ({
        path,
        executions,
      }))}
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
