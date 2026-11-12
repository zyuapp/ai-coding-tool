/**
 * Explores the real window at random with Bombadil, over the fake desktop in tests/fuzz, and checks
 * the properties in tests/fuzz/spec.mts after every action. Each window size runs in turn; traces
 * and screenshots land in .fuzz/runs.
 *
 *   npm run fuzz -- [--time 5m] [--size 1280x800 --size 760x620] [--headed]
 *   npm run fuzz -- --serve      serves the page alone, to replay a finding by hand
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import react from "@vitejs/plugin-react";
import { build, preview } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const harness = path.join(root, "tests/fuzz");
const out = path.join(root, ".fuzz");

const { values } = parseArgs({
  options: {
    time: { type: "string", default: "5m" },
    size: { type: "string", multiple: true, default: ["1280x800", "760x620"] },
    headed: { type: "boolean", default: false },
    serve: { type: "boolean", default: false },
  },
});

const sizes = values.size.map((size) => {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) throw new Error(`A size is WIDTHxHEIGHT, such as 1280x800, not ${size}.`);
  return { width: match[1]!, height: match[2]! };
});

/** A development bundle: React's own warnings, such as an update loop, only exist there. */
await build({
  configFile: false,
  root: harness,
  base: "./",
  mode: "development",
  logLevel: "warn",
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  resolve: {
    alias: [
      { find: /^node:assert(\/strict)?$/, replacement: path.join(harness, "assert-shim.mts") },
      { find: /^(\.\.?\/)+.*workspace-connection(\.js|\.ts)?$/, replacement: path.join(root, "tests/support/in-process-workspace.mts") },
    ],
  },
  build: { outDir: path.join(out, "dist"), emptyOutDir: true, target: "esnext", minify: false, sourcemap: true },
});

const server = await preview({ configFile: false, root: harness, logLevel: "warn", build: { outDir: path.join(out, "dist") }, preview: { port: values.serve ? 5198 : 0, host: "127.0.0.1" } });
const origin = server.resolvedUrls?.local[0];
if (!origin) throw new Error("The fuzz page did not start.");

if (values.serve) {
  console.log(`Serving the fuzz page at ${origin} until stopped.`);
  await new Promise(() => {});
}

/** How often each property failed in a run, read from its trace. */
function violations(output: string) {
  const counts = new Map<string, number>();
  for (const line of readFileSync(path.join(output, "trace.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    for (const { name } of (JSON.parse(line) as { violations?: { name: string }[] }).violations ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function explore(width: string, height: string): Promise<{ output: string; code: number }> {
  const output = path.join(out, "runs", `${width}x${height}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(output, { recursive: true });
  const args = [
    "browser", "test", origin!, path.join(harness, "spec.mts"),
    "--time-limit", values.time, "--width", width, "--height", height, "--output-path", output,
    ...(values.headed ? [] : ["--headless"]),
  ];
  console.log(`\n${width}x${height} for ${values.time} → ${path.relative(root, output)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(root, "node_modules/.bin/bombadil"), args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ output, code: code ?? 1 }));
  });
}

const runs: { output: string; code: number }[] = [];
try {
  for (const { width, height } of sizes) runs.push(await explore(width, height));
} finally {
  await server.close();
}
console.log("\nSummary");
for (const { output } of runs) {
  const found = [...violations(output)].map(([name, count]) => `${name} ×${count}`).join(", ");
  console.log(`  ${path.relative(root, output)}: ${found || "no violations"}`);
}
console.log("Inspect a run with: npx bombadil browser inspect <run folder>");
const failed = runs.some((run) => run.code !== 0);
process.exit(failed ? 1 : 0);
