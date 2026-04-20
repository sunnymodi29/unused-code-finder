import * as vscode from "vscode";
import { unusedCache } from "./extension";

export class UnusedSidebarProvider
  implements vscode.TreeDataProvider<any>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<any>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    // 🔥 FULL TREE REFRESH
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: any): vscode.TreeItem {
    return element;
  }

  getChildren(element?: any): Thenable<any[]> {
    if (!element) {
      return Promise.resolve(
        Object.keys(unusedCache).map((file) => {
          const fileItem = new vscode.TreeItem(
            file.split("\\").pop() || file,
            vscode.TreeItemCollapsibleState.Collapsed
          );

          fileItem.contextValue = "file";
          (fileItem as any).filePath = file;

          return fileItem;
        })
      );
    }

    const filePath = element.filePath;

    return Promise.resolve(
      (unusedCache[filePath] || []).map((item: any) => {
        const line = item.loc.start.line - 1;

        const treeItem = new vscode.TreeItem(
          `${item.name} (line ${line + 1})`
        );

        treeItem.command = {
          command: "unused.goToLine",
          title: "Go",
          arguments: [line, filePath],
        };

        treeItem.contextValue = "unusedItem";
        (treeItem as any).line = line;
        (treeItem as any).filePath = filePath;
        (treeItem as any).start = item.start;
        (treeItem as any).end = item.end;
        (treeItem as any).loc = item.loc;

        return treeItem;
      })
    );
  }

  getParent(): vscode.ProviderResult<any> {
    return null;
  }
}