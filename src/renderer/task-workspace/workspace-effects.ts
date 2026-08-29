import type { WorkspaceEffect } from "../../application/workspace-reducer";
import { runProjectEffect } from "./project-effects";
import { runRunEffect } from "./run-effects";
import { runSurfaceEffect } from "./surface-effects";
import { runSystemEffect } from "./system-effects";
import type { EffectHost } from "./effect-host";

/**
 * Performs one effect the reducer described. Nothing here decides anything: each effect is carried out
 * as it was written, and whatever the outside answers goes back through the reducer as an event.
 */
export async function runWorkspaceEffect(effect: WorkspaceEffect, host: EffectHost): Promise<void> {
  switch (effect.type) {
    case "persist-preferences": case "load-subagent-activity": case "resolve-run-workspace":
    case "start-run": case "send-run-command": case "suggest-title":
      return runRunEffect(effect, host);

    case "pick-project": case "register-project": case "create-worktree": case "release-worktree":
    case "list-worktrees": case "reveal-worktree": case "delete-worktree": case "refresh-environment":
    case "read-diff": case "checkout-branch":
      return runProjectEffect(effect, host);

    case "file.open": case "app.open-folder": case "app.check-for-updates": case "browser.open": case "browser.navigate":
    case "browser.history": case "browser.reload": case "browser.close": case "browser.show":
    case "browser.act": case "browser.clear-data": case "terminal.start": case "terminal.write":
    case "terminal.resize": case "terminal.close": case "find-in-page": case "stop-find-in-page":
    case "focus-browser": case "find-in-terminal": case "stop-find-in-terminal":
      return runSurfaceEffect(effect, host);

    case "automation.save": case "automation.update": case "automation.delete": case "automation.run-now":
    case "automation.ack": case "focus-window": case "close-window": case "apply-shortcuts":
    case "apply-capture-options": case "capture-shortcut": case "announce-thread":
    case "remote.set-enabled": case "remote.set-lan-exposed": case "remote.create-pairing-code":
    case "remote.revoke-device": case "remote.set-tailscale-serve": case "remote.refresh":
    case "engine.read": case "engine.sign-in":
      return runSystemEffect(effect, host);
  }
}
