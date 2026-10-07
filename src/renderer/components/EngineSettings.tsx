import { LuRefreshCw as RefreshCw } from "react-icons/lu";
import { SettingGroup } from "./SettingRow";
import { settingControl } from "../../domain/settings-catalog";
import { AGENT_ENGINES, engineLabel, engineNotice, engineUpdate, type AgentEngine, type EngineReadiness } from "../../domain/agent-engine";
import type { WorkspaceState } from "../../application/workspace-state";
import { CopyButton } from "./CopyButton";
import { ThreadEngineIcon } from "./ThreadEngineIcon";

export type EngineSettingsProps = {
  engineAccess: Record<AgentEngine, EngineReadiness>;
  /** True while the app is running the engine commands, which the button says out loud. */
  checking: boolean;
  /** The engine the app is upgrading, whose button says so. */
  updating: AgentEngine | null;
  reloadStatus: WorkspaceState["agentSettingsReload"];
  onReload: () => void;
  onRefresh: () => void;
  onSignIn: (engine: AgentEngine) => void;
  onUpdate: (engine: AgentEngine) => void;
};

/** The word in the right column: short enough to read at a glance, plain enough to need no key. */
function statusWord(readiness: EngineReadiness) {
  if (readiness.access === "missing") return "Not installed";
  if (readiness.access === "outdated") return "Too old";
  if (readiness.access === "unavailable") return "Will not start";
  if (readiness.access === "signed-out") return "Signed out";
  if (readiness.required) return "Behind";
  return readiness.latest ? "Update available" : "Ready";
}

/** What this engine is doing on this machine, under its name. */
function statusLine(engine: AgentEngine, readiness: EngineReadiness) {
  const notice = engineNotice(engine, readiness);
  if (notice) return notice.message;
  if (readiness.access === "signed-out") return `Sign in to run threads on ${engineLabel(engine)}.`;
  if (readiness.latest) return `Version ${readiness.version}. ${readiness.latest} is available${readiness.fix ? "" : "; update it the way you installed it"}.`;
  return readiness.version ? `Version ${readiness.version}` : "Installed and ready.";
}

export function EngineSettings({ engineAccess, checking, updating, onRefresh, onSignIn, onUpdate, reloadStatus, onReload }: EngineSettingsProps) {
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Engines</h2>
        <p>AI Coding Tool runs the Claude Code and Codex commands installed on this computer.</p>
      </div>

      <SettingGroup setting="engines.installed" aria-labelledby="engines-heading" aria-live="polite">
        <div className="settings-group-heading">
          <div>
            <h3 id="engines-heading">{settingControl("engines.installed").label}</h3>
            <p>Install an engine in your terminal, then check again here.</p>
          </div>
          <div className="settings-group-action">
            <button type="button" disabled={checking} onClick={onRefresh}>
              <RefreshCw size={13} aria-hidden="true" className={checking ? "spinning" : ""} />{checking ? "Checking…" : "Check again"}
            </button>
          </div>
        </div>

        {AGENT_ENGINES.map((engine) => {
          const readiness = engineAccess[engine];
          const notice = engineNotice(engine, readiness);
          const update = engineUpdate(readiness);
          const ready = !notice && readiness.access === "ready";
          return (
            <div className="setting-row engine-setting-row" key={engine}>
              <span className={`setting-status ${ready ? "granted" : ""}`}><ThreadEngineIcon engine={engine} size={13} /></span>
              <div>
                <strong>{engineLabel(engine)}</strong>
                <p>{statusLine(engine, readiness)}</p>
                {notice?.fix && !notice.updatable && (
                  <div className="setting-readiness">
                    <code>{notice.fix}</code>
                    <CopyButton text={notice.fix} label={`Copy ${notice.fix}`} />
                  </div>
                )}
              </div>
              <div className="setting-row-action">
                {readiness.access === "signed-out"
                  ? <button type="button" onClick={() => onSignIn(engine)}>Sign in</button>
                  : update?.command
                    ? <button type="button" disabled={updating !== null || checking} onClick={() => onUpdate(engine)}>
                      {updating === engine && <RefreshCw size={13} aria-hidden="true" className="spinning" />}{updating === engine ? "Updating…" : "Update"}
                    </button>
                    : <em className={ready ? "granted" : ""}>{statusWord(readiness)}</em>}
              </div>
            </div>
          );
        })}
      </SettingGroup>
      <SettingGroup setting="engines.agent-settings" aria-labelledby="agent-settings-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="agent-settings-heading">{settingControl("engines.agent-settings").label}</h3>
            <p>Apply changes to Claude Code and Codex settings. Busy agents reload when their work finishes.</p>
            <p role="status">{reloadStatus === "idle" ? "" : reloadStatus === "reloading" ? "Reloading…" : reloadStatus === "pending" ? "Reload pending" : reloadStatus === "reloaded" ? "Settings reloaded" : "Could not reload settings. Try again."}</p>
          </div>
          <div className="settings-group-action">
            <button type="button" onClick={onReload} disabled={reloadStatus === "reloading" || reloadStatus === "pending"}>
              <RefreshCw size={13} aria-hidden="true" />Reload agent settings
            </button>
          </div>
        </div>
      </SettingGroup>
    </main>
  );
}
