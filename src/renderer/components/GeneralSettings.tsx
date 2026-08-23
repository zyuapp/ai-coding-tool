import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { CLI_COMMAND, type CliStatus } from "../../domain/cli";

function cliDescription(status: CliStatus | null) {
  if (!status) return "Looking for the command…";
  switch (status.state) {
    case "installed": return `Installed at ${status.path}.`;
    case "conflict": return `Something else already answers to ${CLI_COMMAND} at ${status.path}.`;
    case "unsupported": return "The command can only be installed on macOS.";
    default: return `Goes in ${status.path}, which asks for your password once.`;
  }
}

export type GeneralSettingsProps = {
  /** Whether runs answer in the Simplified Technical English style the app installs. */
  plainEnglish: boolean;
  onSetPlainEnglish: (enabled: boolean) => void;
};

export function GeneralSettings({ plainEnglish, onSetPlainEnglish }: GeneralSettingsProps) {
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [cliBusy, setCliBusy] = useState(false);
  const [cliError, setCliError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.desktop.cliStatus()
      .then((status) => { if (!cancelled) setCli(status); })
      .catch((cause) => { if (!cancelled) setCliError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);

  async function changeCli(install: boolean) {
    setCliBusy(true);
    setCliError(null);
    try {
      setCli(await (install ? window.desktop.installCli() : window.desktop.uninstallCli()));
    } catch (cause) {
      setCliError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCliBusy(false);
    }
  }

  return (
    <>
      <section className="settings-group" aria-labelledby="cli-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="cli-heading">Terminal command</h3>
            <p>Run <code>{CLI_COMMAND}</code> in a folder to open it here as a project, or <code>{CLI_COMMAND} ~/code/app</code> to open another one.</p>
          </div>
        </div>

        <div className="setting-row">
          <span className={`setting-status ${cli?.state === "installed" ? "granted" : ""}`}>{cli?.state === "installed" && <Check size={13} />}</span>
          <div>
            <strong>{CLI_COMMAND}</strong>
            <p>{cliDescription(cli)}</p>
          </div>
          <div className="setting-row-action">
            {!cli && !cliError && <em>Checking…</em>}
            {cli?.state === "installed" && <button type="button" disabled={cliBusy} onClick={() => void changeCli(false)}>{cliBusy ? "Removing…" : "Uninstall"}</button>}
            {(cli?.state === "missing" || cli?.state === "conflict") && (
              <button type="button" disabled={cliBusy} onClick={() => void changeCli(true)}>
                {cliBusy ? "Installing…" : cli.state === "conflict" ? "Replace it" : "Install"}
              </button>
            )}
          </div>
        </div>

        {cliError && <p className="settings-error" role="alert">{cliError}</p>}
      </section>

      <section className="settings-group" aria-labelledby="experimental-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="experimental-heading">Experimental</h3>
            <p>These settings can change or disappear.</p>
          </div>
        </div>

        <div className="setting-row">
          <span className={`setting-status ${plainEnglish ? "granted" : ""}`}>{plainEnglish && <Check size={13} />}</span>
          <div>
            <strong>Simplified Technical English</strong>
            <p>Claude answers in short sentences, lists, and tables.</p>
          </div>
          <div className="setting-row-action">
            <button type="button" role="switch" aria-checked={plainEnglish} onClick={() => onSetPlainEnglish(!plainEnglish)}>{plainEnglish ? "Turn off" : "Turn on"}</button>
          </div>
        </div>
      </section>
    </>
  );
}
