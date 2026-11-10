import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SERVE_RESTART_EXIT, SERVE_RESTARTS_ENV } from "../domain/cli.js";
import { emptyTailscaleState, type MobilePairingOffer, type MobileServerState } from "../domain/mobile.js";
import { createRuntimePublisher } from "../host/runtime-publisher.js";
import { createWorkspaceRuntime } from "../host/workspace-runtime.js";
import { forkAgentProcessNode } from "./agent-process-node.js";
import { readAppLaunch } from "./app-launch.js";
import { appPluginPath } from "./app-plugin-path.js";
import { attachmentsDirectory, useAttachmentsDirectory } from "./attachment-store.js";
import { refreshCli } from "./cli-install.js";
import { createDesktopEvents } from "./desktop-events.js";
import { claimServeLock } from "./instance-lock.js";
import { createJsonStorage, WINDOW_STORAGE_FILE } from "./json-storage.js";
import { useMessageImageStore } from "./message-image-store.js";
import { startRunHost } from "./run-host.js";
import { attachmentNames, ORPHAN_ATTACHMENT_MIN_AGE_MS, sweepOrphanAttachments } from "./user-data-sweep.js";
import { createServeDesktop } from "./serve-desktop.js";
import { createServeUpdater, updateTarget } from "./serve-updates.js";
import { createComputerBridge } from "./computer-bridge.js";
import { createComputerReads } from "./computer-queries.js";
import { appProfile } from "./user-data.js";
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { EngineAccessHost } from "./agent/engine-services.mjs" with { "resolution-mode": "import" };
import type { TaskDatabaseService } from "./task-database-service.mjs" with { "resolution-mode": "import" };
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { WorktreeService } from "./workspace/worktrees.mjs" with { "resolution-mode": "import" };
import { DictationHost, dictationHelper } from "./dictation-host.js";

/** What `aic serve` and `aic pair` were asked for. */
export type ServeArguments = {
  command: "serve" | "pair";
  /** A source checkout's own data folder, apart from the installed app's. */
  dev: boolean;
  /** A source checkout serving the installed app's data folder and checkouts, as `aic serve` would. */
  installed: boolean;
  /** A data folder named outright, which a test uses so nothing it does lands in the user's. */
  userData?: string;
  /** The port to ask for; 0 takes whatever is free. */
  port?: number;
  /** Loopback only: Tailscale is left alone, which a test on a developer's machine must do. */
  local: boolean;
};

export function parseServeArguments(argv: readonly string[]): ServeArguments {
  const parsed: ServeArguments = { command: "serve", dev: false, installed: false, local: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "serve" || argument === "pair") parsed.command = argument;
    else if (argument === "--dev") parsed.dev = true;
    else if (argument === "--installed") parsed.installed = true;
    else if (argument === "--local") parsed.local = true;
    else if (argument === "--user-data") parsed.userData = argv[++index];
    else if (argument === "--port") parsed.port = Number(argv[++index]);
  }
  return parsed;
}

/** Where the desktop app keeps its data on this platform, which a server on the same machine shares. */
function appDataPath() {
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
}

/** The packaged app's resources folder beside this process's binary, on either platform's layout, or null from source. */
function packagedResources() {
  const binary = path.dirname(process.execPath);
  for (const candidate of [path.join(binary, "resources"), path.join(binary, "..", "Resources")]) {
    if (existsSync(path.join(candidate, "app.asar"))) return candidate;
  }
  return null;
}

/** The pairing link drawn as a QR for the phone's camera, above the code to type instead. Output that
 * is not a terminal, such as a log, gets the line alone, because the drawing is colour codes there. */
async function pairingText(offer: MobilePairingOffer, terminal = Boolean(process.stdout.isTTY)) {
  const line = `Pair with code ${offer.code} (expires in ${Math.round((offer.expiresAt - Date.now()) / 60_000)} minutes) or open ${offer.url}`;
  if (!terminal) return line;
  const { toString } = await import("qrcode");
  const qr = await toString(offer.url, { type: "terminal", small: true, errorCorrectionLevel: "M" }).catch(() => "");
  return qr ? `${qr}\n${line}` : line;
}

/** Runs the application headless: every service the desktop app has, reachable only through the bridge. */
/** Tailscale as a host that must not touch it sees it: absent, so the bridge stays on the loopback. */
const NO_TAILSCALE = {
  read: async () => ({ ...emptyTailscaleState(), status: "missing" as const }),
  start: async () => ({ ok: false as const, message: "Tailscale is off for this server." }),
  stop: async () => ({ ok: true as const }),
};

/** The version in the app's own package, or null when it cannot be read. */
function appVersion(appPath: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(path.join(appPath, "package.json"), "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export async function startServe(options: {
  userData: string;
  packaged: boolean;
  installed?: boolean;
  resources: string | null;
  port?: number;
  local?: boolean;
  say: (line: string) => void;
  /** Given when whatever started this server starts it again after it stops for an update. */
  restart?: () => void;
}) {
  const { userData, say } = options;
  mkdirSync(userData, { recursive: true });
  const release = claimServeLock(userData);
  useAttachmentsDirectory(userData);
  useMessageImageStore({ directory: path.join(userData, "message-images"), thumbnail: () => null });
  const { PRIVATE_CODEX_HOME_ENV } = await import("./codex/codex-home.mjs");
  process.env[PRIVATE_CODEX_HOME_ENV] = path.join(userData, "codex-private");
  const { setAppPluginRoot } = await import("./app-plugin.mjs");
  const appPath = options.resources ? path.join(options.resources, "app.asar") : path.resolve(__dirname, "..", "..", "..");
  setAppPluginRoot(appPluginPath(options.packaged, options.resources ?? "", appPath));

  const worktreesRoot = appProfile(appDataPath(), homedir(), options.packaged || options.installed === true).worktreesRoot;
  const legacyRoots = [path.join(userData, "worktrees")].filter((root) => root !== worktreesRoot);
  const { WorkspaceService } = await import("./workspace/workspace-service.mjs");
  const workspaces: WorkspaceService = new WorkspaceService({ registryPath: path.join(userData, "workspaces.v1.json"), projectlessRoot: path.join(userData, "projectless") });
  const { WorktreeService } = await import("./workspace/worktrees.mjs");
  const worktrees: WorktreeService = new WorktreeService({ worktreesRoot, legacyRoots, workspaces });
  const { TaskDatabaseService } = await import("./task-database-service.mjs");
  const taskDatabase: TaskDatabaseService = await TaskDatabaseService.open(path.join(userData, "tasks.v3.sqlite"), {
    worktreesRoots: [worktreesRoot, ...legacyRoots],
    workerURL: pathToFileURL(path.join(__dirname, "task-database-worker.mjs")),
  });

  const events = createDesktopEvents();
  const version = appVersion(appPath);
  const target = options.resources && options.restart ? updateTarget(process.platform, process.execPath, process.env) : null;
  const updates = target && version && options.restart
    ? createServeUpdater({ version, target, onState: (update) => events.emit("update:changed", update), restart: options.restart, say })
    : null;
  const terminal = await import("./terminal-host.js");
  terminal.startTerminalHost({ onData: () => {}, onUpdate: (update) => { events.emit("terminal:event", update); } });
  let running = true;
  let scheduler: AutomationScheduler | null = null;
  const runs = startRunHost({
    publish: (event) => { events.emit("run:event", event); },
    fire: (fire) => events.emit("automation:fire", fire),
    ask: (request) => events.emit("thread:request", request),
    running: () => running,
    workspaces: () => workspaces,
    scheduler: () => {
      if (!scheduler) throw new Error("Automation scheduler is not ready.");
      return scheduler;
    },
    computerUseForRun: async () => ({ status: "unavailable", message: "Computer use needs the desktop app." }),
    agent: forkAgentProcessNode({ generatedImages: path.join(userData, "generated-images"), pluginPath: appPluginPath(options.packaged, options.resources ?? "", appPath) }),
  });
  const { AutomationScheduler } = await import("./automation/automation-scheduler.mjs");
  scheduler = new AutomationScheduler(taskDatabase, runs.dispatchAutomation, { onChange: (automations) => { events.emit("automation:changed", automations); } });
  await scheduler.start();

  let engineAccess: Promise<EngineAccessHost> | null = null;
  const mobile = await import("./mobile/mobile-host.mjs");
  const { storedComputerName } = await import("./computers/computer-links.mjs");
  /** No computer is paired with a headless host, so every read is answered here. */
  const reads = createComputerReads({ threads: (query) => runtime.queryThreads(query), workspaces: () => workspaces, state: () => runtime.getState(), links: () => null });
  const desktop = createServeDesktop({
    events,
    reads,
    runs,
    workspaces: () => workspaces,
    worktrees: () => worktrees,
    taskDatabase: () => taskDatabase,
    scheduler: () => scheduler!,
    engineAccess: () => engineAccess ??= import("./agent/engine-services.mjs").then(({ EngineAccessHost }) => new EngineAccessHost()),
    worktreesRoots: () => [worktreesRoot, ...legacyRoots],
    mobile: () => mobile,
    say,
    build: version ? { version, selfUpdating: updates !== null } : null,
    updates,
    launchedUpdate: version && options.resources ? readAppLaunch(userData, version) : null,
    dictation: new DictationHost({ helper: dictationHelper(options.resources ? path.join(options.resources, "native") : path.resolve(__dirname, "..", "..", "native"), Boolean(options.resources)) }),
  });
  const runtime = createWorkspaceRuntime({ desktop, storage: createJsonStorage(path.join(userData, WINDOW_STORAGE_FILE)) });
  const publisher = createRuntimePublisher(runtime);
  await runtime.start();
  const stopUpdateChecks = updates?.start();
  /** Browser and computer-use surfaces need a desktop; shells can be viewed from a paired computer. */
  await runtime.dispatch({ type: "view.set-browser-tools", enabled: false });
  await runtime.dispatch({ type: "view.set-computer-use", enabled: false });

  let served: string | null = null;
  let trouble: string | null = null;
  const { servePairingSocket } = await import("./mobile/pairing-socket.mjs");
  await mobile.startMobileHost({
    userData,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.local ? { tailscale: NO_TAILSCALE } : {}),
    workspace: createComputerBridge({
      publisher,
      reads,
      name: () => storedComputerName(path.join(userData, "computers.v1.json"), hostname().replace(/\.local$/, "")),
    }),
    send: (request) => events.emit("mobile:request", request),
    onState: (state: MobileServerState) => {
      events.emit("mobile:changed", state);
      const name = state.tailscale.serving ? state.tailscale.magicDnsName : null;
      if (name && name !== served) {
        served = name;
        say(`Serving as https://${name}`);
        mobile.createMobilePairingCode().then((offer) => pairingText(offer)).then(say).catch(() => undefined);
      }
      if (state.error) say(`Bridge: ${state.error}`);
      /** Said once as it changes: the bridge checks Tailscale every minute, and a stuck reason is not news. */
      if (state.tailscale.error && state.tailscale.error !== trouble) say(`Tailscale: ${state.tailscale.error}`);
      trouble = state.tailscale.error;
    },
  });
  void taskDatabase.attachmentPaths()
    .then((paths) => sweepOrphanAttachments(attachmentsDirectory(), attachmentNames(paths), { now: Date.now(), minAgeMs: ORPHAN_ATTACHMENT_MIN_AGE_MS }))
    .then((swept) => { if (swept.files) say(`Removed ${swept.files} unused attachment file(s), ${Math.round(swept.bytes / 1024 / 1024)} MB.`); })
    .catch((error: unknown) => console.error("Could not sweep unused attachments:", error));
  const stopPairingSocket = await servePairingSocket(path.join(userData, "serve.sock"), () => mobile.createMobilePairingCode());
  await mobile.setMobileEnabled(true);
  const state = mobile.mobileState();
  if (state.status === "listening") say(`Listening on port ${state.port}${options.local ? "." : ". Waiting for Tailscale to serve it."}`);
  if (state.tailscale.status === "missing" && !options.local) say("Tailscale is not installed on this computer, so nothing can reach the bridge.");

  let stopping: Promise<void> | null = null;
  return {
    runtime,
    publisher,
    events,
    port: () => mobile.mobileState().port,
    stop: () => stopping ??= (async () => {
      running = false;
      stopUpdateChecks?.();
      await updates?.dispose();
      terminal.stopTerminalHost();
      await publisher.flush().catch((error) => say(`Could not save the workspace: ${error instanceof Error ? error.message : String(error)}`));
      scheduler?.stop();
      runs.clearPendingStarts();
      runs.killAgent();
      await (await import("./agent/engine-services.mjs")).closeEngineServices().catch(() => undefined);
      await stopPairingSocket().catch(() => undefined);
      await mobile.stopMobileHost();
      await publisher.flush().catch(() => undefined);
      await scheduler?.flush();
      await taskDatabase.close();
      publisher.dispose();
      runtime.dispose();
      release();
    })(),
  };
}

async function main() {
  const arguments_ = parseServeArguments(process.argv.slice(1));
  const packaged = !arguments_.dev;
  const userData = arguments_.userData ?? appProfile(appDataPath(), homedir(), packaged || arguments_.installed).userData;
  if (arguments_.command === "pair") {
    const { requestPairing } = await import("./mobile/pairing-socket.mjs");
    const offer = await requestPairing(path.join(userData, "serve.sock")).catch((error: unknown) => {
      throw new Error(`No AI Coding Tool is serving here. Start one with \`aic serve\`. (${error instanceof Error ? error.message : String(error)})`);
    });
    console.log(await pairingText(offer));
    return;
  }
  const resources = packagedResources();
  const restarts = process.env[SERVE_RESTARTS_ENV] === "1";
  /** Kept from the agents and shells this server starts. */
  delete process.env[SERVE_RESTARTS_ENV];
  const served = await startServe({
    userData,
    packaged,
    installed: arguments_.installed,
    resources,
    port: arguments_.port,
    local: arguments_.local,
    say: (line) => console.log(line),
    ...(restarts ? { restart: () => stop("update", SERVE_RESTART_EXIT) } : {}),
  });
  console.log(`AI Coding Tool is serving from ${userData}. Press Ctrl+C to stop.`);
  function stop(reason: string, code = 0) {
    console.log(`Stopping (${reason})…`);
    served.stop().then(() => process.exit(code), (error) => {
      console.error(error);
      process.exit(1);
    });
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => stop(signal));
  if (resources) {
    const cli = await refreshCli().catch(() => null);
    if (!restarts && cli?.state === "installed" && cli.current) console.log("Start `aic serve` again to let this server update itself.");
  }
}

/** The command as a process: what stops it is said plainly and becomes the exit code. */
export function cli() {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

if (require.main === module) cli();
