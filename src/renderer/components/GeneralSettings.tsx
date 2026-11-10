import { useEffect, useState } from "react";
import { LuLoaderCircle as LoaderCircle } from "react-icons/lu";
import type { CliState } from "../../application/cli-installation";
import { CLI_COMMAND, CLI_INSTALL_PATH, type CliStatus } from "../../domain/cli";
import { NO_APP_UPDATE, type AppUpdate } from "../../domain/app-update";
import type { DictationModel } from "../../domain/dictation";
import { platformCapabilities } from "../platform";
import { SettingRow, SettingSwitch } from "./SettingRow";
import { ConfirmAction } from "../ui/ConfirmAction";
import { SpinningIcon } from "./SpinningIcon";
import { SettingsSection } from "./SettingsLayout";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/Kbd";

function cliDescription(status: CliStatus | null) {
  if (!status) return "Looking for the command…";
  switch (status.state) {
    case "installed": return status.onPath === false
      ? `Installed at ${status.path}. Add its folder to PATH to run ${CLI_COMMAND} by name.`
      : `Installed at ${status.path}.`;
    case "conflict": return `Something else already answers to ${CLI_COMMAND} at ${status.path}.`;
    case "unsupported": return "The command can only be installed on macOS or Linux.";
    default: return status.path === CLI_INSTALL_PATH
      ? `Goes in ${status.path}, which asks for your password once.`
      : `Goes in ${status.path}, inside your user account.`;
  }
}

/** A newer build as the updater last reported it, and the steps that take it. `version` is the build running now. */
export type AppUpdateSettings = { state: AppUpdate; version?: string | null; onDownload: () => void; onInstall: () => void };

export const NO_APP_UPDATE_SETTINGS: AppUpdateSettings = { state: NO_APP_UPDATE, onDownload() {}, onInstall() {} };

function updateDescription(update: AppUpdate, current: string | null | undefined) {
  switch (update.status) {
    case "available": return `Version ${update.version} is available.`;
    case "downloading": return `Downloading version ${update.version}.`;
    case "ready": return `Version ${update.version} is downloaded. Restart to install it.`;
    default: return current ? `Version ${current}.` : null;
  }
}

/** The speech model holding to talk reads, and the step that fetches it. */
export type DictationSettings = { model: DictationModel; message: string | null; progress: number | null; binding: string | null; onDownload: () => void; onCancelDownload: () => void };

function dictationDescription(dictation: DictationSettings) {
  const { model, message } = dictation;
  const { computerName, dictationModel: { size, shared } } = platformCapabilities();
  switch (model) {
    case "ready": return `Parakeet, on ${computerName}.${shared ? " Shared with other apps that use it." : ""}`;
    case "downloading": return dictation.progress === null ? `Getting Parakeet ready for ${computerName}.` : `Downloading Parakeet, ${size}.`;
    case "failed": return message ?? "The download stopped.";
    default: return `Parakeet, ${size}. Downloaded once${shared ? " and shared with other apps that use it" : ""}.`;
  }
}

export type GeneralSettingsProps = {
  dictation?: DictationSettings;
  /** The terminal command: where it stands, whether it is being changed, and what stopped the last try. */
  cli: CliState;
  onReadCli: () => void;
  onSetCliInstalled: (installed: boolean) => void;
  /** Whether runs reach the user's own Chrome through the Claude in Chrome extension. */
  chromeBrowser: boolean;
  onSetChromeBrowser: (enabled: boolean) => void;
  /** Whether a thread that needs the user announces itself on the desktop. */
  notifications: boolean;
  onSetNotifications: (enabled: boolean) => void;
  onCheckForUpdates: () => void;
  update?: AppUpdateSettings;
  onOpenSourceLicenses: () => void;
};

export function GeneralSettings({ dictation, cli: { status, busy, error }, onReadCli, onSetCliInstalled, chromeBrowser, onSetChromeBrowser, notifications, onSetNotifications, onCheckForUpdates, update = NO_APP_UPDATE_SETTINGS, onOpenSourceLicenses }: GeneralSettingsProps) {
  useEffect(() => { onReadCli(); }, []);
  /** Which CLI button started the change in flight, so only that one reads as working. */
  const [cliStep, setCliStep] = useState<"install" | "remove" | null>(null);
  const setCli = (installed: boolean) => {
    setCliStep(installed ? "install" : "remove");
    onSetCliInstalled(installed);
  };
  const installing = busy && cliStep !== "remove";
  const removing = busy && cliStep === "remove";

  return (
    <>
      <SettingsSection title="Terminal command" description={<>Run <code>{CLI_COMMAND}</code> in a folder to open it here as a project, or <code>{CLI_COMMAND} ~/code/app</code> to open another one.</>}>
        <SettingRow id="general.cli" status={status?.state === "installed"} description={cliDescription(status)}>
          {!status && !error && <em><SpinningIcon icon={LoaderCircle} spinning size={12} aria-hidden="true" />Checking…</em>}
          {!status && error && <Button onClick={onReadCli}>Check again</Button>}
          {status?.state === "installed" && status.current === false && <Button disabled={busy} aria-busy={installing || undefined} onClick={() => setCli(true)}>{installing ? "Updating…" : "Update"}</Button>}
          {status?.state === "installed" && <ConfirmAction disabled={busy} aria-busy={removing || undefined} confirm={`Uninstall ${CLI_COMMAND}`} onConfirm={() => setCli(false)}>{removing ? "Removing…" : "Uninstall"}</ConfirmAction>}
          {status?.state === "missing" && <Button disabled={busy} aria-busy={busy || undefined} onClick={() => setCli(true)}>{busy ? "Installing…" : "Install"}</Button>}
          {status?.state === "conflict" && <ConfirmAction disabled={busy} aria-busy={busy || undefined} confirm={`Replace ${status.path}`} onConfirm={() => setCli(true)}>{busy ? "Installing…" : "Replace it"}</ConfirmAction>}
        </SettingRow>

        {error && <p className="settings-error" role="alert">{error}</p>}
      </SettingsSection>

      {dictation && dictation.model !== "unsupported" && <SettingsSection title="Dictation" description={<>Hold the microphone{dictation.binding ? <> or <Kbd keys={[dictation.binding]} size="inline" /></> : null} and let go to add the words to your message, or tap it to talk hands-free. What you say stays on {platformCapabilities().computerName}.</>}>
        <SettingRow id="general.dictation" status={dictation.model === "ready"} description={dictationDescription(dictation)}>
          {(dictation.model === "missing" || dictation.model === "failed") && <Button onClick={dictation.onDownload}>{dictation.model === "failed" ? "Try again" : "Download"}</Button>}
          {dictation.model === "downloading" && <em role="status"><SpinningIcon icon={LoaderCircle} spinning size={12} aria-hidden="true" />{dictation.progress === null ? "Preparing…" : `${Math.round(dictation.progress * 100)}%`}</em>}
          {dictation.model === "downloading" && <Button onClick={dictation.onCancelDownload}>Cancel</Button>}
        </SettingRow>
      </SettingsSection>}

      <SettingsSection title="Notifications">
        <SettingRow id="general.notifications" description="When a run finishes, fails, or needs you. Your phone hears it once you step away from this computer.">
          <SettingSwitch id="general.notifications" on={notifications} onChange={onSetNotifications} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Claude" description="Experimental settings that only Claude threads read. They can change or disappear.">
        <SettingRow id="general.chrome-browser" description="Claude drives the Chrome you already have open, instead of the browser panel, when you ask for your own browser. Needs the Claude in Chrome extension, and Chrome running.">
          <SettingSwitch id="general.chrome-browser" on={chromeBrowser} onChange={onSetChromeBrowser} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="AI Coding Tool">
        <SettingRow id="general.updates" description={updateDescription(update.state, update.version)}>
          {update.state.status === "idle" && <Button onClick={onCheckForUpdates}>Check for updates</Button>}
          {update.state.status === "available" && <Button onClick={update.onDownload}>Download</Button>}
          {update.state.status === "downloading" && <em role="status"><SpinningIcon icon={LoaderCircle} spinning size={12} aria-hidden="true" />{update.state.percent}%</em>}
          {update.state.status === "ready" && <Button onClick={update.onInstall}>Restart to update</Button>}
        </SettingRow>
        <SettingRow id="general.licenses" description={null}>
          <Button onClick={onOpenSourceLicenses}>View licenses</Button>
        </SettingRow>
      </SettingsSection>
    </>
  );
}
