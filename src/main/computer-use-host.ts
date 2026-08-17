import { app, systemPreferences } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver" with { "resolution-mode": "import" };
import type { ComputerUsePermissions, ComputerUseRunConfig } from "../contracts/ipc.js";

const bundleId = "com.zyuapp.claudex";
let host: EmbeddedCuaDriverHost | null = null;

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

export async function requestComputerUsePermissions(): Promise<ComputerUsePermissions> {
  if (process.platform !== "darwin") return { accessibility: false, screenRecording: false };
  const current = await computerUsePermissions();
  if (!current.accessibility) {
    systemPreferences.isTrustedAccessibilityClient(true);
    return computerUsePermissions();
  }
  const { openMacOSScreenRecordingSettings, requestMacOSPermissions } = await cuaElectron();
  const status = requestMacOSPermissions();
  if (!status.screenRecording) await openMacOSScreenRecordingSettings();
  return status;
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
  if (process.platform !== "darwin") return { status: "unavailable", message: "Computer use is currently available only on macOS." };
  const permissions = await computerUsePermissions();
  if (!permissions.accessibility || !permissions.screenRecording) return { status: "setup-required" };
  const executable = binaryPath();
  if (!existsSync(executable)) return { status: "unavailable", message: "The bundled Cua Driver executable is missing." };
  if (!host) {
    const { EmbeddedCuaDriverHost: Host } = await cuaDriver();
    host = new Host(executable, bundleId);
  }
  return mcpConfig(host.connection() ?? await host.start());
}

export async function stopComputerUse() {
  if (!host) return;
  const current = host;
  host = null;
  await current.stop();
  current.uniffiDestroy();
}
