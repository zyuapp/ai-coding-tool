import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

const FONT_FACE = /@font-face\s*\{[^}]*\}/g;
const FONT_URL = /url\(\.\/([^)]+?\.woff2)\)/;

/**
 * Drops the Cyrillic, Greek, and Vietnamese cuts of every bundled family, and the files they name.
 * The browser picks a cut by `unicode-range`, so those files only ever load for text the window
 * rarely shows, yet the build emits all of them. Text outside the kept ranges falls back to the OS
 * font. This runs on the finished bundle because the emitted rules are the only place the cut and
 * its hashed file name appear together.
 */
function latinFontSubsets(): Plugin {
  return {
    name: "latin-font-subsets",
    generateBundle(_options, bundle) {
      const referenced = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "asset" || !output.fileName.endsWith(".css")) continue;
        output.source = String(output.source).replace(FONT_FACE, (block) => {
          const file = FONT_URL.exec(block)?.[1];
          if (!file) return block;
          if (!file.includes("-latin")) return "";
          referenced.add(file);
          return block;
        });
      }
      for (const [name, output] of Object.entries(bundle)) {
        if (output.fileName.endsWith(".woff2") && !referenced.has(output.fileName.split("/").pop() ?? "")) delete bundle[name];
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), latinFontSubsets()],
  /**
   * A test run serves no browser, so pre-bundling has nothing to serve. Discovery still ran, and
   * left a `node_modules/.vite/deps_temp_*` folder of its own behind on every run.
   */
  optimizeDeps: mode === "test" ? { noDiscovery: true, include: [] } : {},
  test: {
    include: ["tests/**/*.test.mts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    license: { fileName: "legal/RENDERER-THIRD-PARTY-LICENSES.md" },
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            /** React, the sidebar drag, and the markdown pipeline all load with the window, so the entry carries none of them. */
            { name: "react", test: /node_modules[\\/](?:react|react-dom|scheduler|react-is|use-sync-external-store)[\\/]/ },
            { name: "dnd", test: /node_modules[\\/](?:@hello-pangea[\\/]dnd|react-redux|redux|use-memo-one|memoize-one|raf-schd|css-box-model)[\\/]/ },
            { name: "markdown", test: /node_modules[\\/](?:react-markdown|remark-[^\\/]+|rehype-[^\\/]+|unified|micromark[^\\/]*|mdast-[^\\/]+|hast-[^\\/]+|unist-[^\\/]+|vfile[^\\/]*|character-entities[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|html-url-attributes|trim-lines|devlop|bail|trough|extend|is-plain-obj|zwitch|longest-streak|ccount|escape-string-regexp|markdown-table|estree-util-is-identifier-name|style-to-js|style-to-object|inline-style-parser)[\\/]/ },
          ],
        },
      },
    },
  },
}));
