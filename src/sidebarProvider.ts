import * as vscode from "vscode";
import { unusedCache } from "./extension";

export class UnusedSidebarProvider
  implements vscode.TreeDataProvider<any>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<any>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private isLoading = true;
  private searchQuery = "";
  private wasCancelled = false;

  setLoading(state: boolean) {
    this.isLoading = state;
    this.refresh();
  }

  setSearch(query: string) {
    this.searchQuery = query.toLowerCase();
    this.refresh();
  }

  setCancelled(value: boolean) {
    this.wasCancelled = value;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: any): vscode.TreeItem {
    return element;
  }

  getChildren(element?: any): Thenable<any[]> {
    // 🔥 LOADING
    if (this.isLoading) {
      const loading = new vscode.TreeItem("Scanning project...");
      loading.iconPath = new vscode.ThemeIcon("loading~spin");
      return Promise.resolve([loading]);
    }

    // 🔥 ROOT
    if (!element) {
      const items: vscode.TreeItem[] = [];

      // 🔍 Inline Search Row
      const searchItem = new vscode.TreeItem(
        this.searchQuery
          ? `Filter: ${this.searchQuery}`
          : "Search unused code..."
      );
      searchItem.iconPath = new vscode.ThemeIcon("search");
      searchItem.command = { command: "unused.search", title: "Search" };
      items.push(searchItem);

      const files = Object.keys(unusedCache).filter((file) => {
        const list = unusedCache[file] || [];
        if (list.length === 0) return false;

        if (!this.searchQuery) return true;

        return (
          file.toLowerCase().includes(this.searchQuery) ||
          list.some((i) =>
            i.name.toLowerCase().includes(this.searchQuery)
          )
        );
      });

      if (files.length === 0) {
        // 🔥 If scan was cancelled
        if (this.wasCancelled) {
          items.push(
            new vscode.TreeItem("⚠️ Scan cancelled")
          );
          return Promise.resolve(items);
        }

        // ✅ Normal case
        items.push(
          new vscode.TreeItem("🎉 No unused code found")
        );
        return Promise.resolve(items);
      }

      files.forEach((file) => {
        const fileItem = new vscode.TreeItem(
          file.split("\\").pop() || file,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        (fileItem as any).filePath = file;
        fileItem.contextValue = "file";
        items.push(fileItem);
      });

      return Promise.resolve(items);
    }

    // 🔥 CHILDREN
    const filePath = element.filePath;

    return Promise.resolve(
      (unusedCache[filePath] || [])
        .filter((item: any) =>
          !this.searchQuery
            ? true
            : item.name.toLowerCase().includes(this.searchQuery)
        )
        .map((item: any) => {
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

          (treeItem as any).filePath = filePath;
          (treeItem as any).start = item.start;
          (treeItem as any).end = item.end;
          (treeItem as any).loc = item.loc;

          return treeItem;
        })
    );
  }

  getParent(): null {
    return null;
  }
}