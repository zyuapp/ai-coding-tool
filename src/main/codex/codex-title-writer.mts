import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TITLE_INSTRUCTIONS, cleanTitle, readableImages, titleQuestion } from "../agent/title-text.mjs";
import { codexExecutable } from "./codex-executable.mjs";

/** Runs the Codex binary once with `args`, feeding `input` on stdin, and resolves when it has exited. */
export type CodexExec = (args: readonly string[], input: string, cwd: string) => Promise<void>;

const TITLE_MODEL = "gpt-5.6-luna";
const EXEC_TIMEOUT_MS = 60_000;

const TITLE_SCHEMA = {
  type: "object",
  properties: { title: { type: "string", description: "At most six words; no quotes, no trailing punctuation." } },
  required: ["title"],
  additionalProperties: false,
};

/** One-shot, read-only, ephemeral, and blind to the user's own Codex config, so a title touches nothing. */
export function codexTitleArgs(schemaFile: string, outputFile: string, images: string[]) {
  return [
    "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
    "-s", "read-only",
    "-m", TITLE_MODEL,
    "-c", 'model_reasoning_effort="low"',
    "--output-schema", schemaFile,
    "--output-last-message", outputFile,
    ...images.flatMap((file) => ["-i", file]),
    "-",
  ];
}

const execCodex: CodexExec = (args, input, cwd) => new Promise((resolve, reject) => {
  const child = spawn(codexExecutable(), args, { cwd, stdio: ["pipe", "ignore", "ignore"], timeout: EXEC_TIMEOUT_MS, killSignal: "SIGKILL" });
  child.on("error", reject);
  child.on("close", () => resolve());
  child.stdin.on("error", () => {});
  child.stdin.end(input);
});

function titleOf(lastMessage: string) {
  try {
    const parsed: unknown = JSON.parse(lastMessage);
    const title = typeof parsed === "object" && parsed !== null && "title" in parsed ? parsed.title : undefined;
    return typeof title === "string" ? cleanTitle(title) || null : null;
  } catch {
    return null;
  }
}

/**
 * Names a thread from its first message and the screenshots sent with it, on Codex. The answer is
 * read back from the file `codex exec` writes its last message to, shaped by a schema that allows
 * nothing but a title.
 */
export async function suggestCodexTitle(text: string, attachments: string[] = [], exec: CodexExec = execCodex): Promise<string | null> {
  const images = await readableImages(attachments);
  if (!text.trim() && images.length === 0) return null;
  const directory = await mkdtemp(path.join(tmpdir(), "aicodingtool-title-"));
  try {
    const schemaFile = path.join(directory, "title.schema.json");
    const outputFile = path.join(directory, "title.json");
    await writeFile(schemaFile, JSON.stringify(TITLE_SCHEMA));
    await exec(codexTitleArgs(schemaFile, outputFile, images), `${TITLE_INSTRUCTIONS}\n\n${titleQuestion(text)}`, directory);
    return titleOf(await readFile(outputFile, "utf8"));
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
