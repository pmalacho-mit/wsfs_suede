import * as monaco from "monaco-editor";
import { Filesystem } from "./filesystem";
import { createLanguageClient } from "./language/client";
import { DemandLoader } from "./language/demand";
import { DiagnosticFilters } from "./language/diagnostics";
import { OpenDocuments } from "./language/documents";
import { LanguageSettings } from "./language/settings";
import { ChainedTransform } from "./notebook/protocol";
import { Notebooks } from "./notebook/registry";
import { join, relative, singletonify } from "./utils";

const ROOT = "/workspace";
const OVERLAY_PRIORITY = 1;

export const uri = (path: string) => monaco.Uri.parse(join(ROOT, path));

export const pathOf = ({ path }: { path: string }) =>
  relative(path.startsWith(ROOT) ? path.slice(ROOT.length) : path);

export const workspace = singletonify({
  uri: () => monaco.Uri.parse(ROOT),
  files: () => new Filesystem(uri, OVERLAY_PRIORITY),
  settings: () => new LanguageSettings(),
  diagnostics: () => new DiagnosticFilters(),
  notebooks: () => new Notebooks(uri),
  documents: () => new OpenDocuments(),
  chained: () =>
    new ChainedTransform(workspace.notebooks.documents, workspace.documents),
  client: () =>
    createLanguageClient({
      workspaceUri: workspace.uri,
      settings: workspace.settings,
      interceptor: workspace.chained,
      diagnostics: workspace.diagnostics,
      toPath: pathOf,
    }),
  imports: () =>
    new DemandLoader(
      workspace.files,
      () => workspace.client,
      workspace.documents,
      uri,
    ),
});

/**
 * Makes a path openable and gives the language server everything that path
 * imports — and nothing else.
 */
export const prepare = async (source: string, fallback: string) => {
  const { files, imports, client } = workspace;
  const path = relative(source);
  if (!files.has(path)) files.memory.write(path, fallback);
  // A file that imports nothing gives the loader no reason to reach for the
  // language client, and an unopened document is analysed by nobody.
  await Promise.all([client, imports.reach(path)]);
  return { uri: uri(path).toString(), text: await files.read(path) };
};
