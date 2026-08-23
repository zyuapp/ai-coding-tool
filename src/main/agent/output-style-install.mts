import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PLAIN_ENGLISH_FILE, PLAIN_ENGLISH_STYLE, PLAIN_ENGLISH_STYLE_FILE } from "../../domain/output-style.js";

function outputStylesDir(env = process.env, home = homedir()) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "output-styles");
}

/**
 * Puts the plain-English style where Claude Code looks for it, and only when nothing is there: the
 * file is the user's to edit afterwards, so a rewrite would throw their wording away.
 */
export async function installPlainEnglishStyle(style: string | undefined, dir = outputStylesDir()): Promise<void> {
  if (style !== PLAIN_ENGLISH_STYLE) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, PLAIN_ENGLISH_FILE), PLAIN_ENGLISH_STYLE_FILE, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}
