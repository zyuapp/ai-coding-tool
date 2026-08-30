import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loginShellSessionOptions } from "./platform-capabilities.js";

const execFileAsync = promisify(execFile);

/** Room for a shell with heavy start-up files, short enough that the window is not held back on one. */
const TIMEOUT_MS = 5_000;

/** Printed either side of the environment, so whatever a start-up file prints of its own is skipped. */
const MARK = "__aic_environment__";

/** Where a Mac keeps tools that launchd's own search path never lists, in the order a shell looks. */
function toolFolders(home: string) {
  return ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.join(home, ".local", "bin")];
}

/** The search path a shell reported, read off the `PATH=` line of the environment between the marks. */
export function searchPathFromEnvironment(output: string): string | null {
  const start = output.indexOf(MARK);
  if (start < 0) return null;
  const end = output.indexOf(MARK, start + MARK.length);
  if (end < 0) return null;
  for (const line of output.slice(start + MARK.length, end).split("\n")) {
    if (line.startsWith("PATH=")) return line.slice("PATH=".length).trim() || null;
  }
  return null;
}

/** One search path out of several, first mention winning, so the order the shell gave is the order kept. */
export function mergeSearchPaths(...paths: (string | null | undefined)[]) {
  const folders: string[] = [];
  for (const value of paths) {
    for (const folder of (value ?? "").split(path.delimiter)) {
      if (folder && !folders.includes(folder)) folders.push(folder);
    }
  }
  return folders.join(path.delimiter);
}

/**
 * The environment the user's shell starts with. Login and interactive, because a search path can be
 * written in the files that only one of those reads.
 */
async function loginShellEnvironment(shell: string) {
  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", `printf '${MARK}'; /usr/bin/env; printf '${MARK}'`], {
      timeout: TIMEOUT_MS,
      encoding: "utf8",
      ...loginShellSessionOptions(),
    });
    return stdout;
  } catch (error) {
    /** A start-up file that fails afterwards has already printed the environment, and the marks find it. */
    return String((error as { stdout?: string }).stdout ?? "");
  }
}

async function present(folder: string) {
  return access(folder).then(() => true, () => false);
}

/**
 * Gives this process the search path the user's own shell has. macOS starts an app from the Dock with
 * four system folders and nothing else, so without this every command the app runs — `gh`, and
 * whatever an agent's shell calls — is looked for where the user installed nothing.
 *
 * Every child process inherits the result, so this runs once, before the app spawns anything.
 */
export async function adoptLoginShellPath() {
  if (process.platform === "win32") return;
  const shell = process.env.SHELL || "/bin/zsh";
  const reported = searchPathFromEnvironment(await loginShellEnvironment(shell));
  const installed = await Promise.all(toolFolders(homedir()).map(async (folder) => ((await present(folder)) ? folder : "")));
  /** The shell's answer leads, what the app was started with follows, and the standard folders last. */
  process.env.PATH = mergeSearchPaths(reported, process.env.PATH, installed.join(path.delimiter));
}
