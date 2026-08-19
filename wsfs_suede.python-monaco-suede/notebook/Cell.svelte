<script lang="ts" module>
  import EditorComponent, { type OnEditor } from "../Editor.svelte";
  import type { EditableFile } from "../models.svelte";

  export type Props = {
    file: EditableFile;
    size?: number;
    minHeight?: number;
  };
</script>

<script lang="ts">
  let { file, size = 14, minHeight = 40 }: Props = $props();

  let host = $state<HTMLElement>();

  const fitToContent = (editor: Parameters<OnEditor>[0]) => {
    if (!host) return;
    host.style.height = `${Math.max(minHeight, editor.getContentHeight())}px`;
    editor.layout();
  };

  const grow: OnEditor = (editor) => {
    editor.updateOptions({
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      overviewRulerLanes: 0,
    });
    fitToContent(editor);
    return editor.onDidContentSizeChange(() => fitToContent(editor));
  };
</script>

<div bind:this={host} style:width="100%">
  <EditorComponent {file} {size} onEditor={grow} />
</div>
