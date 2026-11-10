import type { AvailableCommand } from "../../contracts/ipc.js";
import { AGENT_ENGINES, engineNeedsAttention, type AgentEngine, type AgentModel, type EngineAccess, type EngineReadiness, type EngineStatus } from "../../domain/agent-engine.js";
import type { PlanUsage } from "../../domain/plan-usage.js";
import type { SubagentMetadata } from "../../domain/run.js";

type Workspace = { workspaceRoot: string; projectless: boolean };

export type OpenUrl = (url: string) => Promise<void>;

/** What the app asks of an engine outside a run. Each answer loads the engine's own code when first asked. */
export type EngineServices = {
  /** The commands the engine offers a composer in the workspace. */
  commands(workspace: Workspace): Promise<AvailableCommand[]>;
  /** Names a thread from its first message and the screenshots sent with it; `model` is the one the thread runs on. */
  suggestTitle(text: string, images: string[], model?: AgentModel): Promise<string | null>;
  /** Reads the plan behind this engine's account without starting a thread. */
  planUsage(): Promise<PlanUsage>;
  /** Whether this engine can take a run on this machine, and what would fix it when it cannot. */
  readiness(): Promise<EngineReadiness>;
  subagentMetadata?(id: string, sessionId?: string): Promise<SubagentMetadata>;
  signIn?(openUrl: OpenUrl): Promise<EngineAccess>;
  /** Upgrades the installed command the way the user installed it. */
  update?(): Promise<void>;
  /** Stops anything the engine started to answer these, as the app quits. */
  close?(): Promise<void>;
};

/** Reads the user's shell again, so a command installed after the app started is on the search path. */
async function readSearchPathAgain() {
  await (await import("../login-path.js")).adoptLoginShellPath();
}

/**
 * Which engines can take a run. An answer where every engine is fine is kept, since asking runs the
 * engine commands; one with anything wrong is read again on every ask, because the user is the one
 * who fixes it and the app has to notice when they have.
 */
export class EngineAccessHost {
  private status: EngineStatus | undefined;
  private reading: Promise<EngineStatus> | undefined;
  private signingIn: Promise<EngineStatus> | undefined;
  private updating = new Map<AgentEngine, Promise<EngineStatus>>();

  constructor(
    private readonly engines: Record<AgentEngine, Pick<EngineServices, "readiness" | "signIn" | "update">>,
    private readonly searchPathAgain: () => Promise<void> = readSearchPathAgain,
  ) {}

  read(refresh = false): Promise<EngineStatus> {
    /** An engine the user had to fix is read from scratch, since what fixed it can sit anywhere. */
    const again = refresh || (this.status !== undefined && engineNeedsAttention(this.status));
    if (this.status && !again) return Promise.resolve(this.status);
    /** One read at a time: a second ask while the commands are answering joins the first. */
    return this.reading ??= this.readAll(again).finally(() => { this.reading = undefined; });
  }

  /** One sign-in at a time: a second ask while the browser is out joins the first. */
  signIn(engine: AgentEngine, openUrl: OpenUrl): Promise<EngineStatus> {
    const signIn = this.engines[engine].signIn;
    if (!signIn) return this.read();
    this.signingIn ??= signIn(openUrl)
      .then(async (access) => {
        /** Only the access changed; the version and the models found earlier still hold. */
        const current = await this.read();
        const status: EngineStatus = { ...current, [engine]: { ...current[engine], access } };
        this.status = status;
        return status;
      })
      .finally(() => { this.signingIn = undefined; });
    return this.signingIn;
  }

  /** One update per engine at a time; the status is read from scratch after it, since the version moved. */
  update(engine: AgentEngine): Promise<EngineStatus> {
    const update = this.engines[engine].update;
    if (!update) return this.read();
    let updating = this.updating.get(engine);
    if (!updating) {
      updating = update()
        .then(() => this.readAll(true))
        .finally(() => { this.updating.delete(engine); });
      this.updating.set(engine, updating);
    }
    return updating;
  }

  private async readAll(refresh: boolean): Promise<EngineStatus> {
    /** A fresh install can sit in a folder the app never had, so the path is read before the commands. */
    if (refresh) await this.searchPathAgain().catch(() => {});
    const status: EngineStatus = {};
    await Promise.all(AGENT_ENGINES.map(async (engine) => {
      status[engine] = await this.engines[engine].readiness();
    }));
    this.status = status;
    return status;
  }
}
