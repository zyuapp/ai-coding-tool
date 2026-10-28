import { LuArrowDown as ArrowDown, LuRotateCw as Restart, LuSettings as Settings } from "react-icons/lu";
import type { AppUpdate } from "../../domain/app-update";
import { displayShortcut } from "../../domain/shortcuts";
import { MAC } from "../platform";

const SETTINGS_TIP = `Settings (${displayShortcut("Mod+,", MAC)})`;

const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function ProgressRing({ percent }: { percent: number }) {
  return (
    <svg className="sidebar-update-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="sidebar-update-ring-track" cx="8" cy="8" r={RING_RADIUS} />
      <circle
        className="sidebar-update-ring-fill"
        cx="8"
        cy="8"
        r={RING_RADIUS}
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={RING_LENGTH * (1 - percent / 100)}
      />
    </svg>
  );
}

/** A newer build: offered, then downloading, then waiting on a restart. */
function SidebarUpdate({ update, onDownload, onInstall }: {
  update: AppUpdate;
  onDownload: () => void;
  onInstall: () => void;
}) {
  switch (update.status) {
    case "idle":
      return null;
    case "available": {
      const label = `Update to version ${update.version}`;
      return (
        <button className="sidebar-update labelled" type="button" aria-label={label} data-tip={label} onClick={onDownload}>
          <ArrowDown size={14} aria-hidden="true" />
          <span>Update</span>
        </button>
      );
    }
    case "downloading": {
      const label = `Downloading version ${update.version}: ${update.percent}%`;
      return (
        <div
          className="sidebar-update downloading"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={update.percent}
          data-tip={label}
        >
          <ProgressRing percent={update.percent} />
        </div>
      );
    }
    case "ready": {
      const label = `Restart to install version ${update.version}`;
      return (
        <button className="sidebar-update labelled ready" type="button" aria-label={label} data-tip={label} onClick={onInstall}>
          <Restart size={14} aria-hidden="true" />
          <span>Restart</span>
        </button>
      );
    }
  }
}

export function SidebarFooter({ settingsOpen, onOpenSettings, update, onDownloadUpdate, onInstallUpdate }: {
  settingsOpen: boolean;
  onOpenSettings: () => void;
  update: AppUpdate;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
}) {
  return (
    <div className="sidebar-footer">
      <button className={`sidebar-settings ${settingsOpen ? "active" : ""}`} type="button" aria-pressed={settingsOpen} data-tip={SETTINGS_TIP} onClick={onOpenSettings}>
        <Settings size={18} aria-hidden="true" />
        <span>Settings</span>
      </button>
      <SidebarUpdate update={update} onDownload={onDownloadUpdate} onInstall={onInstallUpdate} />
    </div>
  );
}
