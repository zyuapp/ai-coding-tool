import { spawn } from "node:child_process";
import { shell } from "electron";
import { editorCandidates, editorLaunch, textHandlerLaunch, type Launch, type Platform } from "../domain/editors.js";

/** Narrowed once here: a platform the domain does not know simply offers nothing to try. */
const PLATFORM = process.platform as Platform;

/**
 * Starts a launcher and reports whether it was there. Trying to spawn is the probe: a missing
 * editor fails with ENOENT before it can do anything, and one that exists is already opening.
 */
function launch({ command, args }: Launch) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

/** The launcher that answered last time, so later clicks skip the ones that already missed. */
let resolved: string | null = null;

/** Opens a source file for reading, at its line where the editor it finds takes one. */
export async function openInEditor(file: string, line: number | null) {
  if (resolved) {
    const known = editorLaunch(PLATFORM, resolved, file, line);
    if (known && (await launch(known))) return;
    resolved = null;
  }

  for (const candidate of editorCandidates(PLATFORM, file, line)) {
    if (!(await launch(candidate))) continue;
    resolved = candidate.command;
    return;
  }

  const handler = textHandlerLaunch(PLATFORM, file);
  if (handler && (await launch(handler))) return;

  const failure = await shell.openPath(file);
  if (!failure) return;
  shell.showItemInFolder(file);
}
