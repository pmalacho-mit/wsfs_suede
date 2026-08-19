<script lang="ts">
  /**
   * The layout: the filesystem down the left, open files as tabs in the
   * middle. Dockview owns the arrangement; this owns only which panels exist,
   * which is one rule -- a path opens at most one panel, and selecting it
   * again brings that one forward.
   */
  import { DockView, type ViewAPI } from "wsfs_suede.dockview-svelte-suede";


  import FileView from "$lib/FileView.svelte";
  import Tree from "$lib/Tree.svelte";
  import type { Open } from "$lib/workspace.svelte";

  let { workspace }: { workspace: Open } = $props();

  type Api = ViewAPI<"dock", { tree: typeof Tree; file: typeof FileView }>;

  let dock = $state<Api | undefined>(undefined);
  let dark = $state(false);

  /** The dock paints its own chrome, so it has to be told which way to go. */
  $effect(() => {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => (dark = scheme.matches);
    follow();
    scheme.addEventListener("change", follow);
    return () => scheme.removeEventListener("change", follow);
  });

  const theme = $derived(dark ? "githubDark" : "githubLight");

  const panelFor = (path: string) => `file:${path}`;

  const open = (path: string) => {
    if (!dock) return;
    const already = dock.getPanel(panelFor(path));
    if (already) return already.api.setActive();
    dock.addPanel({
      id: panelFor(path),
      component: "file",
      title: path.split("/").pop() ?? path,
      params: { workspace, path },
    });
  };

  const laidOut = (api: Api) => {
    dock = api;
    api.addPanel({
      id: "tree",
      component: "tree",
      title: "Files",
      params: { workspace, onopen: open },
    });
  };
</script>

<div class="shell">
  <DockView
    {theme}
    components={{ tree: Tree, file: FileView }}
    onReady={({ api }) => laidOut(api as Api)}
  />
</div>

<style>
  .shell {
    height: 100dvh;
    width: 100%;
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
</style>
