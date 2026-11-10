import type { AgentEngine, AgentModel, EngineStatus } from "../domain/agent-engine.js";
import type { PlanUsage } from "../domain/plan-usage.js";
import type { SubagentMetadata } from "../domain/run.js";

export type EnginePort = {
  runtime: {
    /** One engine's plan windows. Never rejects: an engine that cannot answer says why instead. */
    planUsage(engine: AgentEngine): Promise<PlanUsage>;
    /** A title for a thread's first message and any screenshots it carries, written off the agent's run path by the engine the thread runs on. `model` is the one the thread runs on. Null when no name came back. */
    suggestTaskTitle(text: string, attachments: string[], engine: AgentEngine, model?: AgentModel): Promise<string | null>;
    /** Which engines can take a run. The answer is kept; `refresh` throws it away and asks the machine again. */
    engineStatus(refresh?: boolean): Promise<EngineStatus>;
    /** Signs in through the engine's own flow, in the browser, and answers with the status after it. */
    signInEngine(engine: AgentEngine): Promise<EngineStatus>;
    /** Upgrades the engine's command the way the user installed it, and answers with the status after it. */
    updateEngine(engine: AgentEngine): Promise<EngineStatus>;
    loadSubagentMetadata(engine: AgentEngine, subagentId: string, sessionId?: string): Promise<SubagentMetadata>;
  };
};
