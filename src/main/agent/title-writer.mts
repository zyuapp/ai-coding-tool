import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { clampTitle } from "../../domain/task.js";
import { packagedClaudeExecutable } from "./claude-agent-provider.mjs";

type QueryFactory = typeof query;

const MESSAGE_LIMIT = 2_000;
const instructions = "You name chat threads. Answer with a title of at most six words describing what the message is about, and nothing else: no quotes, no trailing punctuation, no preamble.";

function cleanTitle(text: string) {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return clampTitle(line.replace(/^["'`]+|["'`]+$/g, "").replace(/\.+$/, ""));
}

/**
 * Names a thread from its first message. The session carries no settings, no CLAUDE.md, no tools and
 * no project directory, so a title costs one small Haiku turn and nothing on the machine is reachable
 * from it.
 */
export async function suggestTaskTitle(text: string, queryFactory: QueryFactory = query): Promise<string | null> {
  const session = queryFactory({
    prompt: `Name this thread.\n\n<message>\n${text.slice(0, MESSAGE_LIMIT)}\n</message>`,
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
