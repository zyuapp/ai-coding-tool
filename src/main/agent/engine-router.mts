import type { AgentEngine } from "../../domain/agent-engine.js";
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

  stopProcess(taskId: string, processId: string) {
    return Object.values(this.engines).some((engine) => engine.stopProcess(taskId, processId));
  }

  labelThread(taskId: string, title: string) {
    return Object.values(this.engines).some((engine) => engine.labelThread(taskId, title));
  }

  archiveThread(taskId: string, continuation: Continuation | undefined, archived: boolean) {
    return Object.values(this.engines).some((engine) => engine.archiveThread(taskId, continuation, archived));
  }

  retireOutOfRole(taskId: string, role: CoordinationRole | undefined) {
    for (const engine of Object.values(this.engines)) engine.retireOutOfRole(taskId, role);
  }

  closeAll() {
    for (const engine of Object.values(this.engines)) engine.closeAll();
  }
}
