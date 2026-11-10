import { LuRefreshCw as RefreshCw } from "react-icons/lu";
import { SettingRowBase } from "./SettingRow";
import { SettingsPage, SettingsSection } from "./SettingsLayout";
import { Button } from "../ui/Button";
import { AGENT_ENGINES, engineLabel, engineNotice, engineStatusLine, engineStatusWord, engineUpdate, type AgentEngine, type EngineReadiness } from "../../domain/agent-engine";
import type { WorkspaceState } from "../../application/workspace-state";
import { CopyButton } from "./CopyButton";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import { SpinningIcon } from "./SpinningIcon";
import "../ui/glass.css";

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
    <SettingsPage title="Engines" description="AI Coding Tool runs the engines installed on this computer.">
      <SettingsSection setting="engines.installed" description="Install an engine in your terminal, then check again here." aria-live="polite" action={
        <Button disabled={checking} aria-busy={checking} onClick={onRefresh} icon={<SpinningIcon icon={RefreshCw} spinning={checking} size={14} aria-hidden="true" />}>{checking ? "Checking…" : "Check again"}</Button>
      }>
        {AGENT_ENGINES.map((engine) => {
          const readiness = engineAccess[engine];
          const notice = engineNotice(engine, readiness);
          const update = engineUpdate(readiness);
          const ready = !notice && readiness.access === "ready";
          return (
            <SettingRowBase className="engine-setting-row" key={engine} title={engineLabel(engine)}
              leading={<span className="setting-glyph" aria-hidden="true"><ThreadEngineIcon engine={engine} size={16} /></span>}
              description={<>
                <p>{engineStatusLine(engine, readiness)}</p>
                {notice?.fix && !notice.updatable && (
                  <div className="setting-readiness">
                    <code>{notice.fix}</code>
                    <CopyButton text={notice.fix} label={`Copy ${notice.fix}`} />
                  </div>
                )}
              </>}>
              {readiness.access === "signed-out"
                ? <Button aria-label={`Sign in to ${engineLabel(engine)}`} onClick={() => onSignIn(engine)}>Sign in</Button>
                : update?.command
                  ? <Button aria-label={`${updating === engine ? "Updating" : "Update"} ${engineLabel(engine)}`} disabled={updating !== null || checking} aria-busy={updating === engine} onClick={() => onUpdate(engine)}
                    icon={updating === engine ? <RefreshCw size={14} aria-hidden="true" className="spinning" /> : undefined}>
                    {updating === engine ? "Updating…" : "Update"}
                  </Button>
                  : <span className={`setting-pill raised${ready ? " ready" : notice?.blocking ? " blocked" : ""}`}>{engineStatusWord(readiness)}</span>}
            </SettingRowBase>
          );
        })}
      </SettingsSection>
      <SettingsSection setting="engines.agent-settings" description="Apply changes to your engines' settings. Busy agents reload when their work finishes."
        detail={<p role="status" className={`settings-status ${RELOAD_TONE[reloadStatus]}`}>{reloadLine(reloadStatus, reloadError)}</p>}
        action={
          <Button onClick={onReload} disabled={reloadStatus === "reloading" || reloadStatus === "pending"} aria-busy={reloadStatus === "reloading"} icon={<SpinningIcon icon={RefreshCw} spinning={reloadStatus === "reloading"} size={14} aria-hidden="true" />}>
            {reloadStatus === "reloading" ? "Reloading…" : "Reload agent settings"}
          </Button>
        } />
    </SettingsPage>
  );
}
