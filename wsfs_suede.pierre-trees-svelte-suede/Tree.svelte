<script lang="ts" module>
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import type { ContextMenuItem, ContextMenuOpenContext } from "@pierre/trees";
  import type { Model } from "./model.svelte";
  import type { Variables } from "./variables";

  export type Props = Omit<HTMLAttributes<HTMLElement>, "children"> &
    Variables & {
      model: Model;
      header?: Snippet;
      contextMenu?: Snippet<
        [item: ContextMenuItem, context: ContextMenuOpenContext]
      >;
    };
</script>

<script lang="ts">
  import { composedWithSlots, type ContextMenuTrigger } from "./composition";
  import { asStyle, partition } from "./variables";

  let { model, header, contextMenu, style, ...rest }: Props = $props();

  let container = $state<HTMLElement>();
  let trigger = $state<ContextMenuTrigger>();

  // `--x="y"` on a component is compiled into an inherited declaration rather
  // than a prop, so these only arrive when spread; both routes reach the tree.
  const { declarations, attributes } = $derived(partition(rest));

  const baseline = $derived(model.tree.getComposition());

  const composition = $derived(
    composedWithSlots(baseline, {
      header: header !== undefined,
      contextMenu: contextMenu && {
        opened: (opened) => (trigger = opened),
        closed: () => (trigger = undefined),
      },
    }),
  );

  $effect(() => {
    model.tree.setComposition(composition);
  });

  $effect(() => {
    if (!container) return;
    const unmount = model.mount(container);
    return () => {
      unmount();
      model.tree.setComposition(baseline);
    };
  });
</script>

<file-tree-container
  bind:this={container}
  {...attributes}
  style={asStyle(declarations, style)}
  style:--trees-item-height="{model.tree.getItemHeight()}px"
  style:--trees-density-override={model.tree.getDensityFactor()}
>
  {#if header}
    <div slot="header">{@render header()}</div>
  {/if}
  {#if contextMenu && trigger}
    <div slot="context-menu">
      {@render contextMenu(trigger.item, trigger.context)}
    </div>
  {/if}
</file-tree-container>
