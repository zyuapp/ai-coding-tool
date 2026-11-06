import { isAgentEngine, type AgentEngine } from "../../domain/agent-engine.js";
import type { Continuation } from "../../domain/run.js";
import type { CoordinationRole } from "../../domain/coordination.js";
import type { AgentProvider, ProviderResult, ProviderRunInput } from "./agent-provider.mjs";

export type EngineProvider = AgentProvider & { closeAll(): void };

/** One provider per engine, told apart by the run's engine. A thread's session lives with the engine it runs on. */
export class EngineRouter implements AgentProvider {
  constructor(private readonly engines: Record<AgentEngine, EngineProvider>) {}

  execute(input: ProviderRunInput): Promise<ProviderResult> {
    return this.engines[input.engine].execute(input);
  }

  /** A thread's live session sits in its channel's shared pool, where only the engine that opened it claims it, so a stop or a label asks each. */
  stopProcess(taskId: string, processId: string) {
    return Object.values(this.engines).some((engine) => engine.stopProcess(taskId, processId));
  }

  labelThread(taskId: string, title: string) {
    return Object.values(this.engines).some((engine) => engine.labelThread(taskId, title));
  }

  /** Goes to the engine that made the continuation; a thread with none yet goes to whichever engine holds its session. */
  archiveThread(taskId: string, continuation: Continuation | undefined, archived: boolean) {
    if (!continuation) return Object.values(this.engines).some((engine) => engine.archiveThread(taskId, undefined, archived));
    return isAgentEngine(continuation.provider) && this.engines[continuation.provider].archiveThread(taskId, continuation, archived);
  }

  retireOutOfRole(taskId: string, role: CoordinationRole | undefined) {
    for (const engine of Object.values(this.engines)) engine.retireOutOfRole(taskId, role);
  }

  closeAll() {
    for (const engine of Object.values(this.engines)) engine.closeAll();
  }
}
