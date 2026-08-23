<script lang="ts" module>
  import type { Output } from "../../../wsfs_suede.python-web-kernel-suede";

  /**
   * How a run ended, as anything downstream of it needs to know.
   *
   * `because` is there so that whoever reacts to a failure can say what
   * failed without going back to the outputs to work it out again.
   */
  export type Outcome = { ok: true } | { ok: false; because: string };

  const raised = (outputs: Output.Specific[]) =>
    outputs.find((output) => output.output_type === "error") as
      | Output.Error
      | undefined;

  const outcomeOf = (
    outputs: Output.Specific[],
    failure: string | undefined,
  ): Outcome => {
    if (failure !== undefined) return { ok: false, because: failure };
    const error = raised(outputs);
    if (error === undefined) return { ok: true };
    return { ok: false, because: `${error.ename}: ${error.evalue}` };
  };
</script>

<script lang="ts">
  /**
   * The terminal that belongs to one file.
   *
   * The kernel reads the workspace through the same filesystem the editor
   * writes to, so running a file runs what is on screen -- including imports
   * of siblings nobody has saved by hand.
   */
  import EraserIcon from "@lucide/svelte/icons/eraser";
  import PlayIcon from "@lucide/svelte/icons/play";
  import SquareIcon from "@lucide/svelte/icons/square";
  import { snippets } from "../../../wsfs_suede.python-web-kernel-suede";
  import { Button } from "./components/ui/button";
  import { Separator } from "./components/ui/separator";
  import type { KernelPool, SharedTextFile } from "./Workspace.svelte";

  let {
    kernelPool,
    shared,
    onFinished,
  }: {
    kernelPool: KernelPool;
    shared: Pick<SharedTextFile, "source"> & { file: { path: string } };
    /** Every run, as it ends. A refused run is not a run and is not reported. */
    onFinished?: (outcome: Outcome) => void;
  } = $props();

  let outputs = $state<Output.Specific[]>([]);
  let running = $state<{ interrupt: () => void } | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);

  const run = async () => {
    if (running) return;
    failure = undefined;
    outputs = [];

    kernelPool.use(async (kernel) => {
      const job = kernel.run({
        code: shared.source,
        path: shared.file.path,
        on: { output: (output) => (outputs = [...outputs, output]) },
      });
      running = job;
      try {
        await job.result;
      } catch (reason) {
        failure = reason instanceof Error ? reason.message : String(reason);
      } finally {
        running = undefined;
        onFinished?.(outcomeOf(outputs, failure));
      }
    });
  };
</script>

<section
  class="bg-sidebar grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] border-t"
  data-region="runner"
>
  <header class="flex h-9 shrink-0 items-center gap-1 px-2">
    {#if running}
      <Button
        size="xs"
        variant="destructive"
        onclick={() => running?.interrupt()}
      >
        <SquareIcon />
        Stop
      </Button>
    {:else}
      <Button size="xs" onclick={run} data-region="run">
        <PlayIcon />
        Run
      </Button>
    {/if}
    <Button
      size="xs"
      variant="ghost"
      onclick={() => (outputs = [])}
      disabled={outputs.length === 0}
    >
      <EraserIcon />
      Clear
    </Button>
    <Separator orientation="vertical" class="mx-1 h-4" />
    <span class="text-muted-foreground truncate font-mono text-[0.7rem]">
      {shared.file.path}
    </span>
  </header>
  <output
    class="block overflow-auto px-3 pb-3 font-mono text-[0.78rem] leading-relaxed whitespace-pre-wrap"
  >
    {#each outputs as produced}
      {@render snippets.output.any(produced)}
    {:else}
      <span class="text-muted-foreground italic">Run to see output.</span>
    {/each}
    <!-- Only when the outputs did not already say it: a kernel that raised
         reports it as an output AND rejects the job. -->
    {#if failure && raised(outputs) === undefined}
      <span class="text-destructive block">{failure}</span>
    {/if}
  </output>
</section>
