import { WHEEL_IDLE_MS } from "./wheel-swipe";

/** How far apart the two fingers land, as a fraction of the screen's width. */
const LANDING_SPREAD = 0.16;
const EDGE = 0.02;

export type PinchFingers = { x: number; y: number; x2: number; y2: number };
export type PinchTouch = (phase: "down" | "move" | "up", fingers: PinchFingers) => void;

/**
 * Turns a trackpad's pinch, which arrives as a wheel with Control held, into two fingers spreading or
 * closing around the pointer. They lift once the pinch stops. Positions are fractions of the screen as it is shown.
 */
export class WheelPinch {
  private center: { x: number; y: number } | null = null;
  private spread = LANDING_SPREAD;
  private fingers: PinchFingers | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly touch: PinchTouch, private readonly idleMs = WHEEL_IDLE_MS) {}

  /** One pinch event over the screen: where the pointer is, and the wheel's vertical delta, which is negative as fingers spread. */
  pinch(x: number, y: number, deltaY: number) {
    if (!this.center) {
      this.center = { x, y };
      this.spread = LANDING_SPREAD;
      this.fingers = this.place();
      this.touch("down", this.fingers);
    }
    this.spread *= Math.exp(-deltaY / 100);
    this.fingers = this.place();
    this.touch("move", this.fingers);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.lift(), this.idleMs);
  }

  lift() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.fingers) this.touch("up", this.fingers);
    this.center = null;
    this.fingers = null;
  }

  /** Both fingers stay on the screen: a pinch begun near an edge moves its middle inward, so it can still spread and close. */
  private place(): PinchFingers {
    this.spread = Math.min(Math.max(this.spread, EDGE), 1 - 2 * EDGE);
    const half = this.spread / 2;
    const middle = Math.min(Math.max(this.center!.x, EDGE + half), 1 - EDGE - half);
    return { x: middle - half, y: this.center!.y, x2: middle + half, y2: this.center!.y };
  }
}
