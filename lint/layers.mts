import path from "node:path";

/** The layers each layer under src may import. A layer missing from a list is out of reach, types included. */
export const LAYER_IMPORTS: Record<string, readonly string[]> = {
  domain: [],
  contracts: ["domain"],
  application: ["contracts", "domain"],
  host: ["application", "contracts", "domain"],
  renderer: ["application", "contracts", "domain"],
  preload: ["application", "contracts", "domain"],
  main: ["host", "application", "contracts", "domain"],
};

const SRC = path.resolve(import.meta.dirname, "../src");

function layerOf(file: string): string | undefined {
  const relative = path.relative(SRC, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const [first] = relative.split(path.sep);
  return first.replace(/\.[cm]?tsx?$/, "");
}

type Node = { type: string; value?: unknown; source?: Node | null };

export const layerImports = {
  meta: { type: "problem", schema: [] },
  create(context: { filename: string; report: (report: { node: Node; message: string }) => void }) {
    const from = layerOf(context.filename);
    const allowed = from ? LAYER_IMPORTS[from] : undefined;
    if (!from || !allowed) return {};

    const check = (node: Node, source: Node | null | undefined) => {
      const value = source?.value;
      if (typeof value !== "string" || !value.startsWith(".")) return;
      const to = layerOf(path.resolve(path.dirname(context.filename), value));
      if (!to || to === from || allowed.includes(to)) return;
      const reach = allowed.length ? allowed.join(", ") : "no other layer";
      context.report({ node, message: `src/${from} may import ${reach}, not src/${to}. Move what both need down a layer.` });
    };

    return {
      ImportDeclaration: (node: Node) => check(node, node.source),
      ExportNamedDeclaration: (node: Node) => check(node, node.source),
      ExportAllDeclaration: (node: Node) => check(node, node.source),
      ImportExpression: (node: Node) => check(node, node.source),
      TSImportType: (node: Node) => check(node, node.source),
    };
  },
};
