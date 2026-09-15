import { open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubagentMetadata } from "../../domain/run.js";

const tailBytes = 2 * 1024 * 1024;
const pending = new Map<string, Promise<SubagentMetadata>>();

/** The transcript stamps the effort sent on the request; per-turn overrides take precedence. */
export function claudeTranscriptMetadata(text: string, id: string, sessionId: string): SubagentMetadata {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const row = JSON.parse(lines[index]);
      if (row?.type !== "assistant" || row.agentId !== id || row.sessionId !== sessionId) continue;
      const model = row.message?.model;
      if (typeof model !== "string" || !model || model === "<synthetic>") continue;
      const effort = row.perTurnEffort ?? row.effort;
      return { model, ...(typeof effort === "string" && effort ? { effort } : typeof effort === "number" && Number.isFinite(effort) ? { effort: String(effort) } : {}) };
    } catch { /* A live writer can leave the last line incomplete. */ }
  }
  return {};
}

/** Reads only the tail of a saved child, without starting Claude or loading its full conversation. */
export function readClaudeSubagentMetadata(id: string, sessionId?: string, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")): Promise<SubagentMetadata> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id) || !sessionId || !/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) return Promise.resolve({});
  const key = JSON.stringify([configDir, sessionId, id]);
  const existing = pending.get(key);
  if (existing) return existing;
  const reading = read().catch(() => ({})).finally(() => pending.delete(key));
  pending.set(key, reading);
  return reading;

  async function read(): Promise<SubagentMetadata> {
    const projects = await opendir(join(configDir, "projects"));
    for await (const project of projects) {
      if (!project.isDirectory()) continue;
      const file = await open(join(configDir, "projects", project.name, sessionId!, "subagents", `agent-${id}.jsonl`), "r").catch(() => null);
      if (!file) continue;
      try {
        const { size } = await file.stat();
        const start = Math.max(0, size - tailBytes);
        const buffer = Buffer.alloc(Math.min(size, tailBytes));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        return claudeTranscriptMetadata(start ? text.slice(text.indexOf("\n") + 1) : text, id, sessionId!);
      } finally { await file.close(); }
    }
    return {};
  }
}
