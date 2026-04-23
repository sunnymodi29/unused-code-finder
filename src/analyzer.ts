import * as fs from "fs";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";

const IGNORED = new Set([
  "console",
  "window",
  "document",
  "Math",
  "JSON",
]);

function getLoc(node: any, fallback?: any) {
  return node?.loc || fallback?.loc || null;
}

function getRange(node: any, fallback?: any) {
  return {
    start: node?.start ?? fallback?.start,
    end: node?.end ?? fallback?.end,
  };
}

// 🔥 GET ALL USED IDENTIFIERS (cross-file tracking)
export function getAllUsedIdentifiers(filePath: string): Set<string> {
  try {
    const code = fs.readFileSync(filePath, "utf-8");

    const ast = parser.parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });

    const used = new Set<string>();

    traverse(ast, {
      Identifier(path) {
        const parent = path.parent;

        // Skip declarations themselves
        if (
          (parent.type === "VariableDeclarator" &&
            parent.id === path.node) ||
          (parent.type === "FunctionDeclaration" &&
            parent.id === path.node) ||
          parent.type.includes("Import")
        ) {
          return;
        }

        used.add(path.node.name);
      },
    });

    return used;
  } catch {
    return new Set();
  }
}

export function findUnusedVariables(filePath: string) {
  const code = fs.readFileSync(filePath, "utf-8");

  const ast = parser.parse(code, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });

  const declared: any[] = [];
  const used = new Set<string>();

  traverse(ast, {
    // 🔥 VARIABLE DECLARATIONS
    VariableDeclarator(path) {
      const id = path.node.id;
      let declarationNode: any = path.parent;

      if (declarationNode?.type !== "VariableDeclaration") {
        return;
      }
      const range = getRange(path.node, declarationNode);

      // ✅ simple variable
      if (id.type === "Identifier") {
        declared.push({
          name: id.name,
          loc: getLoc(declarationNode, path.node),
          start: range.start,
          end: range.end,
          type: "variable",
          declarationStart: declarationNode.start,
          declarationEnd: declarationNode.end,
          totalDeclarators: declarationNode.declarations.length,
        });
      }

      // ✅ object destructuring
      if (id.type === "ObjectPattern") {
        id.properties.forEach((prop: any) => {
          if (prop.value?.name) {
            const r = getRange(prop, path.node);

            declared.push({
              name: prop.value.name,
              loc: getLoc(prop, path.node),
              start: r.start,
              end: r.end,
              type: "variable",
              declarationStart: declarationNode.start,
              declarationEnd: declarationNode.end,
              totalDeclarators: declarationNode.declarations.length,
            });
          }
        });
      }

      // ✅ array destructuring
      if (id.type === "ArrayPattern") {
        id.elements.forEach((el: any) => {
          if (el?.name) {
            const r = getRange(el, path.node);

            declared.push({
              name: el.name,
              loc: getLoc(el, path.node),
              start: r.start,
              end: r.end,
              type: "variable",
              declarationStart: declarationNode.start,
              declarationEnd: declarationNode.end,
              totalDeclarators: declarationNode.declarations.length,
            });
          }
        });
      }
    },

    // 🔥 FUNCTION DECLARATION
    FunctionDeclaration(path) {
      if (path.node.id) {
        const range = getRange(path.node, path.parent);

        declared.push({
          name: path.node.id.name,
          loc: getLoc(path.node, path.parent),
          start: range.start,
          end: range.end,
          type: "function",
        });
      }
    },

    // 🔥 IMPORTS (whole import handled)
    ImportDeclaration(path) {
      const importNode = path.node;

      const specifiers = importNode.specifiers.map(
        (s: any) => s.local.name
      );

      specifiers.forEach((name) => {
        declared.push({
          name,
          loc: getLoc(importNode, path.parent),
          start: importNode.start,
          end: importNode.end,
          type: "import",
          allSpecifiers: specifiers,
        });
      });
    },

    // 🔥 USAGE TRACKING
    Identifier(path) {
      const parent = path.parent;

      if (
        (parent.type === "VariableDeclarator" &&
          parent.id === path.node) ||
        (parent.type === "FunctionDeclaration" &&
          parent.id === path.node) ||
        parent.type.includes("Import")
      ) {
        return;
      }

      used.add(path.node.name);
    },
  });

  // 🔥 FINAL FILTER
  return declared.filter(
    (d) =>
      d.start !== undefined &&
      d.end !== undefined &&
      d.loc &&
      !used.has(d.name) &&
      !IGNORED.has(d.name)
  );
}