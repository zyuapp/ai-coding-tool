import type { SettingId } from "../../domain/settings-catalog";
import { SettingRow, SettingSwitch } from "./SettingRow";
import { SettingsSection } from "./SettingsLayout";

export type AvailabilitySectionProps = {
  /** The switch the section draws, which names both the heading and the row. */
  id: SettingId;
  description: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
};

/** One switch that turns a whole capability on or off, above the settings that only matter while it is on. */
export function AvailabilitySection({ id, description, enabled, onChange }: AvailabilitySectionProps) {
  return (
    <SettingsSection title="Availability">
      <SettingRow id={id} description={description}>
        <SettingSwitch id={id} on={enabled} onChange={onChange} />
      </SettingRow>
    </SettingsSection>
  );
}
