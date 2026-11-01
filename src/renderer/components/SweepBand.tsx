/**
 * The bright band a `.text-sweep` label carries: a second copy of the label, in ink, seen through a
 * soft window. The window slides one way and the copy the other, so the copy stays on the letters.
 * Both move by transform, which the compositor animates without repainting the page each frame. The
 * copy is generated content, so the label's text reads once.
 */
export function SweepBand({ children }: { children: string }) {
  return <span className="sweep-band" data-text={children} aria-hidden="true" />;
}
