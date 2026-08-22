<script lang="ts">
  import { onDestroy } from "svelte";

  import Workspace from "$lib/Workspace.svelte";
  import WorkspaceFrame from "$lib/shell/WorkspaceFrame.svelte";
  import { solo } from "$lib/liveblocks";
  import { connect, http, inMemory, type Workspace as Client } from "$wsfs";
  import { createClient } from "@liveblocks/client";

  const USER = "ada@example.com";
  const BACKEND = "/wsfs";

  /** What this page is looking at. A real host reads it off the route. */
  const TITLE = "Workspace Example";
  const EVENT = "Example";
  const COURSE = "Example";

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
      workspace = connect({
        workspace: await project(USER),
        transport: http(BACKEND, asUser(USER)),
        bytes: inMemory(),
      });
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    }
  };

  void start();
  onDestroy(() => workspace?.stop());
</script>

<!-- The frame fills whatever it is given, so the page is what says "all of
     it" -- a test gives it a card-sized box instead. -->
<div class="h-dvh w-full">
  <WorkspaceFrame title={TITLE} event={EVENT} course={COURSE}>
    {#if failure}
      <p class="text-destructive p-4 text-sm">{failure}</p>
    {:else if workspace}
      <Workspace {workspace} {liveblocks} />
    {:else}
      <p class="text-muted-foreground p-4 text-sm">Opening a workspace…</p>
    {/if}
  </WorkspaceFrame>
</div>
