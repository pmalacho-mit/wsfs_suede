<script lang="ts">
  /**
   * What goes with the next message.
   *
   * Named rather than counted, and shown against the input rather than in the
   * transcript, because the question it answers is asked before sending: is
   * the thing I am about to ask about actually in front of me?
   */
  import PaperclipIcon from "@lucide/svelte/icons/paperclip";
  import { Badge } from "../shadcn/ui/badge";
  import * as Tooltip from "../shadcn/ui/tooltip";
  import { nameOf } from "../paths";

  let { paths }: { paths: string[] } = $props();
</script>

<div
  class="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1 text-xs"
  data-region="attached-files"
>
  <PaperclipIcon class="size-3.5 shrink-0" />
  {#each paths as path (path)}
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Badge
              {...props}
              variant="secondary"
              class="max-w-40 font-mono"
              data-path={path}
            >
              <span class="truncate">{nameOf(path)}</span>
            </Badge>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="top" class="font-mono">{path}</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  {:else}
    <span data-region="attached-none">no files in view</span>
  {/each}
</div>
