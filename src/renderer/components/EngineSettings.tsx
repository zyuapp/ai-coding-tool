import { LuRefreshCw as RefreshCw } from "react-icons/lu";
import { SettingGroup } from "./SettingRow";
import { settingControl } from "../../domain/settings-catalog";
import { AGENT_ENGINES, engineLabel, engineNotice, engineStatusLine, engineStatusWord, engineUpdate, type AgentEngine, type EngineReadiness } from "../../domain/agent-engine";
import type { WorkspaceState } from "../../application/workspace-state";
import { CopyButton } from "./CopyButton";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import { SpinningIcon } from "./SpinningIcon";

export type EngineSettingsProps = {
  engineAccess: Record<AgentEngine, EngineReadiness>;
  /** True while the app is running the engine commands, which the button says out loud. */
  checking: boolean;
  /** The engine the app is upgrading, whose button says so. */
  updating: AgentEngine | null;
  reloadStatus: WorkspaceState["agentSettingsReload"];
  /** Why the last reload failed, as the engine put it. */
  reloadError?: string | null;
  onReload: () => void;
  onRefresh: () => void;
  onSignIn: (engine: AgentEngine) => void;
  onUpdate: (engine: AgentEngine) => void;
};

const RELOAD_TONE = { idle: "", reloading: "", pending: "pending", reloaded: "done", failed: "failed" } as const;

function reloadLine(status: EngineSettingsProps["reloadStatus"], error: string | null | undefined) {
  if (status === "pending") return "Reload pending";
  if (status === "reloaded") return "Settings reloaded";
  if (status === "failed") return error ? `Could not reload settings: ${error}` : "Could not reload settings. Try again.";
  return "";
}

export function EngineSettings({ engineAccess, checking, updating, onRefresh, onSignIn, onUpdate, reloadStatus, reloadError, onReload }: EngineSettingsProps) {
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Engines</h2>
        <p>AI Coding Tool runs the engines installed on this computer.</p>
      </div>

      <SettingGroup setting="engines.installed" aria-labelledby="engines-heading" aria-live="polite">
        <div className="settings-group-heading">
          <div>
            <h3 id="engines-heading">{settingControl("engines.installed").label}</h3>
            <p>Install an engine in your terminal, then check again here.</p>
          </div>
          <div className="settings-group-action">
            <button type="button" disabled={checking} aria-busy={checking} onClick={onRefresh}>
              <SpinningIcon icon={RefreshCw} spinning={checking} size={14} aria-hidden="true" />{checking ? "Checking…" : "Check again"}
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
              <span className="setting-glyph" aria-hidden="true"><ThreadEngineIcon engine={engine} size={16} /></span>
              <div>
                <strong>{engineLabel(engine)}</strong>
                <p>{engineStatusLine(engine, readiness)}</p>
                {notice?.fix && !notice.updatable && (
                  <div className="setting-readiness">
                    <code>{notice.fix}</code>
                    <CopyButton text={notice.fix} label={`Copy ${notice.fix}`} />
                  </div>
                )}
              </div>
              <div className="setting-row-action">
                {readiness.access === "signed-out"
                  ? <button type="button" aria-label={`Sign in to ${engineLabel(engine)}`} onClick={() => onSignIn(engine)}>Sign in</button>
                  : update?.command
                    ? <button type="button" aria-label={`${updating === engine ? "Updating" : "Update"} ${engineLabel(engine)}`} disabled={updating !== null || checking} aria-busy={updating === engine} onClick={() => onUpdate(engine)}>
                      {updating === engine && <RefreshCw size={14} aria-hidden="true" className="spinning" />}{updating === engine ? "Updating…" : "Update"}
                    </button>
                    : <span className={`setting-pill${ready ? " ready" : notice?.blocking ? " blocked" : ""}`}>{engineStatusWord(readiness)}</span>}
              </div>
            </div>
          );
        })}
      </SettingGroup>
      <SettingGroup setting="engines.agent-settings" aria-labelledby="agent-settings-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="agent-settings-heading">{settingControl("engines.agent-settings").label}</h3>
            <p>Apply changes to your engines' settings. Busy agents reload when their work finishes.</p>
            <p role="status" className={`settings-status ${RELOAD_TONE[reloadStatus]}`}>{reloadLine(reloadStatus, reloadError)}</p>
          </div>
          <div className="settings-group-action">
            <button type="button" onClick={onReload} disabled={reloadStatus === "reloading" || reloadStatus === "pending"} aria-busy={reloadStatus === "reloading"}>
              <SpinningIcon icon={RefreshCw} spinning={reloadStatus === "reloading"} size={14} aria-hidden="true" />{reloadStatus === "reloading" ? "Reloading…" : "Reload agent settings"}
            </button>
          </div>
        </div>
      </SettingGroup>
    </main>
  );
}
