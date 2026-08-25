import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const ROOT = import.meta.dirname;
const OUT = resolve(ROOT, "dist/mobile");

const SCRIPT = /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g;
const STYLESHEET = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g;

function hash(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

function assetSource(href: string): string {
  return readFileSync(resolve(OUT, href.replace(/^\.?\//, "")), "utf8");
}

/**
 * The phone page ships as one file. The server that answers a phone serves it from a path the QR
 * decides, so a build that emitted `<script src>` would have to guess that path; a page with no
 * asset URLs at all cannot guess wrong. The inline script is admitted by its own hash rather than
 * by `unsafe-inline`.
 */
function singleFile(): Plugin {
  return {
    name: "mobile-single-file",
    apply: "build",
    closeBundle: {
      order: "post",
      handler() {
        const built = resolve(OUT, "index.mobile.html");
        let html = readFileSync(built, "utf8");
        const hashes: string[] = [];
        html = html.replace(SCRIPT, (_match, href: string) => {
          const source = assetSource(href);
          hashes.push(hash(source));
          return `<script type="module">${source}</script>`;
        });
        html = html.replace(STYLESHEET, (_match, href: string) => `<style>${assetSource(href)}</style>`);
        html = html.replace("__SCRIPT_HASHES__", hashes.join(" "));
        writeFileSync(resolve(OUT, "index.html"), html);
        rmSync(built);
        rmSync(resolve(OUT, "assets"), { recursive: true, force: true });
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), singleFile()],
  build: {
    outDir: "dist/mobile",
    emptyOutDir: true,
    modulePreload: false,
    /** Every asset is folded into the page, so nothing is left to fetch by URL. */
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rolldownOptions: {
      input: resolve(ROOT, "index.mobile.html"),
      output: { codeSplitting: false },
    },
  },
});
