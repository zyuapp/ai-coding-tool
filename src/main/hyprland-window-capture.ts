import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { WindowShot } from "./window-screenshot.js";

const windowSchema = z.object({
  stableId: z.string().min(1).max(128).regex(/^[\w-]+$/),
  pid: z.number().int().positive(),
  class: z.string(),
  title: z.string(),
  at: z.tuple([z.number().finite(), z.number().finite()]),
  size: z.tuple([z.number().positive().finite(), z.number().positive().finite()]),
});

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** Capture the selected toplevel, never a screen crop that could include an overlapping window. */
export async function captureFrontmostHyprlandWindow(): Promise<WindowShot> {
  let directory: string | null = null;
  try {
    const active: unknown = JSON.parse(await run("hyprctl", ["-j", "activewindow"]));
    if (typeof active !== "object" || active === null || Array.isArray(active)) throw new Error("Hyprland returned invalid window information.");
    if (Object.keys(active).length === 0 || ("mapped" in active && active.mapped === false) || ("hidden" in active && active.hidden === true)) {
      return { status: "no-window", app: "the desktop" };
    }
    if ("pid" in active && active.pid === process.pid) return { status: "no-window", app: "AI Coding Tool" };
    const parsed = windowSchema.safeParse(active);
    if (!parsed.success) {
      return { status: "failed", message: "Hyprland did not provide a usable window ID or size. Update Hyprland and grim, then try again." };
    }
    const window = parsed.data;
    directory = await mkdtemp(path.join(tmpdir(), "aic-shot-"));
    const file = path.join(directory, "window.png");
    await run("grim", ["-T", window.stableId, "-t", "png", file]);
    const png = await readFile(file);
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      return { status: "failed", message: "Hyprland returned an empty or invalid window image. Try capturing the window again." };
    }
    return {
      status: "captured",
      app: window.class || "Unknown app",
      title: window.title,
      png: png.toString("base64"),
      frame: { x: window.at[0], y: window.at[1], width: window.size[0], height: window.size[1] },
    };
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return { status: "failed", message: "Hyprland window capture needs hyprctl and grim. Install or update those tools, then try again." };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return { status: "failed", message: `Could not capture the active Hyprland window: ${message}` };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
