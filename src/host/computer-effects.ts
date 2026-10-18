import { errorMessage } from "./errors.js";
import type { EffectHandlers } from "./effect-host.js";

/** Other computers running this app: finding them, pairing, and what is carried to one of them. */
export const computerEffects = {
  "computer.discover": async (_effect, { dispatch, desktop }) => {
    try {
      await dispatch({ type: "computers.found", found: await desktop.discoverComputers() });
    } catch (error) {
      await dispatch({ type: "computers.search-failed", message: errorMessage(error) });
    }
  },

  "computer.pair": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.pairComputer(effect.host, effect.name, effect.code);
    } catch (error) {
      await dispatch({ type: "computers.pair-failed", message: errorMessage(error) });
    }
  },

  "computer.forget": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.forgetComputer(effect.id);
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  },

  "computer.reconnect": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.reconnectComputer(effect.id);
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  },

  "computer.rename": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.renameComputer(effect.name);
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  },

  "computer.label": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.labelComputer(effect.id, effect.name);
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  },

  /**
   * What the other computer refused comes back as this window's own error, since it is the one that
   * asked. A draft a send carried is let go of only once that computer has taken it.
   */
  "computer.forward": async (effect, { dispatch, desktop }) => {
    try {
      const result = await desktop.sendToComputer(effect.id, effect.inputs);
      /** That computer refusing a start says it started nothing, which an answer lost on the way cannot. */
      if (!result.ok && effect.proposal) {
        await dispatch({ type: "proposal.settled", ...effect.proposal, message: result.message, refused: true });
        return;
      }
      if (!result.ok) throw new Error(result.message);
      if (effect.proposal) {
        const { taskId, proposalId } = effect.proposal;
        await dispatch(result.taskId === undefined
          ? { type: "proposal.settled", taskId, proposalId, message: "That computer did not say which thread it started." }
          : { type: "proposal.settled", taskId, proposalId, threadId: result.taskId });
        return;
      }
      if (result.taskId !== undefined) await dispatch({ type: "computers.answered", taskId: result.taskId });
      if (effect.projectAddRequest !== undefined) await dispatch({ type: "project.add-finished", request: effect.projectAddRequest });
      if (effect.draft) await dispatch({ type: "computers.forwarded", draft: effect.draft });
    } catch (error) {
      /**
       * Whether anyone here is looking is told anew when the thread is next selected, and a computer's
       * limits and its threads' pull requests are asked anew on the next refresh, so a line that
       * dropped any of them is no error, and neither is housekeeping retried once the line is back.
       */
      if (effect.silent || effect.inputs.every((input) => input.type === "view.set-focused" || input.type === "usage.read" || input.type === "pull-request.read-member")) return;
      if (effect.proposal) {
        await dispatch({ type: "proposal.settled", ...effect.proposal, message: errorMessage(error) });
        return;
      }
      if (effect.projectAddRequest !== undefined) {
        await dispatch({ type: "project.add-finished", request: effect.projectAddRequest, error: errorMessage(error) });
        return;
      }
      const composer = effect.draft?.attachments?.key;
      await dispatch(composer === undefined
        ? { type: "action.failed", message: errorMessage(error) }
        : { type: "attachments.failed", ...(composer ? { taskId: composer } : {}), message: errorMessage(error) });
    }
  },
} satisfies Partial<EffectHandlers>;
