import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { NO_APP_UPDATE, type AppUpdate } from "../domain/app-update.js";
import { compareVersions } from "../domain/engine-version.js";
import { repairAppImageLaunchers } from "./appimage-update.js";

const RELEASES = "https://github.com/zyuapp/ai-coding-tool/releases";
const CHECK_INTERVAL = 60 * 60 * 1000;

/** What an update replaces: the macOS bundle the binary sits in, or the AppImage that holds it. */
export type UpdateTarget = { kind: "bundle"; bundle: string } | { kind: "appimage"; image: string };

export function updateTarget(platform: NodeJS.Platform, executable: string, environment: NodeJS.ProcessEnv): UpdateTarget | null {
  if (platform === "darwin") {
    const bundle = path.resolve(executable, "..", "..", "..");
    return bundle.endsWith(".app") ? { kind: "bundle", bundle } : null;
  }
  if (platform === "linux" && environment.APPIMAGE) return { kind: "appimage", image: environment.APPIMAGE };
  return null;
}

type ReleaseFile = { url: string; sha512: string; size: number };
export type ReleaseManifest = { version: string; files: ReleaseFile[] };

function unquote(value: string) {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

/** Reads the `latest-*.yml` electron-builder publishes: its version and the files it lists. */
export function parseReleaseManifest(text: string): ReleaseManifest | null {
  const version = /^version:\s*(\S+)\s*$/m.exec(text)?.[1];
  if (!version) return null;
  const files: Partial<ReleaseFile>[] = [];
  let current: Partial<ReleaseFile> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const item = /^\s+-\s+url:\s*(\S+)\s*$/.exec(line);
    if (item) {
      files.push(current = { url: unquote(item[1]!) });
      continue;
    }
    const field = /^\s+(sha512|size):\s*(\S+)\s*$/.exec(line);
    if (field && current) {
      if (field[1] === "size") current.size = Number(field[2]);
      else current.sha512 = unquote(field[2]!);
    } else if (!/^\s/.test(line)) current = null;
  }
  const complete = files.filter((file): file is ReleaseFile => Boolean(file.url && file.sha512 && Number.isFinite(file.size)));
  return { version: unquote(version), files: complete };
}

function manifestName(platform: NodeJS.Platform, arch: string) {
  if (platform === "darwin") return "latest-mac.yml";
  return arch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
}

function releaseFile(manifest: ReleaseManifest, target: UpdateTarget) {
  const suffix = target.kind === "bundle" ? ".zip" : ".AppImage";
  return manifest.files.find((file) => file.url.endsWith(suffix)) ?? null;
}

const run = promisify(execFile);

/** Accepts only a bundle signed by whoever signed the one it replaces, as Squirrel does for the desktop app. */
async function verifyBundle(current: string, next: string) {
  const { stdout } = await run("/usr/bin/codesign", ["-d", "-r-", current]);
  const requirement = /^designated => (.+)$/m.exec(stdout)?.[1];
  if (!requirement) throw new Error("The installed app has no signature to check the update against.");
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", `=${requirement}`, next]);
}

type Staged = { version: string; path: string; file: ReleaseFile; cleanup: string };

/** Where releases are fetched from, and what checks a macOS bundle before it is used. */
type Source = { releases: string; get: typeof fetch; verify: (current: string, next: string) => Promise<void> };

async function fetchOk(source: Source, url: string) {
  const response = await source.get(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response;
}

async function fetchManifest(source: Source, name: string, target: UpdateTarget) {
  const manifest = parseReleaseManifest(await (await fetchOk(source, `${source.releases}/latest/download/${name}`)).text());
  if (!manifest || !releaseFile(manifest, target)) throw new Error(`${name} names no build for this computer.`);
  return manifest;
}

/** Streams the file to `destination`, hashing as it goes, then checks it whole. */
async function fetchFile(source: Source, manifest: ReleaseManifest, file: ReleaseFile, destination: string, progress: (percent: number) => void) {
  const url = /^https:\/\//.test(file.url) ? file.url : `${source.releases}/download/v${manifest.version}/${encodeURIComponent(file.url)}`;
  const response = await fetchOk(source, url);
  if (!response.body) throw new Error(`${url} sent nothing.`);
  const hash = createHash("sha512");
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      received += chunk.length;
      progress(Math.min(100, Math.floor((received / file.size) * 100)));
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), counter, createWriteStream(destination, { flags: "wx", mode: 0o755 }));
  if (received !== file.size || hash.digest("base64") !== file.sha512) throw new Error(`${file.url} did not match its checksum.`);
}

/** Downloads the build beside what it replaces, so the swap is a rename on one volume. */
async function stage(source: Source, target: UpdateTarget, manifest: ReleaseManifest, progress: (percent: number) => void): Promise<Staged> {
  const file = releaseFile(manifest, target)!;
  if (target.kind === "appimage") {
    const destination = path.join(path.dirname(target.image), `.${path.basename(target.image)}.${randomUUID()}.download`);
    try {
      await fetchFile(source, manifest, file, destination, progress);
      await chmod(destination, 0o755);
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
    return { version: manifest.version, path: destination, file, cleanup: destination };
  }
  const download = await mkdtemp(path.join(tmpdir(), "aic-update-"));
  const unpacked = path.join(path.dirname(target.bundle), `.${path.basename(target.bundle)}.${randomUUID()}.update`);
  try {
    const archive = path.join(download, "update.zip");
    await fetchFile(source, manifest, file, archive, progress);
    await run("/usr/bin/ditto", ["-x", "-k", archive, unpacked]);
    const bundle = (await readdir(unpacked)).find((entry) => entry.endsWith(".app"));
    if (!bundle) throw new Error(`${file.url} holds no app.`);
    await source.verify(target.bundle, path.join(unpacked, bundle));
    return { version: manifest.version, path: path.join(unpacked, bundle), file, cleanup: unpacked };
  } catch (error) {
    await rm(unpacked, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(download, { recursive: true, force: true });
  }
}

/** Puts the new build where the old one was. An image whose name carries its version takes the new one's name. */
async function swap(target: UpdateTarget, current: string, update: Staged) {
  if (target.kind === "appimage") {
    const name = path.basename(target.image);
    const destination = name.includes(current) ? path.join(path.dirname(target.image), path.basename(update.file.url)) : target.image;
    await rename(update.path, destination);
    if (destination !== target.image) {
      await rm(target.image, { force: true });
      repairAppImageLaunchers({ appImage: target.image, home: homedir(), ...(process.env.XDG_DATA_HOME ? { dataHome: process.env.XDG_DATA_HOME } : {}) }, destination);
    }
    return;
  }
  const previous = path.join(update.cleanup, "previous.app");
  await rename(target.bundle, previous);
  try {
    await rename(update.path, target.bundle);
  } catch (error) {
    await rename(previous, target.bundle);
    throw error;
  }
  await rm(update.cleanup, { recursive: true, force: true }).catch(() => undefined);
}

export type ServeUpdater = ReturnType<typeof createServeUpdater>;

/**
 * Updates a headless server without Electron: finds the newest release, downloads and checks it, and
 * swaps it in place of the installed app. `restart` is told once the new build is in place.
 */
export function createServeUpdater(options: {
  version: string;
  target: UpdateTarget;
  platform?: NodeJS.Platform;
  arch?: string;
  releases?: string;
  fetch?: typeof fetch;
  verifyBundle?: (current: string, next: string) => Promise<void>;
  onState: (update: AppUpdate) => void;
  restart: () => void;
  say: (line: string) => void;
}) {
  const { target, say } = options;
  const source: Source = { releases: options.releases ?? RELEASES, get: options.fetch ?? fetch, verify: options.verifyBundle ?? verifyBundle };
  const manifestFile = manifestName(options.platform ?? process.platform, options.arch ?? process.arch);
  let state: AppUpdate = NO_APP_UPDATE;
  let found: ReleaseManifest | null = null;
  let staged: Staged | null = null;
  let checking: Promise<void> | null = null;
  let installing = false;

  function setState(next: AppUpdate) {
    state = next;
    options.onState(next);
  }

  /** A build on its way or in hand is not given up for whatever a later check finds. */
  const holding = () => state.status === "downloading" || state.status === "ready";

  function check(): Promise<void> {
    if (holding()) return Promise.resolve();
    return checking ??= (async () => {
      try {
        const manifest = await fetchManifest(source, manifestFile, target);
        if (holding()) return;
        if (compareVersions(manifest.version, options.version) <= 0) {
          found = null;
          if (state.status !== "idle") setState(NO_APP_UPDATE);
          return;
        }
        found = manifest;
        if (state.status !== "available" || state.version !== manifest.version) setState({ status: "available", version: manifest.version });
      } catch (error) {
        say(`Update check failed: ${message(error)}`);
      } finally {
        checking = null;
      }
    })();
  }

  async function download() {
    const manifest = found;
    if (state.status !== "available" || !manifest) return;
    setState({ status: "downloading", version: manifest.version, percent: 0 });
    say(`Downloading AI Coding Tool ${manifest.version}…`);
    try {
      staged = await stage(source, target, manifest, (percent) => {
        if (state.status === "downloading" && percent !== state.percent) setState({ ...state, percent });
      });
      setState({ status: "ready", version: manifest.version });
    } catch (error) {
      say(`Could not download ${manifest.version}: ${message(error)}`);
      setState({ status: "available", version: manifest.version });
    }
  }

  async function install() {
    const update = staged;
    if (state.status !== "ready" || !update || installing) return;
    installing = true;
    try {
      say(`Installing AI Coding Tool ${update.version}…`);
      await swap(target, options.version, update);
      staged = null;
      say(`Installed ${update.version}. Restarting…`);
      options.restart();
    } catch (error) {
      say(`Could not install ${update.version}: ${message(error)}`);
      staged = null;
      await rm(update.cleanup, { recursive: true, force: true }).catch(() => undefined);
      setState({ status: "available", version: update.version });
    } finally {
      installing = false;
    }
  }

  /** Checks now and every hour after, like the desktop app. */
  function start() {
    void check();
    const timer = setInterval(() => void check(), CHECK_INTERVAL);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** A download nobody installed is left for the next check to fetch again. */
  async function dispose() {
    const update = staged;
    staged = null;
    if (update) await rm(update.cleanup, { recursive: true, force: true }).catch(() => undefined);
  }

  return { state: () => state, check, download, install, start, dispose };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
