import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { packagedClaudeExecutable } from "./claude-agent-provider.mjs";
import { IMAGE_BYTE_LIMIT, TITLE_INSTRUCTIONS, cleanTitle, readableImages, titleQuestion } from "./title-text.mjs";

type QueryFactory = typeof query;
type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } };

async function imageBlocks(attachments: string[]): Promise<ImageBlock[]> {
  const read = await Promise.all((await readableImages(attachments)).map(async (file) => {
    try {
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
  const question = titleQuestion(text);
  const session = queryFactory({
    prompt: images.length === 0 ? question : oneTurn(images, question),
    options: {
      model: "haiku",
      cwd: tmpdir(),
      pathToClaudeCodeExecutable: packagedClaudeExecutable(),
      settingSources: [],
      systemPrompt: TITLE_INSTRUCTIONS,
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
