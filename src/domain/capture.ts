/**
 * How grabbing a window announces itself. The shutter is the only feedback that lands as the shot is
 * taken; bringing the window forward is what puts the caret where the caption gets typed.
 */
export type CaptureOptions = {
  sound: boolean;
  focus: boolean;
};

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = { sound: true, focus: true };

export function isCaptureOptions(value: unknown): value is CaptureOptions {
  if (!value || typeof value !== "object") return false;
  const options = value as Record<string, unknown>;
  return typeof options.sound === "boolean" && typeof options.focus === "boolean";
}
