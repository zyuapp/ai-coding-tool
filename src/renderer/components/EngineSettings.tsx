import { LuRefreshCw as RefreshCw } from "react-icons/lu";
import { AGENT_ENGINES, engineLabel, engineNotice, type AgentEngine, type EngineReadiness } from "../../domain/agent-engine";
import { CopyButton } from "./CopyButton";
import { ThreadEngineIcon } from "./ThreadEngineIcon";

export type EngineSettingsProps = {
  engineAccess: Record<AgentEngine, EngineReadiness>;
  /** True while the app is running the engine commands, which the button says out loud. */
  checking: boolean;
  onRefresh: () => void;
  onSignIn: (engine: AgentEngine) => void;
};

/** The word in the right column: short enough to read at a glance, plain enough to need no key. */
function statusWord(readiness: EngineReadiness) {
  if (readiness.access === "missing") return "Not installed";
  if (readiness.access === "outdated") return "Too old";
  if (readiness.access === "unavailable") return "Will not start";
  if (readiness.access === "signed-out") return "Signed out";
  return readiness.required ? "Behind" : "Ready";
}

/** What this engine is doing on this machine, under its name. */
function statusLine(engine: AgentEngine, readiness: EngineReadiness) {
  const notice = engineNotice(engine, readiness);
  if (notice) return notice.message;
  if (readiness.access === "signed-out") return `Sign in to run threads on ${engineLabel(engine)}.`;
  return readiness.version ? `Version ${readiness.version}` : "Installed and ready.";
}

export function EngineSettings({ engineAccess, checking, onRefresh, onSignIn }: EngineSettingsProps) {
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Engines</h2>
        <p>AI Coding Tool runs the Claude Code and Codex commands installed on this Mac.</p>
      </div>

      <section className="settings-group" aria-labelledby="engines-heading" aria-live="polite">
        <div className="settings-group-heading">
          <div>
            <h3 id="engines-heading">Installed engines</h3>
            <p>Install or upgrade an engine in your terminal, then check again here.</p>
          </div>
          <div className="settings-group-action">
            <button type="button" disabled={checking} onClick={onRefresh}>
              <RefreshCw size={13} aria-hidden="true" />{checking ? "Checking…" : "Check again"}
            </button>
          </div>
        </div>

        {AGENT_ENGINES.map((engine) => {
          const readiness = engineAccess[engine];
          const notice = engineNotice(engine, readiness);
          const ready = !notice && readiness.access === "ready";
          return (
            <div className="setting-row engine-setting-row" key={engine}>
              <span className={`setting-status ${ready ? "granted" : ""}`}><ThreadEngineIcon engine={engine} size={13} /></span>
              <div>
                <strong>{engineLabel(engine)}</strong>
                <p>{statusLine(engine, readiness)}</p>
                {notice?.fix && (
                  <div className="setting-readiness">
                    <code>{notice.fix}</code>
                    <CopyButton text={notice.fix} label={`Copy ${notice.fix}`} />
                  </div>
                )}
              </div>
              <div className="setting-row-action">
                {readiness.access === "signed-out"
                  ? <button type="button" onClick={() => onSignIn(engine)}>Sign in</button>
                  : <em className={ready ? "granted" : ""}>{statusWord(readiness)}</em>}
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}
