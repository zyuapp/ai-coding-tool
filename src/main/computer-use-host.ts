import { app, shell, systemPreferences } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver" with { "resolution-mode": "import" };
import type { ComputerUsePermission, ComputerUsePermissions, ComputerUseRunConfig } from "../contracts/ipc.js";

const bundleId = "com.zyuapp.claudex";
let host: EmbeddedCuaDriverHost | null = null;
let acceptingRuns = true;

function packagedModule(file: string) {
  return pathToFileURL(path.join(process.resourcesPath, "cua-sdk", "node_modules", "@trycua", "cua-driver", "dist", file)).href;
}

async function cuaDriver() {
  return app.isPackaged
    ? import(packagedModule("index.js")) as Promise<typeof import("@trycua/cua-driver", { with: { "resolution-mode": "import" } })>
    : import("@trycua/cua-driver");
}

async function cuaElectron() {
  return app.isPackaged
    ? import(packagedModule("electron.js")) as Promise<typeof import("@trycua/cua-driver/electron", { with: { "resolution-mode": "import" } })>
    : import("@trycua/cua-driver/electron");
}

async function probeScreenRecordingRegistration() {
  const { CuaDriver } = await cuaDriver();
  const driver = CuaDriver.create(undefined) as ReturnType<typeof CuaDriver.create> & { uniffiDestroy(): void };
  try {
    await driver.getDesktopState({});
  } finally {
    try {
      await driver.shutdown();
    } finally {
      driver.uniffiDestroy();
    }
  }
}

function binaryPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "cua-driver")
    : path.join(app.getAppPath(), "vendor", "cua-driver", "cua-driver");
}

export async function computerUsePermissions(): Promise<ComputerUsePermissions> {
  if (process.platform !== "darwin") return { accessibility: false, screenRecording: false };
  const { currentMacOsPermissionStatus } = await cuaDriver();
  return currentMacOsPermissionStatus();
}

export async function requestComputerUsePermission(permission: ComputerUsePermission): Promise<ComputerUsePermissions> {
  if (process.platform !== "darwin") return { accessibility: false, screenRecording: false };
  if (permission === "accessibility") {
    if (!systemPreferences.isTrustedAccessibilityClient(true)) await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    return computerUsePermissions();
  }
  const { openMacOSScreenRecordingSettings, requestMacOSPermissions } = await cuaElectron();
  const status = requestMacOSPermissions();
  if (!status.screenRecording) await probeScreenRecordingRegistration().catch(() => undefined);
  const next = await computerUsePermissions();
  if (!next.screenRecording) await openMacOSScreenRecordingSettings();
  return next;
}

function mcpConfig(connection: EmbeddedDriverConnection): ComputerUseRunConfig {
  return {
    status: "available",
    mcp: {
      command: connection.mcp.command,
      args: connection.mcp.args,
      env: Object.fromEntries(connection.mcp.environment.map(({ name, value }) => [name, value])),
    },
  };
}

export async function computerUseForRun(): Promise<ComputerUseRunConfig> {
  if (!acceptingRuns) return { status: "unavailable", message: "Claudex is quitting." };
  if (process.platform !== "darwin") return { status: "unavailable", message: "Computer use is currently available only on macOS." };
  const permissions = await computerUsePermissions();
  if (!acceptingRuns) return { status: "unavailable", message: "Claudex is quitting." };
  if (!permissions.accessibility || !permissions.screenRecording) return { status: "setup-required" };
  const executable = binaryPath();
  if (!existsSync(executable)) return { status: "unavailable", message: "The bundled Cua Driver executable is missing." };
  if (!host) {
    const { EmbeddedCuaDriverHost: Host } = await cuaDriver();
    if (!acceptingRuns) return { status: "unavailable", message: "Claudex is quitting." };
    host = new Host(executable, bundleId);
  }
  return mcpConfig(host.connection() ?? await host.start());
}

export async function stopComputerUse() {
  acceptingRuns = false;
  if (!host) return;
  const current = host;
  host = null;
  try {
    await current.stop();
  } finally {
    current.uniffiDestroy();
  }
}
