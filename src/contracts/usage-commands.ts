import { optionalBoolean, text, type Declarations } from "./command-declaration.js";
import { isString, type PhoneRule } from "./phone-commands.js";

/**
 * The plan limits every provider reports, read again whenever the Usage page asks for them.
 * `everywhere` asks every connected paired computer for its own as well.
 */
export type PlanUsageCommand =
  | { type: "usage.read"; everywhere?: boolean }
  /** Puts away the composer's warning that a window is running low, until it reaches its limit or resets. */
  | { type: "usage.dismiss-warning"; warning: string };

/** This computer's own limits, never a paired computer's. */
const readsUsageHere: PhoneRule = (command) => command.everywhere === undefined;

const dismissesUsageWarning: PhoneRule = (command) => isString(command.warning);

export const usageCommands = {
  "usage.read": { fields: { everywhere: optionalBoolean }, at: "local", phone: readsUsageHere },
  "usage.dismiss-warning": { fields: { warning: text }, at: "local", phone: dismissesUsageWarning },
} satisfies Declarations<PlanUsageCommand>;
