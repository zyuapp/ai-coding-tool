import type { EffectHandlers } from "./effect-host.js";
import type { RuntimeSubscriptionHost } from "./runtime-subscriptions.js";

/** How a subscription folds in what runs have reported but the reducer has not yet seen. */
export type RunReports = {
  /** Folds in every report still held, before anything reads or acts on the thread it went to. */
  flushAll: () => void;
  /** Hands {@link flushAll} a batch of held reports to fold in. */
  holdReports: (flush: () => void) => void;
};

/** One capability's part of the runtime: the effects it carries out, and what it listens to and reads on the way up. */
export type HostModule = {
  effects?: Partial<EffectHandlers>;
  /** Starts listening, answering how to stop. Modules start in the order they are listed, and stop in it too. */
  subscribe?: (host: RuntimeSubscriptionHost, runs: RunReports) => (() => void) | void;
};
