<script lang="ts" module>
  import "@codingame/monaco-vscode-python-default-extension";
  import { MonacoEditorLanguageClientWrapper } from "monaco-editor-wrapper";
  import { configureDefaultWorkerFactory } from "monaco-editor-wrapper/workers/workerLoaders";
  import * as monaco from "monaco-editor";
  import { MonacoBinding } from "y-monaco";
  import { untrack } from "svelte";
  import type { EditableFile } from "./models.svelte";
  import { prepare } from "./workspace";

  export type OnEditor = (
    editor: monaco.editor.IStandaloneCodeEditor,
  ) => monaco.IDisposable;

  type Attachable = Pick<EditableFile, "path" | "source" | "sourceSync">;

  const attachEditor = async (
    target: HTMLElement,
    file: Attachable,
    onEditor?: OnEditor,
  ) => {
    const wrapper = new MonacoEditorLanguageClientWrapper();

    await wrapper.initAndStart({
      $type: "extended",
      htmlContainer: target,
      editorAppConfig: {
        useDiffEditor: false,
        monacoWorkerFactory: configureDefaultWorkerFactory,
        codeResources: { modified: await prepare(file.path, file.source) },
      },
    });

    const editor = wrapper.getEditor();
    if (!editor) throw new Error("Editor not found");

    const model = editor.getModel();
    if (!model) throw new Error("Model not found");

    file.source = model.getValue();

    const disposables = [
      onEditor?.(editor),
      model.onDidChangeContent(() => (file.source = model.getValue())),
    ];

    const dispose = () => {
      disposables.forEach((disposable) => disposable?.dispose());
      wrapper.dispose();
    };

    return { model, editor, dispose };
  };

  export type Props = {
    file: EditableFile;
    size?: number;
    readonlyOverride?: boolean;
    onEditor?: OnEditor;
    onBinding?: (binding: MonacoBinding) => void | (() => void);
  };
</script>

<script lang="ts">
  let {
    file,
    onEditor,
    onBinding,
    readonlyOverride = false,
    size = 14,
  }: Props = $props();

  let container = $state<HTMLElement>();
  let current = $state<ReturnType<typeof attachEditor>>();

  $effect(() => {
    if (!container) return;
    const { path: _ } = file;
    const child = document.createElement("div");
    child.style.width = "100%";
    child.style.height = "100%";
    container.appendChild(child);
    const handle = untrack(() => attachEditor(child, file, onEditor));
    current = handle;
    return () => {
      handle.then(({ dispose }) => dispose());
      container?.removeChild(child);
    };
  });

  $effect(() => {
    const { readonly } = file;
    const readOnly = readonlyOverride || readonly;
    current?.then(({ editor }) => editor.updateOptions({ readOnly }));
  });

  $effect(() => {
    const fontSize = size;
    current?.then(({ editor }) => editor.updateOptions({ fontSize }));
  });

  $effect(() => {
    const { sourceSync } = file;
    if (!sourceSync) return;
    let dispose: (() => void) | null = null;
    current?.then(({ model, editor }) => {
      const binding = new MonacoBinding(sourceSync, model, new Set([editor]));
      file.syncBinding = binding;
      dispose = () => {
        file.syncBinding = undefined;
        binding.destroy();
      };
    });
    return () => dispose?.();
  });

  $effect(() => {
    if (file.syncBinding && onBinding) return onBinding(file.syncBinding);
  });
</script>

<div style:width="100%" style:height="100%" bind:this={container}></div>
