import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Model-checks every TLA+ spec in specs/ against the config of the same name, with TLC. Needs Java. */
const TLA_VERSION = "1.7.4";
const TLA_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar`;
const TLA_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";

const specs = path.resolve("specs");
const jar = path.resolve(`node_modules/.cache/tla/tla2tools-${TLA_VERSION}.jar`);

async function tlaTools() {
  const held = await readFile(jar).catch(() => null);
  if (held && createHash("sha256").update(held).digest("hex") === TLA_SHA256) return;
  const response = await fetch(TLA_URL);
  if (!response.ok) throw new Error(`Could not download TLC: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== TLA_SHA256) throw new Error(`TLC download has hash ${got}, expected ${TLA_SHA256}.`);
  await mkdir(path.dirname(jar), { recursive: true });
  await writeFile(`${jar}.tmp`, bytes);
  await rename(`${jar}.tmp`, jar);
}

await tlaTools();
const names = (await readdir(specs)).filter((name) => name.endsWith(".tla")).map((name) => name.slice(0, -4));
let failed = 0;
for (const name of names) {
  const states = await mkdtemp(path.join(os.tmpdir(), `tlc-${name}-`));
  const started = Date.now();
  const run = spawnSync("java", ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "auto", "-metadir", states, "-config", `${name}.cfg`, `${name}.tla`], { cwd: specs, encoding: "utf8" });
  await rm(states, { recursive: true, force: true });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.error) throw run.error;
  if (run.status === 0 && output.includes("No error has been found")) {
    const found = /(\d+) distinct states found/.exec(output)?.[1] ?? "?";
    console.log(`✓ ${name}: ${found} distinct states in ${Date.now() - started}ms`);
  } else {
    failed += 1;
    console.error(`✗ ${name}\n${output}`);
  }
}
if (failed) process.exit(1);
