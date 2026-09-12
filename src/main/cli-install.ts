import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CLI_INSTALL_PATH, cliConfiguration, isCliScript, type CliConfiguration, type CliStatus } from "../domain/cli.js";

const run = promisify(execFile);

export function createCliInstaller(configuration: CliConfiguration | null, platform: string, searchPath: () => string = () => process.env.PATH ?? "") {
  function result(state: CliStatus["state"], target = configuration?.installPath ?? CLI_INSTALL_PATH): CliStatus {
    const onPath = platform === "linux"
      ? searchPath().split(path.delimiter).some((entry) => path.resolve(entry) === path.dirname(target))
      : undefined;
    return { state, path: target, ...(onPath === undefined ? {} : { onPath }) };
  }

  async function status(): Promise<CliStatus> {
    if (!configuration) return result("unsupported");
    try {
      if (!(await lstat(configuration.installPath)).isFile()) return result("conflict");
      const contents = await readFile(configuration.installPath, "utf8");
      if (!isCliScript(contents)) return result("conflict");
      return { ...result("installed"), current: contents === configuration.script };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result("missing");
      throw error;
    }
  }

  async function install(): Promise<CliStatus> {
    const target = requireSupported(configuration);
    try {
      await mkdir(path.dirname(target.installPath), { recursive: true });
      const staged = `${target.installPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(staged, target.script, { encoding: "utf8", mode: 0o755, flag: "wx" });
        await chmod(staged, 0o755);
        await rename(staged, target.installPath);
      } finally {
        await rm(staged, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (!isPermissionError(error) || platform !== "darwin") throw error;
      await elevate(cliInstallCommand(target));
    }
    return status();
  }

  async function uninstall(): Promise<CliStatus> {
    const target = requireSupported(configuration);
    try {
      await rm(target.installPath, { force: true });
    } catch (error) {
      if (!isPermissionError(error) || platform !== "darwin") throw error;
      await elevate(`/bin/rm -f ${shellQuote(target.installPath)}`);
    }
    return status();
  }

  return { status, install, uninstall };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Only known bytes cross elevation. The elevated process owns its private staging directory. */
export function cliInstallCommand(target: CliConfiguration) {
  return [
    "set -eu",
    "umask 077",
    'stage=$(/usr/bin/mktemp -d /private/tmp/aic-cli-install.XXXXXXXX)',
    `trap '/bin/rm -rf "$stage"' EXIT`,
    `/usr/bin/printf '%s' ${shellQuote(Buffer.from(target.script, "utf8").toString("base64"))} | /usr/bin/base64 -D > "$stage/aic"`,
    '/bin/chmod 755 "$stage/aic"',
    `/bin/mkdir -p ${shellQuote(path.dirname(target.installPath))}`,
    `/bin/mv -fh "$stage/aic" ${shellQuote(target.installPath)}`,
  ].join("\n");
}

function requireSupported(configuration: CliConfiguration | null): CliConfiguration {
  if (!configuration) throw new Error("The aic command can only be installed on macOS or Linux.");
  return configuration;
}

function isPermissionError(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

/** /usr/local/bin belongs to root on a stock Mac, so writing there asks for the password once. */
async function elevate(command: string) {
  try {
    await run("/usr/bin/osascript", ["-e", `do shell script ${JSON.stringify(command)} with administrator privileges`]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/User canceled|-128/.test(message)) throw new Error("Cancelled.");
    throw new Error(message.trim() || "The command could not be installed.");
  }
}

/**
 * What the installed script runs for `aic serve`: the AppImage that holds this app on Linux, else the
 * binary itself. A source run names Electron's own binary, which holds no app to serve.
 */
const installedApp = process.env.APPIMAGE ?? process.execPath;

const runtimeInstaller = createCliInstaller(cliConfiguration(process.platform, homedir(), installedApp), process.platform);
export const cliStatus = runtimeInstaller.status;
export const installCli = runtimeInstaller.install;
export const uninstallCli = runtimeInstaller.uninstall;
