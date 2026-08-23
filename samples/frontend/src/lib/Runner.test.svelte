<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import Runner, { type Outcome } from "./Runner.svelte";
  import { WarmPool } from "../../../../release/frontend/components/pool";
  import { Kernel } from "wsfs_suede.python-web-kernel-suede";
  import fs from "wsfs_suede.python-web-kernel-suede/fs";
  import { nameOf } from "$lib/paths";

  /** Unclosed on purpose: the point is a run that ends badly. */
  const BROKEN = `print("hello world"`;

  const ROOT = "/home/pyodide";

  class Pocket {
    source = $state(BROKEN);
    outcome = $state<Outcome>();
    file = { path: "example.py" };

    /** One file, so the run fails on the code rather than on an empty disk. */
    readonly held = new Map([[`${ROOT}/example.py`, BROKEN]]);

    readonly pool = new WarmPool<Kernel>({
      create: () =>
        new Kernel({
          fs: fs.readWrite({
            root: ROOT,
            get: (path) => this.held.get(path),
            listDirectory: (path) =>
              path === ROOT ? [...this.held.keys()].map(nameOf) : [],
            put: (path, value) =>
              typeof value === "string"
                ? void this.held.set(path, value)
                : void this.held.delete(path),
          }),
          input: async (prompt) => window.prompt(prompt) ?? "",
        }),
    });
  }
</script>

<Sweater config category="Runner" />

<Sweater
  name="reports a run that ended badly to whoever is listening"
  body={async ({
    set,
    container,
    expect,
    capture,
    delay,
    definition,
    withUserFocus,
  }) => {
    const pocket = set(new Pocket());
    await delay({ frames: 2 });
    await capture("png").uri;

    const run = container.querySelector("[data-region='run']") as HTMLElement;
    await withUserFocus(async (user) => user.click(run));

    const { outcome } = await definition("outcome");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.because).toContain(
      "SyntaxError: '(' was never closed",
    );
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-full w-full">
      <Runner
        shared={pocket}
        kernelPool={pocket.pool}
        onFinished={(outcome) => (pocket.outcome = outcome)}
      />
    </div>
  {/snippet}
</Sweater>
