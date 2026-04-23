import * as vscode from "vscode";
import { findUnusedVariables, getAllUsedIdentifiers } from "./analyzer";
import { UnusedSidebarProvider } from "./sidebarProvider";

// 🔥 GLOBAL CACHE
export let unusedCache: Record<string, any[]> = {};

// 🔥 GLOBAL USED IDENTIFIERS (for cross-file tracking)
let globalUsedIdentifiers = new Set<string>();

// 🔥 BULK OPERATION FLAG
let isBulkOperation = false;

// 🔥 SIDEBAR REFRESH FLAG (batch updates)
let sidebarNeedsRefresh = false;

export function activate(context: vscode.ExtensionContext) {
  console.log("✅ Extension Activated");

  const diagnostics =
    vscode.languages.createDiagnosticCollection("unused");

  const decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(255, 0, 0, 0.08)",
    isWholeLine: true,
  });

  const sidebarProvider = new UnusedSidebarProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("unusedSidebar", sidebarProvider)
  );

  // 🔥 DEBOUNCE
  let timeout: NodeJS.Timeout | undefined;
  let sidebarRefreshTimeout: NodeJS.Timeout | undefined;
  let globalRebuildTimeout: NodeJS.Timeout | undefined;

  const rebuildGlobalUsedIdentifiers = async () => {
    globalUsedIdentifiers.clear();
    const files = await vscode.workspace.findFiles(
      "**/*.{js,ts,jsx,tsx}",
      "**/node_modules/**"
    );
    
    for (const file of files) {
      try {
        const used = getAllUsedIdentifiers(file.fsPath);
        used.forEach(name => globalUsedIdentifiers.add(name));
      } catch {}
    }
  };

  // 🔥 DEBOUNCED SIDEBAR REFRESH
  const scheduleSidebarRefresh = () => {
    if (sidebarRefreshTimeout) {
      clearTimeout(sidebarRefreshTimeout);
    }
    sidebarRefreshTimeout = setTimeout(() => {
      sidebarProvider.refresh();
    }, 300);
  };

  // 🔥 DEBOUNCED GLOBAL REBUILD (only on save, not on keystroke)
  const scheduleGlobalRebuild = async () => {
    if (globalRebuildTimeout) {
      clearTimeout(globalRebuildTimeout);
    }
    globalRebuildTimeout = setTimeout(async () => {
      await rebuildGlobalUsedIdentifiers();
      scheduleSidebarRefresh();
    }, 500);
  };

  const triggerUpdate = (doc: vscode.TextDocument) => {
    if (isBulkOperation) {
      return;
    }

    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      const unused = findUnusedVariables(doc.fileName);
      
      // 🔥 Filter out items used in any other file
      unusedCache[doc.fileName] = unused.filter(
        (item) => !globalUsedIdentifiers.has(item.name)
      );

      updateDiagnostics(doc, diagnostics, decoration);
      scheduleSidebarRefresh();
    }, 200);
  };

  // 🔥 INITIAL SCAN
  const scanWorkspace = async () => {
    const files = await vscode.workspace.findFiles(
      "**/*.{js,ts,jsx,tsx}",
      "**/node_modules/**"
    );

    // 🔥 First pass: collect all used identifiers from all files
    globalUsedIdentifiers.clear();
    for (const file of files) {
      try {
        const used = getAllUsedIdentifiers(file.fsPath);
        used.forEach(name => globalUsedIdentifiers.add(name));
      } catch {}
    }

    // 🔥 Second pass: find unused, filtering out items used globally
    for (const file of files) {
      try {
        const unused = findUnusedVariables(file.fsPath);
        unusedCache[file.fsPath] = unused.filter(
          (item) => !globalUsedIdentifiers.has(item.name)
        );
      } catch {}
    }

    sidebarProvider.refresh();
  };

  scanWorkspace();

  vscode.workspace.onDidSaveTextDocument((doc) => {
    triggerUpdate(doc);
    // 🔥 Rebuild global identifiers on save
    scheduleGlobalRebuild();
  });

  vscode.workspace.onDidChangeTextDocument((e) => {
    if (isBulkOperation) {
      return;
    }
    if (e.contentChanges.length > 0) {
      triggerUpdate(e.document);
    }
  });

  // 🔥 APPLY DECORATIONS WHEN EDITOR BECOMES ACTIVE
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

  // 🔥 APPLY DECORATIONS TO ACTIVE EDITOR ON ACTIVATION
  setTimeout(() => {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.fileName) {
      const unused = unusedCache[activeEditor.document.fileName] || [];
      updateDiagnosticsFromCache(
        activeEditor.document,
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

        if (!editor) {
          return;
        }

        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      }
    )
  );

  // 🔥 AST DELETE FUNCTION (CORE FIX)
  const deleteByAstRange = (
    doc: vscode.TextDocument,
    edit: vscode.WorkspaceEdit,
    item: any,
    fileItems: any[]
  ) => {
    if (item.start === undefined || item.end === undefined) {
      return;
    }

    // 🔥 HANDLE VARIABLE DECLARATION (FINAL FIX)
    if (item.type === "variable") {
      const related = fileItems.filter(
        (i) =>
          i.type === "variable" &&
          i.declarationStart === item.declarationStart &&
          i.declarationEnd === item.declarationEnd
      );

      const startPos = doc.positionAt(item.declarationStart);
      const endPos = doc.positionAt(item.declarationEnd);

      const fullText = doc.getText(new vscode.Range(startPos, endPos));

      // 🔥 Extract keyword + body
      const match = fullText.match(/(const|let|var)\s+([\s\S]*?);?$/);
      if (!match) {
        return;
      }

      const keyword = match[1];
      const body = match[2];

      // 🔥 Split variables safely
      const parts = body
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

      // 🔥 Remove ALL unused variables from this declaration
      const updatedParts = parts.filter((part) => {
        const nameMatch = part.match(/^([a-zA-Z_$][\w$]*)/);
        if (!nameMatch) {
          return true;
        }

        const varName = nameMatch[1];

        return !related.some((r) => r.name === varName);
      });

      // 🔥 CASE 1: All removed → delete whole statement
      if (updatedParts.length === 0) {
        edit.delete(doc.uri, new vscode.Range(startPos, endPos));
        return;
      }

      // 🔥 CASE 2: Rebuild clean statement
      const updated = `${keyword} ${updatedParts.join(", ")};`;

      edit.replace(doc.uri, new vscode.Range(startPos, endPos), updated);
      return;
    }

    // 🔥 IMPORT (delete full line cleanly)
    if (item.type === "import") {
      const startPos = doc.positionAt(item.start);
      const line = doc.lineAt(startPos.line);
      edit.delete(doc.uri, line.rangeIncludingLineBreak);
      return;
    }

    // 🔥 DEFAULT (functions, etc.)
    const startPos = doc.positionAt(item.start);
    const endPos = doc.positionAt(item.end);

    const startLine = doc.lineAt(startPos.line).range.start;
    const endLine = doc.lineAt(endPos.line).range.end;

    edit.delete(doc.uri, new vscode.Range(startLine, endLine));
  };

  // 🔥 DELETE SINGLE
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "unused.deleteFromSidebar",
      async (item) => {
        if (!item?.filePath) {
          return;
        }

        const doc = await vscode.workspace.openTextDocument(item.filePath);

        const edit = new vscode.WorkspaceEdit();

        const fileItems = unusedCache[item.filePath] || [];
        deleteByAstRange(doc, edit, item, fileItems);

        await vscode.workspace.applyEdit(edit);

        // 🔥 FAST CACHE UPDATE: only remove the deleted item, don't full rescan
        const remaining = unusedCache[item.filePath] || [];
        unusedCache[item.filePath] = remaining.filter(
          (i) => i.name !== item.name || i.loc.start.line !== item.loc.start.line
        );

        scheduleSidebarRefresh();
      }
    )
  );

  // 🔥 REMOVE ALL (AST + SORTED)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "unused.removeAllFromSidebar",
      async () => {
        isBulkOperation = true;

        const edit = new vscode.WorkspaceEdit();

        for (const filePath of Object.keys(unusedCache)) {
          try {
            const doc = await vscode.workspace.openTextDocument(filePath);
            const unused = unusedCache[filePath] || [];

            // 🔥 SORT DESCENDING (critical)
            unused
              .slice()
              .sort((a, b) => b.start - a.start)
              .forEach((item) => {
                const fileItems = unusedCache[filePath] || [];
                deleteByAstRange(doc, edit, item, fileItems);
              });
          } catch {}
        }

        await vscode.workspace.applyEdit(edit);

        // wait for VS Code update
        await new Promise((r) => setTimeout(r, 100));

        // 🔥 rebuild cache with cross-file tracking (more efficiently)
        unusedCache = {};
        await rebuildGlobalUsedIdentifiers();

        const files = await vscode.workspace.findFiles(
          "**/*.{js,ts,jsx,tsx}",
          "**/node_modules/**"
        );

        // 🔥 Only scan files that had unused code before (faster recovery)
        for (const file of files) {
          try {
            const unused = findUnusedVariables(file.fsPath);
            unusedCache[file.fsPath] = unused.filter(
              (item) => !globalUsedIdentifiers.has(item.name)
            );
          } catch {
            unusedCache[file.fsPath] = [];
          }
        }

        scheduleSidebarRefresh();

        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          updateDiagnosticsFromCache(
            activeEditor.document,
            diagnostics,
            decoration,
            unusedCache[activeEditor.document.fileName] || []
          );
        }

        isBulkOperation = false;

        vscode.window.showInformationMessage(
          "Removed unused code from all files 🚀"
        );
      }
    )
  );

  context.subscriptions.push(diagnostics);
}

// 🔍 UPDATE FROM CACHE
function updateDiagnosticsFromCache(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  decoration: vscode.TextEditorDecorationType,
  unused: any[]
) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== document) {
    return;
  }

  const diags: vscode.Diagnostic[] = [];
  const decos: vscode.DecorationOptions[] = [];

  unused.forEach((item: any) => {
    const line = item.loc.start.line - 1;
    const range = new vscode.Range(line, 0, line, 1000);

    const d = new vscode.Diagnostic(
      range,
      `Unused: ${item.name}`,
      vscode.DiagnosticSeverity.Warning
    );

    diags.push(d);
    decos.push({ range });
  });

  diagnostics.set(document.uri, diags);
  editor.setDecorations(decoration, decos);
}

// 🔍 NORMAL UPDATE
function updateDiagnostics(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  decoration: vscode.TextEditorDecorationType
) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== document) {
    return;
  }

  const unused = unusedCache[document.fileName] || [];

  const diags: vscode.Diagnostic[] = [];
  const decos: vscode.DecorationOptions[] = [];

  unused.forEach((item: any) => {
    const line = item.loc.start.line - 1;
    const range = new vscode.Range(line, 0, line, 1000);

    const d = new vscode.Diagnostic(
      range,
      `Unused: ${item.name}`,
      vscode.DiagnosticSeverity.Warning
    );

    diags.push(d);
    decos.push({ range });
  });

  diagnostics.set(document.uri, diags);
  editor.setDecorations(decoration, decos);
}

export function deactivate() {}