import * as vscode from "vscode";
import { unusedCache } from "./extension";

export class UnusedWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "unusedSidebar";

  private view?: vscode.WebviewView;

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;

    view.webview.options = { enableScripts: true };

    view.webview.html = this.getHtml();

    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "goTo") {
        vscode.commands.executeCommand("unused.goToLine", msg.line, msg.file);
      }

      if (msg.type === "delete") {
        vscode.commands.executeCommand("unused.deleteFromSidebar", msg.item);
      }

      if (msg.type === "removeAll") {
        vscode.commands.executeCommand("unused.removeAllFromSidebar");
      }
    });

    this.update();
  }

  public update() {
    if (!this.view) return;

    this.view.webview.postMessage({
      type: "update",
      data: unusedCache,
    });
  }

  public updateState(state: string, progress: number = 0, currentFile = "") {
    if (!this.view) return;

    this.view.webview.postMessage({
      type: "state",
      state,
      progress,
      currentFile,
    });
  }

  private getHtml(): string {
    return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<link href="https://cdn.jsdelivr.net/npm/@vscode/codicons/dist/codicon.css" rel="stylesheet" />

<style>
  body {
    font-family: var(--vscode-font-family);
    padding: 10px;
    color: var(--vscode-foreground);
  }

  .input-wrapper {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }

  .search {
    flex: 1;
    padding: 6px;
    border-radius: 6px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
  }

  input:focus {
    outline-color: var(--vscode-focusBorder);
  }

  #removeAll {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border: none;
    padding: 6px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
  }

  /* 🔥 PROGRESS BAR */
  .progress-container {
    height: 4px;
    background: rgba(255,255,255,0.1);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
    display: none;
  }

  .progress-bar {
    height: 100%;
    width: 0%;
    background: var(--vscode-progressBar-background);
    transition: width 0.2s ease;
  }

  .progress-text {
    font-size: 11px;
    margin-bottom: 8px;
    opacity: 0.7;
    display: none;
  }

  .file {
    display: flex;
    justify-content: space-between;
    padding: 6px;
    cursor: pointer;
    border-radius: 6px;
    font-weight: 600;
    transition: background 0.15s ease;
  }

  .file:hover {
    background: rgba(255,255,255,0.05);
  }

  .badge {
    font-size: 11px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .group {
    margin-left: 10px;
    overflow: hidden;
    max-height: 0;
    transition: max-height 0.25s ease;
  }

  .group.open {
    max-height: 500px;
  }

  .groupTitle {
    font-size: 11px;
    opacity: 0.7;
    margin-top: 6px;
  }

  .item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .item:hover {
    background: rgba(255,255,255,0.05);
  }

  .item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }

  .item.active .delete {
    opacity: 1;
  }

  .delete {
    opacity: 0.6;
    cursor: pointer;
  }

  .delete:hover {
    opacity: 1;
  }

  .divider {
    height: 1px;
    margin: 8px 0;
    background: var(--vscode-editorWidget-border);
    opacity: 0.5;
  }

  .empty {
    text-align: center;
    margin-top: 20px;
    opacity: 0.7;
  }

  .fileNameWrapper {
    display: flex;
    align-items: center;
  }
</style>
</head>

<body>

<div class="input-wrapper">
  <input id="search" class="search" placeholder="Search unused code, files..." />
  <button id="removeAll">Remove All</button>
</div>

<div class="progress-container" id="progressContainer">
  <div class="progress-bar" id="progressBar"></div>
</div>

<div class="progress-text" id="progressText"></div>

<div id="list"></div>

<script>
const vscode = acquireVsCodeApi();

let data = {};
let openState = {};
let scanState = "idle";
let activeItemKey = null;

const list = document.getElementById("list");
const search = document.getElementById("search");
const progressBar = document.getElementById("progressBar");
const progressContainer = document.getElementById("progressContainer");
const progressText = document.getElementById("progressText");

document.getElementById("removeAll").onclick = () => {
  vscode.postMessage({ type: "removeAll" });
};

// 🔥 FILE ICON
function getFileIcon(ext) {
  const ns = "http://www.w3.org/2000/svg";

  // 🔥 TSX → React SVG icon
  if (ext === "tsx") {
    const ns = "http://www.w3.org/2000/svg";

    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.style.marginRight = "6px";
    svg.style.flexShrink = "0";

    // 🔥 group (React color)
    const g = document.createElementNS(ns, "g");
    g.setAttribute("fill", "#61dafb");

    // center dot
    const center = document.createElementNS(ns, "circle");
    center.setAttribute("cx", "12");
    center.setAttribute("cy", "12");
    center.setAttribute("r", "2");

    // orbits (filled look using stroke)
    const createOrbit = (rotate) => {
        const orbit = document.createElementNS(ns, "ellipse");
        orbit.setAttribute("cx", "12");
        orbit.setAttribute("cy", "12");
        orbit.setAttribute("rx", "10");
        orbit.setAttribute("ry", "4");
        orbit.setAttribute("fill", "none");
        orbit.setAttribute("stroke", "#61dafb");
        orbit.setAttribute("stroke-width", "1.8");
        orbit.setAttribute("transform", rotate);
        return orbit;
    };

    const orbit1 = createOrbit("");
    const orbit2 = createOrbit("rotate(60 12 12)");
    const orbit3 = createOrbit("rotate(-60 12 12)");

    svg.appendChild(orbit1);
    svg.appendChild(orbit2);
    svg.appendChild(orbit3);
    svg.appendChild(center);

    return svg;
    }

  // 🔥 DEFAULT BADGE STYLE (your existing)
  const el = document.createElement("div");

  el.style.width = "18px";
  el.style.height = "18px";
  el.style.borderRadius = "3px";
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.fontSize = "9px";
  el.style.fontWeight = "700";
  el.style.marginRight = "6px";
  el.style.flexShrink = "0";

  switch (ext) {
    case "ts":
      el.textContent = "TS";
      el.style.background = "#3178c6";
      el.style.color = "#fff";
      break;

    case "js":
      el.textContent = "JS";
      el.style.background = "#f7df1e";
      el.style.color = "#000";
      break;

    case "jsx":
      el.textContent = "JS";
      el.style.background = "#61dafb";
      el.style.color = "#000";
      break;

    case "json":
      el.textContent = "{}";
      el.style.background = "#cbcb41";
      el.style.color = "#000";
      break;

    default:
      el.textContent = ext?.slice(0, 2).toUpperCase() || "F";
      el.style.background = "var(--vscode-badge-background)";
      el.style.color = "var(--vscode-badge-foreground)";
  }

  return el;
}

function groupItems(items) {
  const groups = { variable: [], function: [], import: [] };
  items.forEach(i => groups[i.type || "variable"].push(i));
  return groups;
}

function createItem(file, item) {
  const row = document.createElement("div");
  row.className = "item";

  const key = file + ":" + item.loc.start.line;

  if (activeItemKey === key) {
    row.classList.add("active");
  }

  row.onclick = () => {
    activeItemKey = key;

    vscode.postMessage({
      type: "goTo",
      line: item.loc.start.line - 1,
      file
    });

    render(); // 🔥 update highlight
  };

  const left = document.createElement("span");
  left.textContent =
    item.name + " (line " + item.loc.start.line + ")";

  const del = document.createElement("span");
  del.className = "delete codicon codicon-trash";

  del.onclick = (e) => {
    e.stopPropagation();
    vscode.postMessage({
      type: "delete",
      item: { ...item, filePath: file }
    });
  };

  row.appendChild(left);
  row.appendChild(del);

  return row;
}

function createGroup(title, items, file) {
  const wrapper = document.createElement("div");

  const header = document.createElement("div");
  header.className = "groupTitle";
  header.textContent = title + " (" + items.length + ")";

  wrapper.appendChild(header);

  items.forEach(i => wrapper.appendChild(createItem(file, i)));

  return wrapper;
}

function createFile(file, items) {
  const container = document.createElement("div");

  const row = document.createElement("div");
  row.className = "file";

  const fileName = file.split("\\\\").pop();
  const ext = fileName.split(".").pop();

  const nameWrapper = document.createElement("span");
  nameWrapper.className = "fileNameWrapper";

  nameWrapper.appendChild(getFileIcon(ext));

  const text = document.createElement("span");
  text.textContent = fileName;
  nameWrapper.appendChild(text);

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = items.length;

  row.appendChild(nameWrapper);
  row.appendChild(badge);

  const groupContainer = document.createElement("div");
  groupContainer.className = "group";

  if (openState[file]) groupContainer.classList.add("open");

  const grouped = groupItems(items);

  Object.keys(grouped).forEach(key => {
    if (grouped[key].length) {
      groupContainer.appendChild(
        createGroup(key, grouped[key], file)
      );
    }
  });

  row.onclick = () => {
    openState[file] = !openState[file];
    render();
  };

  container.appendChild(row);
  container.appendChild(groupContainer);

  const divider = document.createElement("div");
  divider.className = "divider";
  container.appendChild(divider);

  return container;
}

function render() {
  const q = search.value.toLowerCase();
  list.innerHTML = "";

  Object.keys(data).forEach(file => {
    const items = data[file];
    const filtered = items.filter(i =>
      i.name.toLowerCase().includes(q)
    );

    if (!filtered.length) return;

    list.appendChild(createFile(file, filtered));
  });
}

search.addEventListener("input", render);

// 🔥 STATE HANDLER (NO FULL RERENDER)
window.addEventListener("message", (event) => {
  if (event.data.type === "update") {
    data = event.data.data;
    render();
  }

  if (event.data.type === "state") {
    const { state, progress, currentFile } = event.data;

    if (state === "loading") {
      progressContainer.style.display = "block";
      progressText.style.display = "block";

      progressBar.style.width = progress + "%";
      progressText.textContent =
        "Scanning (" + progress + "%): " + (currentFile || "");
    } else {
      progressContainer.style.display = "none";
      progressText.style.display = "none";

      if (state === "cancelled") {
        list.innerHTML = "<div class='empty'>Scan cancelled</div>";
      }
    }
  }
});
</script>

</body>
</html>
`;
  }
}