import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cargoAboutVersion, sha256, toolchain } from "./native-reports.mjs";

const cargoAboutArchives = {
  "darwin-arm64": ["aarch64-apple-darwin", "ae72f0df0c399a1e96336f696fa55b1b28679fd725632eba8cf8e4568467cc3e"],
  "linux-arm64": ["aarch64-unknown-linux-musl", "af5169282fb6f84e13471493f405437e43ac517744c9ae12fbe2cdf0a6f0e5a8"],
  "linux-x64": ["x86_64-unknown-linux-musl", "9099a59e820c38a68b9d65f300662a567d56562f9a10f6aa4c7e86c17c2566af"],
};

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(command)} exited ${code}\n${stderr || stdout}`));
    });
  });
}

export async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Curl's bounded retries also cover the network restrictions common in agent environments. */
export async function download(url, file, expectedHash) {
  const cached = await readFile(file).catch(() => null);
  if (cached && expectedHash && sha256(cached) === expectedHash) return expectedHash;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.download`;
  try {
    await run("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "2", "--connect-timeout", "15", "--max-time", "180", "--output", temporary, url]);
    const digest = sha256(await readFile(temporary));
    if (expectedHash && digest !== expectedHash) throw new Error(`Checksum mismatch for ${url}: expected ${expectedHash}, received ${digest}.`);
    await rename(temporary, file);
    return digest;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function sourceTree(definition, cache, scratch, previous) {
  if (!/^[a-f0-9]{40}$/.test(definition.commit)) throw new Error(`Invalid source commit for ${definition.id}.`);
  const archive = path.join(cache, "sources", `${definition.id}-${definition.commit}.tgz`);
  const expected = previous?.inputs?.commit === definition.commit ? previous.sourceArchiveSha256 : undefined;
  const sourceArchiveSha256 = await download(`https://api.github.com/repos/${definition.repository}/tarball/${definition.commit}`, archive, expected);
  const directory = await mkdtemp(path.join(scratch, `${definition.id}-`));
  await run("tar", ["-xzf", archive, "-C", directory, "--strip-components=1"]);
  return { directory, sourceArchiveSha256 };
}

export async function nativeTools(cache) {
  const host = cargoAboutArchives[`${process.platform}-${process.arch}`];
  if (!host) throw new Error(`Native report tooling is not configured for ${process.platform}/${process.arch}. Use macOS arm64 or Linux x64/arm64.`);
  const cargoHome = path.join(cache, "cargo-home");
  const rustupHome = path.join(cache, "rustup-home");
  const env = { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome, RUSTUP_TOOLCHAIN: toolchain, PATH: `${cargoHome}/bin:${process.env.PATH ?? ""}` };
  const rustc = path.join(cargoHome, "bin/rustc");
  const ready = await run(rustc, ["--version"], { env }).then((text) => text.startsWith(`rustc ${toolchain} `)).catch(() => false);
  if (!ready) {
    console.log(`Installing Rust ${toolchain} in ${cache} (one-time setup).`);
    const rustHost = host[0].replace("-musl", "-gnu");
    const url = `https://static.rust-lang.org/rustup/archive/1.28.2/${rustHost}/rustup-init`;
    const checksumFile = path.join(cache, `rustup-${rustHost}.sha256`);
    await download(`${url}.sha256`, checksumFile);
    const checksum = (await readFile(checksumFile, "utf8")).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Invalid official Rustup checksum.");
    const installer = path.join(cache, "rustup-init");
    await download(url, installer, checksum);
    await chmod(installer, 0o755);
    await run(installer, ["-y", "--no-modify-path", "--profile", "minimal", "--default-toolchain", toolchain], { env });
  }
  const name = `cargo-about-${cargoAboutVersion}-${host[0]}`;
  const archive = path.join(cache, `${name}.tar.gz`);
  await download(`https://github.com/EmbarkStudios/cargo-about/releases/download/${cargoAboutVersion}/${name}.tar.gz`, archive, host[1]);
  // Re-extract the checked archive rather than trusting a potentially edited cached executable.
  await run("tar", ["-xzf", archive, "-C", cache]);
  const binary = path.join(cache, name, "cargo-about");
  if ((await run(binary, ["--version"], { env })).trim() !== `cargo-about ${cargoAboutVersion}`) throw new Error("Unexpected cargo-about version.");
  return { binary, env };
}
