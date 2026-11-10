import type { ReactNode } from "react";
import { Meter } from "../ui/Meter";
import "../ui/glass.css";

/** A meter's hover card: what it measures, then one bar per thing it counts. */
export function UsageCard({ id, title, aside, children }: { id: string; title: string; aside?: string | null; children: ReactNode }) {
  return (
    <span className="glass-popover usage-card" id={id} role="tooltip">
      <span className="usage-card-heading"><strong>{title}</strong>{aside && <span>{aside}</span>}</span>
      {children}
    </span>
  );
}

/** `share` is 0-100; a share at or past `high` draws in the accent. */
export function UsageCardRow({ label, value, share, high = false, detail }: { label: string; value: string; share: number; high?: boolean; detail?: string | null }) {
  return (
    <span className="usage-card-row">
      <span className="usage-card-label"><span>{label}</span><span className={high ? "high" : undefined}>{value}</span></span>
      <Meter className="usage-card-track" value={share / 100} size="groove" tone={high ? "accent" : "info"} />
      {detail && <span className="usage-card-detail">{detail}</span>}
    </span>
  );
}
