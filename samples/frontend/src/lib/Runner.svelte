<script lang="ts">
  /**
   * The terminal that belongs to one file.
   *
   * The kernel reads the workspace through the same filesystem the editor
   * writes to, so running a file runs what is on screen -- including imports
   * of siblings nobody has saved by hand.
   */
  import { snippets, type Output } from "wsfs_suede.python-web-kernel-suede";

  import type { Open } from "$lib/workspace.svelte";

  let { workspace, path }: { workspace: Open; path: string } = $props();

  let outputs = $state<Output.Specific[]>([]);
  let running = $state<{ interrupt: () => void } | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);

  const run = async () => {
    if (running) return;
    failure = undefined;
    outputs = [];
    const code = await workspace.workspace.read(path);
    if (code === undefined || code.kind !== "text") {
      failure = `Nothing to run in ${path}`;
      return;
    }
    const job = workspace.kernel().run({
      code: code.text,
      path,
      on: { output: (output) => (outputs = [...outputs, output]) },
    });
    running = job;
    try {
      await job.result;
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    } finally {
      running = undefined;
    }
  };
</script>

<section class="runner">
  <header>
    <button onclick={run} disabled={!!running}>{running ? "Running…" : "Run"}</button>
    {#if running}
      <button onclick={() => running?.interrupt()}>Stop</button>
    {/if}
    <button onclick={() => (outputs = [])} disabled={outputs.length === 0}>Clear</button>
    <span class="path">{path}</span>
  </header>
  <output>
    {#each outputs as produced}
      {@render snippets.output.any(produced)}
    {:else}
      <span class="idle">Run to see output.</span>
    {/each}
    {#if failure}<span class="failure">{failure}</span>{/if}
  </output>
</section>

<style>
  .runner {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 0;
    border-top: 1px solid var(--wsfs-line, #e5e7eb);
    background: var(--wsfs-sunken, #fbfbfd);
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.5rem;
  }
  button {
    font: 500 0.75rem/1 ui-sans-serif, system-ui, sans-serif;
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--wsfs-line, #e5e7eb);
    border-radius: 6px;
    background: var(--wsfs-raised, #fff);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .path {
    margin-left: auto;
    font: 0.7rem/1 ui-monospace, monospace;
    color: var(--wsfs-muted, #6b7280);
  }
  output {
    display: block;
    overflow: auto;
    padding: 0.5rem 0.75rem 0.75rem;
    font: 0.78rem/1.55 ui-monospace, SFMono-Regular, monospace;
    white-space: pre-wrap;
  }
  .failure {
    display: block;
    color: #b91c1c;
  }
  .idle {
    color: var(--wsfs-muted, #9ca3af);
    font-style: italic;
  }
</style>
