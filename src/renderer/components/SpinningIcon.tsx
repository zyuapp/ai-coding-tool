import { useState } from "react";
import type { IconBaseProps, IconType } from "react-icons";

/**
 * An icon that turns while work runs. Work that ends in a blink still shows one full turn, and the
 * icon comes to rest upright at the end of a turn instead of snapping back mid-spin.
 */
export function SpinningIcon({ icon: Icon, spinning, ...props }: { icon: IconType; spinning: boolean } & IconBaseProps) {
  const [turning, setTurning] = useState(spinning);
  if (spinning && !turning) setTurning(true);
  return <Icon {...props} className={turning ? "spinning" : undefined} onAnimationIteration={() => { if (!spinning) setTurning(false); }} />;
}
