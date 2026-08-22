<script lang="ts">
  import { onDestroy } from "svelte";

  import Workspace from "$lib/Workspace.svelte";
  import { solo } from "$lib/liveblocks";
  import { connect, http, keeping, type Workspace as Client } from "$wsfs";
  import { createClient } from "@liveblocks/client";

  const USER = "ada@example.com";
  const BACKEND = "/wsfs";

  /** The sample's stand-in for a session. A real host sends a cookie. */
  const asUser = (email: string) => async () => ({ "X-User-Email": email });

  /**
   * Collaboration is opt-in: with a key, files are shared with whoever else
   * has the workspace open; without one the editor still works and still
   * saves, it is simply the only one in the room.
   */
  const key = import.meta.env.VITE_LIVEBLOCKS_KEY as string | undefined;
  const liveblocks = key ? createClient({ publicApiKey: key }) : solo();

  let workspace = $state<Client | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);

  const project = async (email: string) => {
    const response = await fetch("/projects", {
      method: "POST",
      headers: { "X-User-Email": email },
    });
    if (!response.ok) throw new Error(`could not open a project: ${response.status}`);
    return ((await response.json()) as { id: string }).id;
  };

  const start = async () => {
    try {
      const id = await project(USER);
      /**
       * Read before anything is served. A client that started answering reads
       * and then found it had queued work would have shown a view missing its
       * own -- so the queue is restored first, and `connect` is handed it.
       */
      const held = await keeping(id);
      workspace = connect({
        workspace: id,
        transport: http(BACKEND, asUser(USER)),
        bytes: held.bytes,
        kept: held.kept,
        restored: held.restored,
      });
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    }
  };

  void start();
  onDestroy(() => workspace?.stop());
</script>

<!-- The shell fills whatever it is given, so the page is what says "all of
     it" -- a test gives it a card-sized box instead. -->
<div class="page">
  {#if failure}
    <p class="failure">{failure}</p>
  {:else if workspace}
    <Workspace {workspace} {liveblocks} />
  {:else}
    <p class="waiting">Opening a workspace…</p>
  {/if}
</div>

<style>
  .page {
    height: 100dvh;
    width: 100%;
  }
  :global(body) {
    margin: 0;
  }
  .failure,
  .waiting {
    font: 0.9rem/1.5 ui-sans-serif, system-ui, sans-serif;
    padding: 1rem;
    color: var(--wsfs-muted, #6b7280);
  }
  .failure {
    color: #b91c1c;
  }
</style>
