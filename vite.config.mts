import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.mts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            /** React and the markdown pipeline are both loaded with the window, so the entry carries neither. */
            { name: "react", test: /node_modules[\\/](?:react|react-dom|scheduler|react-is|use-sync-external-store)[\\/]/ },
            { name: "markdown", test: /node_modules[\\/](?:react-markdown|remark-[^\\/]+|rehype-[^\\/]+|unified|micromark[^\\/]*|mdast-[^\\/]+|hast-[^\\/]+|unist-[^\\/]+|vfile[^\\/]*|character-entities[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|html-url-attributes|trim-lines|devlop|bail|trough|extend|is-plain-obj|zwitch|longest-streak|ccount|escape-string-regexp|markdown-table|estree-util-is-identifier-name|style-to-js|style-to-object|inline-style-parser)[\\/]/ },
          ],
        },
      },
    },
  },
});
