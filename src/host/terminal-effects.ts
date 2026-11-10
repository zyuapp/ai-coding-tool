import { reportFailure, type EffectHandlers } from "./effect-host.js";
import type { HostModule } from "./host-module.js";

/** The terminal panel's shells. Their output goes straight to the view; only what they did lands here. */
export const terminalHost = {
  effects: {
    "terminal.start": (effect, host) => reportFailure(host, host.desktop.startTerminal(effect.terminalId, { cwd: effect.cwd })),

    "terminal.write": (effect, host) => reportFailure(host, host.desktop.writeTerminal(effect.terminalId, effect.data)),

    "terminal.resize": (effect, host) => reportFailure(host, host.desktop.resizeTerminal(effect.terminalId, effect.cols, effect.rows)),

    /** The view outlives the panel, so the shell going is the only thing that takes it away. */
    "terminal.close": (effect, host) => {
      host.surface?.(effect);
      return reportFailure(host, host.desktop.closeTerminal(effect.terminalId));
    },
  } satisfies Partial<EffectHandlers>,

  subscribe: (host) => host.desktop.onTerminalEvent((update) => void host.dispatch({ type: "terminal.updated", update })),
} satisfies HostModule;
