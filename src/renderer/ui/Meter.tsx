import type { ComponentPropsWithRef } from "react";
import "./tone.css";
import "./meter.css";

export type MeterProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  /** The share filled, from 0 to 1; anything outside is clamped. */
  value: number;
  tone?: "accent" | "info" | "success" | "warning" | "danger";
  size?: "hair" | "thin" | "groove";
  /** Names the meter for assistive technology; without one it is decoration beside a figure that says the same. */
  label?: string;
};

/** A bar filled to a share. */
export function Meter({ value, tone, size = "thin", label, className, ...rest }: MeterProps) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 1000) / 10;
  const named = label
    ? { role: "meter", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent }
    : { "aria-hidden": true };
  return (
    <span {...named} {...rest} className={className ? `meter ${className}` : "meter"} data-size={size} data-tone={tone}>
      <span className="meter-fill" style={{ width: `${percent}%` }} />
    </span>
  );
}
