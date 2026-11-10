import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cliConfiguration } from "../domain/cli.js";
import { appImageDesktopEntry, LINUX_DESKTOP_FILE } from "./linux-protocol.js";

/** The updater emits this after moving the image, including during synchronous quit handling. */
export function registerAppImageUpdateRepair(updater: Pick<EventEmitter, "on">, options: {
  appImage: string;
  home: string;
  dataHome?: string;
}) {
  updater.on("appimage-filename-updated", (destination: string) => {
    const dataHome = options.dataHome && path.isAbsolute(options.dataHome)
      ? options.dataHome
      : path.join(options.home, ".local", "share");
    const oldCli = cliConfiguration("linux", options.home, options.appImage)!;
    const newCli = cliConfiguration("linux", options.home, destination)!;
    const files = [
      { target: path.join(dataHome, "applications", LINUX_DESKTOP_FILE), before: appImageDesktopEntry(options.appImage), after: appImageDesktopEntry(destination), mode: 0o644 },
      { target: oldCli.installPath, before: oldCli.script, after: newCli.script, mode: 0o755 },
    ];
    for (const file of files) {
      try {
        // Preserve removed, redirected, customized, and other installations' launchers.
        if (!lstatSync(file.target).isFile() || readFileSync(file.target, "utf8") !== file.before) continue;
        const staged = `${file.target}.${randomUUID()}.tmp`;
        try {
          writeFileSync(staged, file.after, { mode: file.mode, flag: "wx" });
          renameSync(staged, file.target);
        } finally {
          rmSync(staged, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`Could not refresh AppImage launcher ${file.target}:`, error);
        }
      }
    }
  });
}
