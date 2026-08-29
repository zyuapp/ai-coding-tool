import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CLI_URL_SCHEME } from "../domain/cli.js";

export const LINUX_DESKTOP_FILE = "com.zyuapp.aicodingtool.desktop";
const LINUX_ICON_NAME = "com.zyuapp.aicodingtool";
const run = promisify(execFile);

/** Desktop-entry Exec quoting has its own escaping rules and never invokes a shell. */
function desktopExec(value: string) {
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error("The AppImage path is not safe to register.");
  return `"${value.replace(/%/g, "%%").replace(/([\\"`$])/g, "\\$1")}"`;
}

export function appImageDesktopEntry(appImage: string) {
  const executable = desktopExec(appImage);
  return [
    "[Desktop Entry]",
    "Name=AI Coding Tool",
    "Comment=A fast local desktop client for Claude and Codex coding tasks.",
    `Exec=${executable} %U`,
    "Terminal=false",
    "Type=Application",
    `Icon=${LINUX_ICON_NAME}`,
    "Categories=Development;",
    "StartupWMClass=com.zyuapp.aicodingtool",
    `MimeType=x-scheme-handler/${CLI_URL_SCHEME};`,
    "",
  ].join("\n");
}

export type AppImageProtocolRegistration = {
  appImage: string;
  home: string;
  iconSource: string;
  /** Defaults to ~/.local/share; an absolute XDG_DATA_HOME takes its place. */
  dataHome?: string;
  /** Injected only by tests; production asks the desktop through the normal commands below. */
  associate?: (desktopFile: string) => Promise<void>;
};

async function associate(desktopFile: string) {
  try {
    await run("xdg-mime", ["default", desktopFile, `x-scheme-handler/${CLI_URL_SCHEME}`], { timeout: 10_000 });
  } catch (first) {
    try {
      await run("gio", ["mime", `x-scheme-handler/${CLI_URL_SCHEME}`, desktopFile], { timeout: 10_000 });
    } catch {
      throw first;
    }
  }
}

/**
 * AppImages are portable and therefore may have no installed desktop entry. Register this app's
 * current absolute file in user-writable XDG locations; moving it is repaired on its next launch.
 */
export async function registerAppImageProtocol(options: AppImageProtocolRegistration) {
  if (!path.isAbsolute(options.home)) throw new Error("The home directory is not absolute.");
  const dataHome = options.dataHome && path.isAbsolute(options.dataHome)
    ? options.dataHome
    : path.join(options.home, ".local", "share");
  const applications = path.join(dataHome, "applications");
  const icons = path.join(dataHome, "icons", "hicolor", "256x256", "apps");
  const desktopPath = path.join(applications, LINUX_DESKTOP_FILE);
  const iconPath = path.join(icons, `${LINUX_ICON_NAME}.png`);
  const nonce = `${process.pid}.${randomUUID()}`;
  const stagedDesktop = `${desktopPath}.${nonce}.tmp`;
  const stagedIcon = `${iconPath}.${nonce}.tmp`;
  await Promise.all([mkdir(applications, { recursive: true }), mkdir(icons, { recursive: true })]);
  try {
    await copyFile(options.iconSource, stagedIcon, fsConstants.COPYFILE_EXCL);
    await writeFile(stagedDesktop, appImageDesktopEntry(options.appImage), { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(stagedIcon, iconPath);
    await rename(stagedDesktop, desktopPath);
  } finally {
    await Promise.all([
      rm(stagedDesktop, { force: true }).catch(() => undefined),
      rm(stagedIcon, { force: true }).catch(() => undefined),
    ]);
  }
  await (options.associate ?? associate)(LINUX_DESKTOP_FILE);
  return { desktopPath, iconPath };
}
