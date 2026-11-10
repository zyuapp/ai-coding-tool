import { isAgentEngine, type AgentEngine } from "../domain/agent-engine.js";
import { optionalBoolean, optionalText, type Declarations } from "./command-declaration.js";
import type { PhoneRule } from "./phone-commands.js";

/**
 * Asks which engines can take a run, signs the user in to one that asked for it, or updates one that
 * is behind. Each way the engines' status comes back as the answer.
 */
export type EngineCommand =
  /** `refresh` throws away what the app was told before, for a user who just installed or upgraded one. */
  | { type: "engine.read"; refresh?: boolean }
  | { type: "engine.sign-in"; engine: AgentEngine }
  /** `computerId` names a paired computer whose engine is upgraded there. */
  | { type: "engine.update"; engine: AgentEngine; computerId?: string }
  | { type: "engine.reload-settings" };

const updatesEngineHere: PhoneRule = (command) => isAgentEngine(command.engine) && command.computerId === undefined;

const rereadsEngines: PhoneRule = (command) => command.refresh === true;

export const engineCommands = {
  "engine.read": { fields: { refresh: optionalBoolean }, at: "local", phone: rereadsEngines },
  "engine.sign-in": { fields: { engine: isAgentEngine }, at: "local" },
  "engine.update": { fields: { engine: isAgentEngine, computerId: optionalText }, at: "own", phone: updatesEngineHere },
  "engine.reload-settings": { fields: {}, at: "local" },
} satisfies Declarations<EngineCommand>;
