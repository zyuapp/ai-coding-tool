import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CLI_INSTALL_PATH, cliConfiguration, isCliScript, type CliConfiguration, type CliStatus } from "../domain/cli.js";

const run = promisify(execFile);
const STAGING_PATH = path.join(tmpdir(), "aic-cli-install");

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
      if (platform === "linux" && !(await lstat(configuration.installPath)).isFile()) return result("conflict");
      const contents = await readFile(configuration.installPath, "utf8");
      return result(isCliScript(contents) ? "installed" : "conflict");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result("missing");
      throw error;
    }
  }

  async function install(): Promise<CliStatus> {
    const target = requireSupported(configuration);
    if (platform === "linux") {
      await mkdir(path.dirname(target.installPath), { recursive: true });
      const staged = `${target.installPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(staged, target.script, { encoding: "utf8", mode: 0o755, flag: "wx" });
        await chmod(staged, 0o755);
        await rename(staged, target.installPath);
      } finally {
        await rm(staged, { force: true }).catch(() => undefined);
      }
      return status();
    }
    try {
      await mkdir(path.dirname(target.installPath), { recursive: true });
      await writeFile(target.installPath, target.script, "utf8");
      await chmod(target.installPath, 0o755);
    } catch (error) {
      if (!isPermissionError(error) || platform !== "darwin") throw error;
      await writeFile(STAGING_PATH, target.script, "utf8");
      try {
        await elevate(`mkdir -p '${path.dirname(target.installPath)}' && cp '${STAGING_PATH}' '${target.installPath}' && chmod 755 '${target.installPath}'`);
      } finally {
        await rm(STAGING_PATH, { force: true });
      }
    }
    return status();
  }

  async function uninstall(): Promise<CliStatus> {
    const target = requireSupported(configuration);
    try {
      await rm(target.installPath, { force: true });
    } catch (error) {
      if (!isPermissionError(error) || platform !== "darwin") throw error;
      await elevate(`rm -f '${target.installPath}'`);
    }
    return status();
  }

  return { status, install, uninstall };
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

const runtimeInstaller = createCliInstaller(cliConfiguration(process.platform, homedir()), process.platform);
export const cliStatus = runtimeInstaller.status;
export const installCli = runtimeInstaller.install;
export const uninstallCli = runtimeInstaller.uninstall;
