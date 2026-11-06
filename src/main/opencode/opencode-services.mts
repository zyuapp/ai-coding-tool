import os from "node:os";
import type { AvailableCommand } from "../../contracts/ipc.js";
import type { AgentModel, EngineReadiness } from "../../domain/agent-engine.js";
import type { PlanUsage, UsageWindow } from "../../domain/plan-usage.js";
import { appSkillsRoot, unqualifiedSkillName } from "../app-plugin.mjs";
import { TITLE_INSTRUCTIONS, titleOf, titleQuestion } from "../agent/title-text.mjs";
import { modelRef, openCodeCatalog, type OpenCodeModel, type OpenCodeProvider } from "./opencode-catalog.mjs";
import { readLoaded, startOpenCodeServer, type OpenCodeClient, type OpenCodeConnect } from "./opencode-server.mjs";

/** The release whose server API the app speaks. An older OpenCode, including any 1.x, is turned away. */
export const OPENCODE_BASELINE_VERSION = "2.2.5";

/** A title is worth a short wait, not a stuck request. */
const TITLE_TIMEOUT_MS = 20_000;

/** How long the server the app reads models and commands from stays up after its last question. */
const IDLE_MS = 60_000;

/**
 * One server the app asks things of outside a run, started on the first question and stopped once
 * nobody has asked anything for a while. It carries the app's skills, so the commands it lists are
 * the ones a run can take.
 */
export class OpenCodeServices {
  private client: Promise<OpenCodeClient> | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private inFlight = 0;

  constructor(private readonly connect: OpenCodeConnect = startOpenCodeServer) {}

  private async use<T>(ask: (client: OpenCodeClient) => Promise<T>): Promise<T> {
    clearTimeout(this.idle);
    this.inFlight += 1;
    const skills = appSkillsRoot();
    const starting = this.client ??= this.connect({ cwd: os.homedir(), ...(skills ? { config: { skills: [skills] } } : {}) });
    try {
      const client = await starting;
      void client.exited.then(() => { if (this.client === starting) this.client = null; });
      return await ask(client);
    } catch (error) {
      if (this.client === starting) this.client = null;
      void starting.then((client) => client.close(), () => {});
      throw error;
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        this.idle = setTimeout(() => void this.close(), IDLE_MS);
        this.idle.unref?.();
      }
    }
  }

  async close() {
    clearTimeout(this.idle);
    const starting = this.client;
    this.client = null;
    if (starting) await starting.then((client) => client.close(), () => {});
  }

  /** The models the user's connected providers offer, the server's default first. */
  async catalog() {
    return this.use(async (client) => {
      const [models, providers, fallback] = await Promise.all([
        client.request<OpenCodeModel[]>("GET", "/api/model"),
        client.request<OpenCodeProvider[]>("GET", "/api/provider").catch(() => []),
        client.request<OpenCodeModel | undefined>("GET", "/api/model/default").catch(() => undefined),
      ]);
      return openCodeCatalog(models ?? [], providers ?? [], fallback ?? undefined);
    });
  }

  /** OpenCode's commands and the skills it can load in one workspace, the app's own among them. */
  async commands(workspaceRoot: string): Promise<AvailableCommand[]> {
    return this.use(async (client) => {
      const location = `location[directory]=${encodeURIComponent(workspaceRoot)}`;
      const [commands, skills] = await Promise.all([
        readLoaded<{ name: string; description?: string }>(client, `/api/command?${location}`).catch(() => []),
        readLoaded<{ id: string; description?: string }>(client, `/api/skill?${location}`).catch(() => []),
      ]);
      const listed = [
        ...(commands ?? []).map((command) => ({ name: command.name, description: command.description ?? "", argumentHint: "" })),
        ...(skills ?? []).map((skill) => ({ name: unqualifiedSkillName(skill.id), description: skill.description ?? "", argumentHint: "" })),
      ];
      return [...new Map(listed.map((command) => [command.name, command])).values()];
    });
  }

  /** Names a thread from its first message, on the model the thread runs on. */
  async title(text: string, model?: AgentModel): Promise<string | null> {
    const ref = model ? modelRef(model) : null;
    if (!text.trim() || !ref) return null;
    return this.use(async (client) => {
      const answer = await client.request<{ text?: string }>("POST", "/api/experimental/generate/text", {
        prompt: `${TITLE_INSTRUCTIONS}\n\n${titleQuestion(text)}\n\nAnswer with the title alone.`,
        model: ref,
      }, TITLE_TIMEOUT_MS);
      return titleOf({ title: answer?.text ?? "" });
    }).catch(() => null);
  }

  /** OpenCode Go's allowance, when the account has one; any other provider bills by use. */
  async planUsage(): Promise<PlanUsage> {
    const limits = await this.use((client) => client.request<GoLimits | null>("GET", "/api/experimental/usage/limits"));
    const go = limits?.go;
    if (!go) return { status: "not-applicable" };
    const windows: UsageWindow[] = [
      { id: "rolling", label: "Rolling", utilization: go.rolling.percent, resetsAt: new Date(go.rolling.resetsAt).toISOString(), period: "session" },
      { id: "weekly", label: "Weekly", utilization: go.weekly.percent, resetsAt: new Date(go.weekly.resetsAt).toISOString(), period: "week" },
      { id: "monthly", label: "Monthly", utilization: go.monthly.percent, resetsAt: new Date(go.monthly.resetsAt).toISOString() },
    ];
    return { status: "available", subscription: "Go", windows };
  }
}

type Meter = { percent: number; resetsAt: number };
type GoLimits = { go?: { rolling: Meter; weekly: Meter; monthly: Meter } };

let shared: OpenCodeServices | null = null;

/** The one services server the main process keeps. */
export function openCodeServices() {
  return shared ??= new OpenCodeServices();
}

/**
 * OpenCode serves a version of its API; the app speaks 2.x, so a 1.x install is too old however it
 * was installed. A ready install names the models its connected providers offer.
 */
export async function readOpenCodeReadiness(): Promise<EngineReadiness> {
  const { installCommand, installedEngine } = await import("../agent/engine-binary.mjs");
  const { versionReadiness } = await import("../agent/engine-readiness.mjs");
  const installed = await installedEngine("opencode");
  if (!installed) return { access: "missing", fix: installCommand("opencode") };
  const version = await versionReadiness("opencode", installed, OPENCODE_BASELINE_VERSION);
  if (version.required) return { access: "outdated", ...version };
  try {
    const catalog = await openCodeServices().catalog();
    return { access: "ready", ...version, ...(catalog.length ? {} : { fix: "opencode auth login" }), catalog };
  } catch {
    return { access: "unavailable", ...version };
  }
}
