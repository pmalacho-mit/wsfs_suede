<script lang="ts">
  /**
   * What sits above a workspace: where you can go, what you are looking at,
   * and how it should be painted.
   *
   * The middle column names the workspace twice over -- once by its own name
   * and once by the course event it belongs to -- because the same workspace
   * exists for several events and the name alone does not say which.
   */
  import CircleHelpIcon from "@lucide/svelte/icons/circle-help";
  import { Button } from "$lib/components/ui/button";
  import { Separator } from "$lib/components/ui/separator";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import ModeToggle from "./ModeToggle.svelte";
  import { navigation } from "./navigation";

  let {
    title,
    event,
    course,
  }: { title: string; event: string; course: string } = $props();
</script>

<header
  class="bg-background/95 supports-[backdrop-filter]:bg-background/75 grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b px-3 backdrop-blur"
  data-region="header"
>
  <nav class="flex items-center gap-1" aria-label="Workspace navigation">
    {#each navigation as destination (destination.label)}
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="ghost"
                size="icon-sm"
                aria-label={destination.label}
                onclick={destination.go}
              >
                <destination.icon />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="bottom">{destination.label}</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    {/each}
  </nav>

  <div class="flex min-w-0 flex-col items-center text-center" data-region="workspace-identity">
    <h1 class="truncate text-sm leading-tight font-semibold">{title}</h1>
    <p class="text-muted-foreground truncate text-xs leading-tight">
      Course event {event}: Course {course}
    </p>
  </div>

  <div class="flex items-center justify-end gap-1">
    <Button variant="ghost" size="icon-sm" aria-label="Help">
      <CircleHelpIcon />
    </Button>
    <Separator orientation="vertical" class="mx-1 h-5" />
    <ModeToggle />
  </div>
</header>
