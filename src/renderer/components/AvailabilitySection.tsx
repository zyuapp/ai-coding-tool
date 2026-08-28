import { LuCheck as Check } from "react-icons/lu";

export type AvailabilitySectionProps = {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
};

/** One switch that turns a whole capability on or off, above the settings that only matter while it is on. */
export function AvailabilitySection({ id, label, description, enabled, onChange }: AvailabilitySectionProps) {
  return (
    <section className="settings-group" aria-labelledby={`${id}-heading`}>
      <div className="settings-group-heading">
        <div><h3 id={`${id}-heading`}>Availability</h3></div>
      </div>

      <div className="setting-row">
        <span className={`setting-status ${enabled ? "granted" : ""}`}>{enabled && <Check size={13} />}</span>
        <div>
          <strong>{label}</strong>
          <p>{description}</p>
        </div>
        <div className="setting-row-action">
          <button type="button" role="switch" aria-checked={enabled} onClick={() => onChange(!enabled)}>{enabled ? "Turn off" : "Turn on"}</button>
        </div>
      </div>
    </section>
  );
}
