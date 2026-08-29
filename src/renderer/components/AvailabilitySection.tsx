import { settingControl, type SettingId } from "../../domain/settings-catalog";
import { SettingRow } from "./SettingRow";

export type AvailabilitySectionProps = {
  /** The switch the section draws, which names both the heading and the row. */
  id: SettingId;
  description: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
};

/** One switch that turns a whole capability on or off, above the settings that only matter while it is on. */
export function AvailabilitySection({ id, description, enabled, onChange }: AvailabilitySectionProps) {
  /** The catalog keys a control with a dot, which no selector wants in an element id. */
  const heading = `${id.replace(".", "-")}-heading`;
  return (
    <section className="settings-group" aria-labelledby={heading}>
      <div className="settings-group-heading">
        <div><h3 id={heading}>Availability</h3></div>
      </div>

      <SettingRow id={id} status={enabled} description={description}>
        <button type="button" role="switch" aria-checked={enabled} aria-label={settingControl(id).label} onClick={() => onChange(!enabled)}>{enabled ? "Turn off" : "Turn on"}</button>
      </SettingRow>
    </section>
  );
}
