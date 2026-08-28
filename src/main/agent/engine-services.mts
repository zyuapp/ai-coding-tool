import type { AvailableCommand } from "../../contracts/ipc.js";
import { AGENT_ENGINES, type AgentEngine, type EngineAccess, type EngineStatus } from "../../domain/agent-engine.js";
import type { PlanUsage } from "../../domain/plan-usage.js";

type Workspace = { workspaceRoot: string; projectless: boolean };

export type OpenUrl = (url: string) => Promise<void>;

/** What the app asks of an engine outside a run. Each answer loads the engine's own code when first asked. */
export type EngineServices = {
  /** The commands the engine offers a composer in the workspace. */
  commands(workspace: Workspace): Promise<AvailableCommand[]>;
  /** Names a thread from its first message and the screenshots sent with it. */
  suggestTitle(text: string, images: string[]): Promise<string | null>;
  /** Reads the plan behind this engine's account without starting a thread. */
  planUsage(): Promise<PlanUsage>;
  /** Absent for an engine that is always ready. */
  access?(): Promise<EngineAccess>;
  signIn?(openUrl: OpenUrl): Promise<EngineAccess>;
};

export const engineServices: Record<AgentEngine, EngineServices> = {
  claude: {
    commands: async ({ workspaceRoot, projectless }) => (await import("./claude-agent-provider.mjs")).discoverClaudeCommands(workspaceRoot, projectless),
    suggestTitle: async (text, images) => (await import("./title-writer.mjs")).suggestTaskTitle(text, images),
    planUsage: async () => (await import("./plan-usage.mjs")).readPlanUsage(),
  },
  codex: {
    commands: async (workspace) => {
      const { listSkills, skillRoots } = await import("../tools/skills.mjs");
      return [
        { name: "goal", description: "Set a goal — keep working until the condition is met", argumentHint: "condition" },
        ...(await listSkills(skillRoots(workspace))).map((skill) => ({ name: skill.name, description: skill.description, argumentHint: "" })),
      ];
    },
    suggestTitle: async (text, images) => (await import("../codex/codex-title-writer.mjs")).suggestCodexTitle(text, images),
    planUsage: async () => (await import("../codex/codex-plan-usage.mjs")).readCodexPlanUsage(),
    access: async () => (await import("../codex/codex-account.mjs")).readCodexAccess(),
    signIn: async (openUrl) => (await import("../codex/codex-account.mjs")).signInToCodex(openUrl),
  },
};

/** Which engines can take a run. Each is asked once per process; a sign-in asks it again. */
export class EngineAccessHost {
  private status: Promise<EngineStatus> | undefined;
  private signingIn: Promise<EngineStatus> | undefined;

  constructor(private readonly engines: Record<AgentEngine, Pick<EngineServices, "access" | "signIn">> = engineServices) {}

  read(): Promise<EngineStatus> {
    this.status ??= this.readAll();
    return this.status;
  }

  /** One sign-in at a time: a second ask while the browser is out joins the first. */
  signIn(engine: AgentEngine, openUrl: OpenUrl): Promise<EngineStatus> {
    const signIn = this.engines[engine].signIn;
    if (!signIn) return this.read();
    this.signingIn ??= signIn(openUrl)
      .then(async (access) => {
        const status: EngineStatus = { ...await this.read(), [engine]: access };
        this.status = Promise.resolve(status);
        return status;
      })
      .finally(() => { this.signingIn = undefined; });
    return this.signingIn;
  }

  private async readAll(): Promise<EngineStatus> {
    const status: EngineStatus = {};
    await Promise.all(AGENT_ENGINES.map(async (engine) => {
      const access = this.engines[engine].access;
      if (access) status[engine] = await access();
    }));
    return status;
  }
}
