import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
    "X-AICodingTool-AppImageIntegration=true",
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
  /** Injected only by tests; production queries the user's XDG MIME association. */
  isAssociated?: (desktopFile: string) => Promise<boolean>;
};

type ExistingIntegrationFile =
  | { kind: "missing" | "symlink" | "other" }
  | { kind: "file"; contents: Buffer };

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function existingIntegrationFile(file: string): Promise<ExistingIntegrationFile> {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    if (missing(error)) return { kind: "missing" };
    throw error;
  }
  if (details.isSymbolicLink()) return { kind: "symlink" };
  if (!details.isFile()) return { kind: "other" };
  return { kind: "file", contents: await readFile(file) };
}

/** Recognize entries written before the ownership marker existed so moved AppImages still repair. */
function isOwnedDesktopEntry(contents: Buffer) {
  const lines = new Set(contents.toString("utf8").split(/\r?\n/));
  return lines.has("[Desktop Entry]")
    && lines.has("Name=AI Coding Tool")
    && lines.has("StartupWMClass=com.zyuapp.aicodingtool")
    && lines.has(`MimeType=x-scheme-handler/${CLI_URL_SCHEME};`);
}

function mayReplace(kind: ExistingIntegrationFile["kind"], target: string) {
  if (kind === "other") throw new Error(`Refusing to replace a non-file Linux integration path: ${target}`);
  return kind === "missing" || kind === "symlink";
}

async function associationIsCurrent(desktopFile: string) {
  const mime = `x-scheme-handler/${CLI_URL_SCHEME}`;
  try {
    const { stdout } = await run("xdg-mime", ["query", "default", mime], { timeout: 2_000 });
    return stdout.trim() === desktopFile;
  } catch {
    try {
      const { stdout } = await run("gio", ["mime", mime], {
        timeout: 2_000,
        env: { ...process.env, LC_ALL: "C" },
      });
      return stdout.split(/\r?\n/, 1)[0]?.trim().endsWith(`: ${desktopFile}`) ?? false;
    } catch {
      return false;
    }
  }
}

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
  if (!path.isAbsolute(options.iconSource)) throw new Error("The AppImage icon path is not absolute.");
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
  const desktopContents = Buffer.from(appImageDesktopEntry(options.appImage), "utf8");
  const [iconContents, currentDesktop, currentIcon] = await Promise.all([
    readFile(options.iconSource),
    existingIntegrationFile(desktopPath),
    existingIntegrationFile(iconPath),
  ]);
  const desktopIsCurrent = currentDesktop.kind === "file" && currentDesktop.contents.equals(desktopContents);
  const desktopIsOwned = currentDesktop.kind === "file" && isOwnedDesktopEntry(currentDesktop.contents);
  const writeDesktop = !desktopIsCurrent;
  if (writeDesktop && !desktopIsOwned && !mayReplace(currentDesktop.kind, desktopPath)) {
    throw new Error(`Refusing to overwrite an unrelated desktop entry: ${desktopPath}`);
  }
  const iconIsCurrent = currentIcon.kind === "file" && currentIcon.contents.equals(iconContents);
  const writeIcon = !iconIsCurrent;
  /** The reverse-DNS icon path is ours even when a user deleted the companion desktop entry. */
  if (writeIcon && currentIcon.kind === "other") {
    throw new Error(`Refusing to replace a non-file Linux integration path: ${iconPath}`);
  }

  if (writeDesktop || writeIcon) {
    await Promise.all([mkdir(applications, { recursive: true }), mkdir(icons, { recursive: true })]);
  }
  try {
    await Promise.all([
      writeIcon ? writeFile(stagedIcon, iconContents, { mode: 0o644, flag: "wx" }) : undefined,
      writeDesktop ? writeFile(stagedDesktop, desktopContents, { mode: 0o644, flag: "wx" }) : undefined,
    ]);
    if (writeIcon) await rename(stagedIcon, iconPath);
    if (writeDesktop) await rename(stagedDesktop, desktopPath);
  } finally {
    await Promise.all([
      rm(stagedDesktop, { force: true }).catch(() => undefined),
      rm(stagedIcon, { force: true }).catch(() => undefined),
    ]);
  }
  const associated = options.isAssociated
    ? await options.isAssociated(LINUX_DESKTOP_FILE)
    : options.associate
      ? false
      : await associationIsCurrent(LINUX_DESKTOP_FILE);
  if (!associated) await (options.associate ?? associate)(LINUX_DESKTOP_FILE);
  return { desktopPath, iconPath, filesChanged: writeDesktop || writeIcon, associationChanged: !associated };
}
