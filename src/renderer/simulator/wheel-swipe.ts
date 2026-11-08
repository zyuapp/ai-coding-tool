/** How long the wheel has to rest before the finger it drives lifts. */
export const WHEEL_IDLE_MS = 140;
/** How near an edge the finger may come before it lifts and lands again where it started. */
const EDGE = 0.02;
/** How far a scroll has to go before the finger lands, so a nudge of the trackpad is never read as a tap. */
const LANDING = 0.03;

export type WheelTouch = (phase: "down" | "move" | "up", x: number, y: number) => void;

/**
 * Turns a trackpad's scrolling into a finger dragging the screen: it lands where the pointer is,
 * moves against the scroll so the content follows the fingers, and lifts once the scrolling stops.
 * Positions are fractions of the screen as it is shown.
 */
export class WheelSwipe {
  private at: { x: number; y: number } | null = null;
  /** Where a scroll too short to land yet began, and how far it has gone. */
  private pending: { x: number; y: number; dx: number; dy: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly touch: WheelTouch, private readonly idleMs = WHEEL_IDLE_MS) {}

  /** One wheel event over the screen: where the pointer is, and how far it scrolled, as fractions of the screen. */
  wheel(x: number, y: number, dx: number, dy: number) {
    if (!this.at) {
      const pending = this.pending ?? { x, y, dx: 0, dy: 0 };
      this.pending = { ...pending, dx: pending.dx + dx, dy: pending.dy + dy };
      this.schedule();
      if (Math.hypot(this.pending.dx, this.pending.dy) < LANDING) return;
      this.at = { x: pending.x, y: pending.y };
      this.touch("down", pending.x, pending.y);
      ({ dx, dy } = this.pending);
      this.pending = null;
    }
    const next = { x: this.at.x - dx, y: this.at.y - dy };
    const clamped = { x: Math.min(1 - EDGE, Math.max(EDGE, next.x)), y: Math.min(1 - EDGE, Math.max(EDGE, next.y)) };
    this.at = clamped;
    this.touch("move", clamped.x, clamped.y);
    /** A finger at the edge can drag no further, so it lifts, and the next scroll lands it under the pointer again. */
    if (clamped.x !== next.x || clamped.y !== next.y) return this.lift();
    this.schedule();
  }

  /** Lifts the finger now, wherever it is. */
  lift() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.at) this.touch("up", this.at.x, this.at.y);
    this.at = null;
    this.pending = null;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.lift(), this.idleMs);
  }
}
