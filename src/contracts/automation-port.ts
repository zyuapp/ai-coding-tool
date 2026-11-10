import type { AutomationDraft, AutomationPatch, AutomationRunStatus, AutomationView } from "../domain/automation.js";
import type { AutomationAck, AutomationFire } from "./ipc.js";

export type AutomationPort = {
  runtime: {
    listAutomations(): Promise<AutomationView[]>;
    saveAutomation(draft: AutomationDraft): Promise<AutomationView>;
    updateAutomation(taskId: string, patch: AutomationPatch): Promise<AutomationView>;
    deleteAutomation(taskId: string): Promise<boolean>;
    runAutomationNow(taskId: string): Promise<AutomationRunStatus | "busy">;
    onAutomationsChanged(listener: (automations: AutomationView[]) => void): () => void;
    onAutomationFire(listener: (fire: AutomationFire) => void): () => void;
    acknowledgeAutomation(ack: AutomationAck): void;
  };
};
