import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { emptyTailscaleState, type MobilePairingOffer, type MobileServerState } from "../domain/mobile.js";
import { createRuntimePublisher } from "../host/runtime-publisher.js";
import { createWorkspaceRuntime } from "../host/workspace-runtime.js";
import { forkAgentProcessNode } from "./agent-process-node.js";
import { appPluginPath } from "./app-plugin-path.js";
import { useAttachmentsDirectory } from "./attachment-store.js";
import { createDesktopEvents } from "./desktop-events.js";
import { createJsonStorage } from "./json-storage.js";
import { useMessageImageStore } from "./message-image-store.js";
import { startRunHost } from "./run-host.js";
import { createServeDesktop } from "./serve-desktop.js";
import { appProfile } from "./user-data.js";
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { EngineAccessHost } from "./agent/engine-services.mjs" with { "resolution-mode": "import" };
import type { TaskDatabaseService } from "./task-database-service.mjs" with { "resolution-mode": "import" };
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { WorktreeService } from "./workspace/worktrees.mjs" with { "resolution-mode": "import" };

/** What `aic serve` and `aic pair` were asked for. */
export type ServeArguments = {
  command: "serve" | "pair";
  /** A source checkout's own data folder, apart from the installed app's. */
  dev: boolean;
  /** A data folder named outright, which a test uses so nothing it does lands in the user's. */
  userData?: string;
  /** The port to ask for; 0 takes whatever is free. */
  port?: number;
  /** Loopback only: Tailscale is left alone, which a test on a developer's machine must do. */
  local: boolean;
};

export function parseServeArguments(argv: readonly string[]): ServeArguments {
  const parsed: ServeArguments = { command: "serve", dev: false, local: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "serve" || argument === "pair") parsed.command = argument;
    else if (argument === "--dev") parsed.dev = true;
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

/** A second server on the same data would write over the first, as would the desktop app itself. */
function claimInstance(userData: string) {
  const lock = path.join(userData, "serve.lock");
  const holder = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : NaN;
  if (Number.isInteger(holder) && holder !== process.pid && alive(holder)) throw new Error(`AI Coding Tool is already serving from this folder (process ${holder}).`);
  if (existsSync(path.join(userData, "SingletonLock"))) throw new Error("The desktop app is open on this data folder. Quit it before serving, or serve from another machine.");
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pairingLine(offer: MobilePairingOffer) {
  return `Pair with code ${offer.code} (expires in ${Math.round((offer.expiresAt - Date.now()) / 60_000)} minutes) or open ${offer.url}`;
}

/** Runs the application headless: every service the desktop app has, reachable only through the bridge. */
/** Tailscale as a host that must not touch it sees it: absent, so the bridge stays on the loopback. */
const NO_TAILSCALE = {
  read: async () => ({ ...emptyTailscaleState(), status: "missing" as const }),
  start: async () => ({ ok: false as const, message: "Tailscale is off for this server." }),
  stop: async () => ({ ok: true as const }),
};

export async function startServe(options: { userData: string; packaged: boolean; resources: string | null; port?: number; local?: boolean; say: (line: string) => void }) {
  const { userData, say } = options;
  mkdirSync(userData, { recursive: true });
  const release = claimInstance(userData);
  useAttachmentsDirectory(userData);
  useMessageImageStore({ directory: path.join(userData, "message-images"), thumbnail: () => null });
  const { PRIVATE_CODEX_HOME_ENV } = await import("./codex/codex-home.mjs");
  process.env[PRIVATE_CODEX_HOME_ENV] = path.join(userData, "codex-private");
  const { setAppPluginRoot } = await import("./app-plugin.mjs");
  const appPath = options.resources ? path.join(options.resources, "app.asar") : path.resolve(__dirname, "..", "..", "..");
  setAppPluginRoot(appPluginPath(options.packaged, options.resources ?? "", appPath));

  const worktreesRoot = appProfile(appDataPath(), homedir(), options.packaged).worktreesRoot;
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
  const desktop = createServeDesktop({
    events,
    runs,
    workspaces: () => workspaces,
    worktrees: () => worktrees,
    taskDatabase: () => taskDatabase,
    scheduler: () => scheduler!,
    engineAccess: () => engineAccess ??= import("./agent/engine-services.mjs").then(({ EngineAccessHost }) => new EngineAccessHost()),
    worktreesRoots: () => [worktreesRoot, ...legacyRoots],
    mobile: () => mobile,
    say,
  });
  const runtime = createWorkspaceRuntime({ desktop, storage: createJsonStorage(path.join(userData, "window.v1.json")) });
  const publisher = createRuntimePublisher(runtime);
  await runtime.start();
  /** Neither panel exists here, so no run is handed tools for them. */
  await runtime.dispatch({ type: "view.set-browser-tools", enabled: false });
  await runtime.dispatch({ type: "view.set-computer-use", enabled: false });

  let served: string | null = null;
  const { servePairingSocket } = await import("./mobile/development.mjs");
  await mobile.startMobileHost({
    userData,
    staticRoot: path.join(__dirname, "..", "..", "mobile"),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.local ? { tailscale: NO_TAILSCALE } : {}),
    send: (request) => events.emit("mobile:request", request),
    onState: (state: MobileServerState) => {
      events.emit("mobile:changed", state);
      const name = state.tailscale.serving ? state.tailscale.magicDnsName : null;
      if (name && name !== served) {
        served = name;
        say(`Serving as https://${name}`);
        mobile.createMobilePairingCode().then((offer) => say(pairingLine(offer))).catch(() => undefined);
      }
      if (state.error) say(`Bridge: ${state.error}`);
    },
  });
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
      await publisher.flush().catch((error) => say(`Could not save the workspace: ${error instanceof Error ? error.message : String(error)}`));
      scheduler?.stop();
      runs.clearPendingStarts();
      runs.killAgent();
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
  const userData = arguments_.userData ?? appProfile(appDataPath(), homedir(), packaged).userData;
  if (arguments_.command === "pair") {
    const { requestPairing } = await import("./mobile/development.mjs");
    const offer = await requestPairing(path.join(userData, "serve.sock")).catch((error: unknown) => {
      throw new Error(`No AI Coding Tool is serving here. Start one with \`aic serve\`. (${error instanceof Error ? error.message : String(error)})`);
    });
    console.log(pairingLine(offer));
    return;
  }
  const served = await startServe({ userData, packaged, resources: packagedResources(), port: arguments_.port, local: arguments_.local, say: (line) => console.log(line) });
  console.log(`AI Coding Tool is serving from ${userData}. Press Ctrl+C to stop.`);
  const stop = (signal: string) => {
    console.log(`Stopping (${signal})…`);
    served.stop().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => stop(signal));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
