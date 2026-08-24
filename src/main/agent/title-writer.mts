import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { clampTitle } from "../../domain/task.js";
import { packagedClaudeExecutable } from "./claude-agent-provider.mjs";

type QueryFactory = typeof query;
type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } };

const MESSAGE_LIMIT = 2_000;
const IMAGE_LIMIT = 2;
const IMAGE_BYTE_LIMIT = 1024 * 1024;
const instructions = "You name chat threads. Answer with a title of at most six words describing what the message and any screenshots with it are about, and nothing else: no quotes, no trailing punctuation, no preamble.";

function cleanTitle(text: string) {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return clampTitle(line.replace(/^["'`]+|["'`]+$/g, "").replace(/\.+$/, ""));
}

async function imageBlocks(attachments: string[]): Promise<ImageBlock[]> {
  const read = await Promise.all(attachments.slice(0, IMAGE_LIMIT).map(async (file) => {
    try {
      const metadata = await stat(file);
      if (!metadata.isFile() || metadata.size === 0 || metadata.size > IMAGE_BYTE_LIMIT) return null;
      const bytes = await readFile(file);
      if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_BYTE_LIMIT) return null;
      return { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } } as const;
    } catch {
      return null;
    }
  }));
  return read.filter((block): block is ImageBlock => block !== null);
}

async function* oneTurn(images: ImageBlock[], text: string): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: [...images, { type: "text", text }] }, parent_tool_use_id: null };
}

/**
 * Names a thread from its first message and the screenshots sent with it. The session carries no
 * settings, no CLAUDE.md, no tools and no project directory, so a title costs one small Haiku turn;
 * images arrive as bytes, so nothing on the machine is reachable from it.
 */
export async function suggestTaskTitle(text: string, attachments: string[] = [], queryFactory: QueryFactory = query): Promise<string | null> {
  const images = await imageBlocks(attachments);
  const question = text.trim()
    ? `Name this thread.\n\n<message>\n${text.slice(0, MESSAGE_LIMIT)}\n</message>`
    : "Name this thread from the screenshots it starts with.";
  const session = queryFactory({
    prompt: images.length === 0 ? question : oneTurn(images, question),
    options: {
      model: "haiku",
      cwd: tmpdir(),
      pathToClaudeCodeExecutable: packagedClaudeExecutable(),
      settingSources: [],
      systemPrompt: instructions,
      tools: [],
      maxTurns: 1,
    },
  });
  try {
    for await (const message of session) {
      if (message.type !== "result") continue;
      return message.subtype === "success" && !message.is_error ? cleanTitle(message.result) || null : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    session.close();
  }
}
