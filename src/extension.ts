import * as vscode from "vscode";
import { findUnusedVariables } from "./analyzer";
import { UnusedSidebarProvider } from "./sidebarProvider";

// 🔥 GLOBAL CACHE
export let unusedCache: Record<string, any[]> = {};

// 🔥 BULK OPERATION FLAG
let isBulkOperation = false;

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

  const triggerUpdate = (doc: vscode.TextDocument) => {
    if (isBulkOperation) return;

    if (timeout) clearTimeout(timeout);

    timeout = setTimeout(() => {
      unusedCache[doc.fileName] = findUnusedVariables(doc.fileName);

      updateDiagnostics(doc, diagnostics, decoration);

      sidebarProvider.refresh();
    }, 200);
  };

  // 🔥 INITIAL SCAN
  const scanWorkspace = async () => {
    const files = await vscode.workspace.findFiles(
      "**/*.{js,ts,jsx,tsx}",
      "**/node_modules/**"
    );

    for (const file of files) {
      try {
        unusedCache[file.fsPath] = findUnusedVariables(file.fsPath);
      } catch {}
    }

    sidebarProvider.refresh();
  };

  scanWorkspace();

  vscode.workspace.onDidSaveTextDocument(triggerUpdate);

  vscode.workspace.onDidChangeTextDocument((e) => {
    if (isBulkOperation) return;
    if (e.contentChanges.length > 0) {
      triggerUpdate(e.document);
    }
  });

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

  // 🔥 AST DELETE FUNCTION (CORE FIX)
  const deleteByAstRange = (
    doc: vscode.TextDocument,
    edit: vscode.WorkspaceEdit,
    item: any,
    fileItems: any[]
  ) => {
    if (item.start === undefined || item.end === undefined) return;

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
      if (!match) return;

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
        if (!nameMatch) return true;

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
        if (!item?.filePath) return;

        const doc = await vscode.workspace.openTextDocument(item.filePath);

        const edit = new vscode.WorkspaceEdit();

        const fileItems = unusedCache[item.filePath] || [];
        deleteByAstRange(doc, edit, item, fileItems);

        await vscode.workspace.applyEdit(edit);

        // refresh cache
        unusedCache[item.filePath] = findUnusedVariables(item.filePath);

        sidebarProvider.refresh();
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

        // 🔥 rebuild cache
        unusedCache = {};

        const files = await vscode.workspace.findFiles(
          "**/*.{js,ts,jsx,tsx}",
          "**/node_modules/**"
        );

        for (const file of files) {
          try {
            unusedCache[file.fsPath] = findUnusedVariables(file.fsPath);
          } catch {
            unusedCache[file.fsPath] = [];
          }
        }

        sidebarProvider.refresh();

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
  if (!editor || editor.document !== document) return;

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
  if (!editor || editor.document !== document) return;

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