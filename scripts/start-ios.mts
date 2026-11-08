import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Builds the desktop and the iOS app, runs the desktop headless on this checkout's own data folder,
 * and opens the app in a simulator paired with it. The desktop keeps one port (IOS_DESKTOP_PORT, or
 * 7738 beside the installed app's), so the app stays paired from one run to the next. IOS_SIMULATOR
 * picks the device by name or UDID; otherwise the newest iPhone runtime's first iPhone is used.
 */
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const ios = path.join(root, "ios");
const serve = path.join(root, "dist/main/main/serve.js");
const appPath = path.join(ios, "build/DerivedData/Build/Products/Debug-iphonesimulator/AICodingTool.app");
const bundleId = "com.zyuapp.aicodingtool.phone";

function step(command: string, args: string[], cwd = root): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args[0] ?? ""} exited with ${code}`))));
  });
}

type Device = { udid: string; name: string; state: string; isAvailable: boolean };

async function simulator(): Promise<Device> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
  const runtimes = Object.entries(JSON.parse(stdout).devices as Record<string, Device[]>)
    .filter(([runtime]) => runtime.includes("iOS"))
    .sort(([left], [right]) => right.localeCompare(left, undefined, { numeric: true }));
  const wanted = process.env.IOS_SIMULATOR;
  for (const [, devices] of runtimes) {
    const device = devices.find((candidate) => (wanted ? candidate.udid === wanted || candidate.name === wanted : candidate.name.startsWith("iPhone")));
    if (device) return device;
  }
  throw new Error(wanted ? `No available simulator named ${wanted}.` : "No iPhone simulator is installed. Add one in Xcode › Settings › Components.");
}

/** Starts the headless desktop and resolves once its phone bridge is listening. */
function startDesktop(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", serve, "serve", "--dev", "--local", "--port", process.env.IOS_DESKTOP_PORT ?? "7738"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`The desktop stopped before it was ready (exit ${code}).`)));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      console.log(line);
      if (/^Listening on port \d+/.test(line)) resolve(child);
    });
  });
}

async function pairingLink(): Promise<string> {
  const { stdout } = await run(process.execPath, ["--disable-warning=ExperimentalWarning", serve, "pair", "--dev"], { cwd: root });
  const link = /open (\S+)/.exec(stdout)?.[1];
  if (!link) throw new Error(`No pairing link in: ${stdout.trim()}`);
  return link;
}

const device = await simulator();
console.log(`Building the desktop and the app for ${device.name}…`);
await Promise.all([
  step("npm", ["run", "build", "--silent"]),
  step("xcodegen", ["generate", "--quiet"], ios).then(() =>
    step("xcodebuild", ["-quiet", "-project", "AICodingTool.xcodeproj", "-scheme", "AICodingTool", "-destination", `id=${device.udid}`, "-derivedDataPath", "build/DerivedData", "build"], ios)),
]);

if (device.state !== "Booted") await run("xcrun", ["simctl", "boot", device.udid]);
await run("open", ["-a", "Simulator"]);
await run("xcrun", ["simctl", "install", device.udid, appPath]);

const desktop = await startDesktop();
desktop.removeAllListeners("exit");
desktop.on("exit", (code) => process.exit(code ?? 0));
const link = await pairingLink();
await run("xcrun", ["simctl", "terminate", device.udid, bundleId]).catch(() => undefined);
await run("xcrun", ["simctl", "launch", device.udid, bundleId], { env: { ...process.env, SIMCTL_CHILD_AIC_PAIR_LINK: link } });
console.log(`Running on ${device.name}. Press Ctrl+C to stop the desktop.`);

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => desktop.kill("SIGINT"));
