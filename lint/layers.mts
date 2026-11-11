import { existsSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
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

/** Layers that run in any process, so they take no Node, Electron, or React. */
const PORTABLE_LAYERS = new Set(["domain", "contracts", "application", "host"]);
const ELECTRON = /^electron(\/|$)/;
const REACT = /^react(-dom)?(\/|$)/;

const SRC = path.resolve(import.meta.dirname, "../src");
const MAIN = path.join(SRC, "main");
const ENGINE_REGISTRY = path.join(MAIN, "engines");

/** An engine is a folder under src/main holding its `<name>-engine.mts`. */
const ENGINES = readdirSync(MAIN, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(MAIN, entry.name, `${entry.name}-engine.mts`)))
  .map((entry) => entry.name);

function within(file: string, directory: string) {
  const relative = path.relative(directory, file);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function layerOf(file: string): string | undefined {
  if (!within(file, SRC)) return undefined;
  return path.relative(SRC, file).split(path.sep)[0].replace(/\.[cm]?tsx?$/, "");
}

/** The folder directly under src/main holding a file, or undefined for a file at its root. */
function mainFolderOf(file: string): string | undefined {
  if (!within(file, MAIN)) return undefined;
  const parts = path.relative(MAIN, file).split(path.sep);
  return parts.length > 1 ? parts[0] : undefined;
}

function packageProblem(layer: string, specifier: string) {
  const node = isBuiltin(specifier);
  if (PORTABLE_LAYERS.has(layer) && (node || ELECTRON.test(specifier) || REACT.test(specifier))) {
    return `src/${layer} runs in any process and may not import ${specifier}.`;
  }
  if (layer === "renderer" && (node || ELECTRON.test(specifier))) {
    return `The window is sandboxed and may not import ${specifier}. Reach the desktop through the preload bridge.`;
  }
  return undefined;
}

function relativeProblem(file: string, target: string) {
  const from = layerOf(file);
  const to = layerOf(target);
  const allowed = from ? LAYER_IMPORTS[from] : undefined;
  if (from && to && allowed && to !== from && !allowed.includes(to)) {
    const reach = allowed.length ? allowed.join(", ") : "no other layer";
    return `src/${from} may import ${reach}, not src/${to}. Move what both need down a layer.`;
  }
  const source = mainFolderOf(file);
  const destination = mainFolderOf(target);
  const registry = file.replace(/\.[cm]?tsx?$/, "") === ENGINE_REGISTRY;
  if (destination && ENGINES.includes(destination) && source !== destination && !registry) {
    return `Only src/main/engines.mts reaches into an engine. Move what others need from src/main/${destination} to src/main/agent.`;
  }
  if (source === "tools" && within(target, MAIN) && destination !== "tools") {
    return "Tool definitions import nothing else from src/main, so every engine can serve them.";
  }
  return undefined;
}

type Node = { type: string; value?: unknown; source?: Node | null };

export const layerImports = {
  meta: { type: "problem", schema: [] },
  create(context: { filename: string; report: (report: { node: Node; message: string }) => void }) {
    const file = context.filename;
    const layer = layerOf(file);
    if (!layer) return {};

    const check = (node: Node, source: Node | null | undefined) => {
      const specifier = source?.value;
      if (typeof specifier !== "string") return;
      const message = specifier.startsWith(".")
        ? relativeProblem(file, path.resolve(path.dirname(file), specifier))
        : packageProblem(layer, specifier);
      if (message) context.report({ node, message });
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
