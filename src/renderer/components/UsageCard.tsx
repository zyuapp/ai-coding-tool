import type { ReactNode } from "react";

/** A meter's hover card: what it measures, then one bar per thing it counts. */
export function UsageCard({ id, title, aside, children }: { id: string; title: string; aside?: string | null; children: ReactNode }) {
  return (
    <span className="usage-card" id={id} role="tooltip">
      <span className="usage-card-heading"><strong>{title}</strong>{aside && <span>{aside}</span>}</span>
      {children}
    </span>
  );
}

/** `share` is 0-100; a share at or past `high` draws in the accent. */
export function UsageCardRow({ label, value, share, high = false, detail }: { label: string; value: string; share: number; high?: boolean; detail?: string | null }) {
  return (
    <span className="usage-card-row">
      <span className="usage-card-label"><span>{label}</span><span>{value}</span></span>
      <span className="usage-card-track" aria-hidden="true"><span className={high ? "high" : undefined} style={{ width: `${share}%` }} /></span>
      {detail && <span className="usage-card-detail">{detail}</span>}
    </span>
  );
}
