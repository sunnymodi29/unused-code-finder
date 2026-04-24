import * as vscode from "vscode";
import { findUnusedVariables, getAllUsedIdentifiers } from "./analyzer";
import { UnusedWebviewProvider } from "./webViewProvider";

// 🔥 GLOBAL CACHE
export let unusedCache: Record<string, any[]> = {};

// 🔥 GLOBAL USED IDENTIFIERS
let globalUsedIdentifiers = new Set<string>();

// 🔥 FLAGS
let isBulkOperation = false;

// 🔥 SIDEBAR SCAN STATE
let scanState: "idle" | "loading" | "cancelled" | "done" = "idle";

export function activate(context: vscode.ExtensionContext) {
  console.log("✅ Extension Activated");

  const diagnostics =
    vscode.languages.createDiagnosticCollection("unused");

  const decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(255, 0, 0, 0.08)",
    isWholeLine: true,
  });

  // ✅ WEBVIEW
  const webviewProvider = new UnusedWebviewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "unusedSidebar",
      webviewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // 🔥 REBUILD GLOBAL USED
  const rebuildGlobalUsedIdentifiers = async () => {
    globalUsedIdentifiers.clear();

    const files = await vscode.workspace.findFiles(
      "**/*.{js,ts,jsx,tsx}",
      "**/node_modules/**"
    );

    for (const file of files) {
      try {
        const used = getAllUsedIdentifiers(file.fsPath);
        used.forEach((n) => globalUsedIdentifiers.add(n));
      } catch {}
    }
  };

  // 🔥 UPDATE SINGLE FILE
  const triggerUpdate = (doc: vscode.TextDocument) => {
    if (isBulkOperation) return;

    const unused = findUnusedVariables(doc.fileName);

    unusedCache[doc.fileName] = unused.filter(
      (item) => !globalUsedIdentifiers.has(item.name)
    );

    updateDiagnostics(doc, diagnostics, decoration);
    webviewProvider.update();
  };

  let isScanning = false;

    // 🔥 SAFE WRAPPER (prevents double scan)
    const scanWorkspaceSafe = async (webviewProvider?: any) => {
      if (isScanning) {
        vscode.window.setStatusBarMessage("Scan already running...", 1500);
        return;
      }

      isScanning = true;

      try {
        await scanWorkspace(webviewProvider);
      } finally {
        isScanning = false;
      }
    };

  // 🔥 FAST SCAN (PARALLEL + CANCEL SAFE)
  const scanWorkspace = async (webviewProvider?: any) => {
    webviewProvider?.updateState?.("loading", 0);
    const files = await vscode.workspace.findFiles(
      "**/*.{js,ts,jsx,tsx}",
      "**/node_modules/**"
    );

    let cancelled = false;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Scanning for unused code...",
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          cancelled = true;
        });

        const total = files.length;

        let processed = 0;

        const globalUsedIdentifiers = new Set<string>();

        // 🔥 PASS 1 — collect used identifiers
        for (const file of files) {
          if (cancelled) break;

          try {
            const used = getAllUsedIdentifiers(file.fsPath);
            used.forEach((n) => globalUsedIdentifiers.add(n));
          } catch {
            // 🔥 never crash
          }

          processed++;

          // 🔥 throttle UI updates
          if (processed % 10 === 0 || processed === total) {
            const percent = Math.floor((processed / total) * 50);

            progress.report({
              increment: (1 / total) * 50,
              message: `${processed}/${total} files (analyzing usage)`,
            });

            webviewProvider?.updateState?.(
              "loading",
              percent,
              file.fsPath.split("\\").pop()
            );
          }
        }

        if (cancelled) {
          webviewProvider?.updateState?.("cancelled");
          vscode.window.setStatusBarMessage("Scan cancelled", 2000);
          return;
        }

        // 🔥 PASS 2 — find unused
        processed = 0;

        for (const file of files) {
          if (cancelled) break;

          try {
            const unused = findUnusedVariables(file.fsPath);

            unusedCache[file.fsPath] = unused.filter(
              (item) => !globalUsedIdentifiers.has(item.name)
            );
          } catch {
            // 🔥 skip broken file
            unusedCache[file.fsPath] = [];
          }

          processed++;

          if (processed % 10 === 0 || processed === total) {
            const percent =
              50 + Math.floor((processed / total) * 50);

            progress.report({
              increment: (1 / total) * 50,
              message: `${processed}/${total} files (finding unused)`,
            });

            webviewProvider?.updateState?.(
              "loading",
              percent,
              file.fsPath.split("\\").pop()
            );
          }
        }

        if (cancelled) {
          webviewProvider?.updateState?.("cancelled");
          vscode.window.setStatusBarMessage("Scan cancelled", 2000);
          return;
        }

        // 🔥 DONE
        webviewProvider?.updateState?.("done", 100);

        vscode.window.setStatusBarMessage("Scan complete", 2000);

        webviewProvider?.update?.();
      }
    );
  }

  scanWorkspace(webviewProvider);

  // 🔥 FILE EVENTS
  vscode.workspace.onDidSaveTextDocument(async (doc) => {
    triggerUpdate(doc);
    await rebuildGlobalUsedIdentifiers();
    webviewProvider.update();
  });

  vscode.workspace.onDidChangeTextDocument((e) => {
    if (isBulkOperation) return;
    if (e.contentChanges.length > 0) {
      triggerUpdate(e.document);
    }
  });

  // 🔥 ACTIVE EDITOR DECORATION
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && editor.document.fileName) {
      const unused = unusedCache[editor.document.fileName] || [];
      updateDiagnosticsFromCache(
        editor.document,
        diagnostics,
        decoration,
        unused
      );
    }
  });

  // 🔥 INITIAL DECORATION
  setTimeout(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const unused = unusedCache[editor.document.fileName] || [];
      updateDiagnosticsFromCache(
        editor.document,
        diagnostics,
        decoration,
        unused
      );
    }
  }, 500);

  // 🔥 GO TO LINE
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "unused.goToLine",
      async (line: number, filePath?: string) => {
        let editor = vscode.window.activeTextEditor;

        if (filePath) {
          const doc = await vscode.workspace.openTextDocument(filePath);
          editor = await vscode.window.showTextDocument(doc);
        }

        if (!editor) return;

        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      }
    )
  );

  // 🔥 DELETE (AST SAFE)
  const deleteByAstRange = (
    doc: vscode.TextDocument,
    edit: vscode.WorkspaceEdit,
    item: any,
    fileItems: any[]
  ) => {
    if (item.start === undefined || item.end === undefined) return;

    const start = doc.positionAt(item.start);
    const end = doc.positionAt(item.end);

    edit.delete(doc.uri, new vscode.Range(start, end));
  };

  // 🔥 DELETE SINGLE
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "unused.deleteFromSidebar",
      async (item) => {
        if (!item?.filePath) return;

        const doc = await vscode.workspace.openTextDocument(item.filePath);
        const edit = new vscode.WorkspaceEdit();

        deleteByAstRange(
          doc,
          edit,
          item,
          unusedCache[item.filePath] || []
        );

        await vscode.workspace.applyEdit(edit);

        unusedCache[item.filePath] =
          (unusedCache[item.filePath] || []).filter(
            (i) => i.start !== item.start
          );

        webviewProvider.update();
      }
    )
  );

  // 🔥 REMOVE ALL
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "unused.removeAllFromSidebar",
      async () => {
        isBulkOperation = true;

        const edit = new vscode.WorkspaceEdit();

        for (const filePath of Object.keys(unusedCache)) {
          const doc = await vscode.workspace.openTextDocument(filePath);

          const unused = unusedCache[filePath] || [];

          unused
            .slice()
            .sort((a, b) => b.start - a.start)
            .forEach((item) => {
              deleteByAstRange(doc, edit, item, unused);
            });
        }

        await vscode.workspace.applyEdit(edit);

        unusedCache = {};
        await rebuildGlobalUsedIdentifiers();
        await scanWorkspaceSafe(webviewProvider);

        isBulkOperation = false;

        vscode.window.showInformationMessage(
          "Removed unused code from all files 🚀"
        );
      }
    )
  );

  context.subscriptions.push(diagnostics);
}

// 🔍 FROM CACHE
function updateDiagnosticsFromCache(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  decoration: vscode.TextEditorDecorationType,
  unused: any[]
) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== document) return;

  const diags: vscode.Diagnostic[] = [];
  const decos: vscode.DecorationOptions[] = [];

  unused.forEach((item: any) => {
    const line = item.loc.start.line - 1;
    const range = new vscode.Range(line, 0, line, 1000);

    diags.push(
      new vscode.Diagnostic(
        range,
        `Unused: ${item.name}`,
        vscode.DiagnosticSeverity.Warning
      )
    );

    decos.push({ range });
  });

  diagnostics.set(document.uri, diags);
  editor.setDecorations(decoration, decos);
}

// 🔍 NORMAL
function updateDiagnostics(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  decoration: vscode.TextEditorDecorationType
) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== document) return;

  const unused = unusedCache[document.fileName] || [];

  const diags: vscode.Diagnostic[] = [];
  const decos: vscode.DecorationOptions[] = [];

  unused.forEach((item: any) => {
    const line = item.loc.start.line - 1;
    const range = new vscode.Range(line, 0, line, 1000);

    diags.push(
      new vscode.Diagnostic(
        range,
        `Unused: ${item.name}`,
        vscode.DiagnosticSeverity.Warning
      )
    );

    decos.push({ range });
  });

  diagnostics.set(document.uri, diags);
  editor.setDecorations(decoration, decos);
}

export function deactivate() {}