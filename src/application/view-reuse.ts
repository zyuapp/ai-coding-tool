/**
 * Holds a surface's view still while the state around it moves. A run reports on every tool call and
 * every helper agent it starts, and each report rewrites the workspace; without this, every surface
 * would be redrawn by work it reads nothing of.
 *
 * Reuse turns on the data alone. A view is handed back only when every field of the new one matches
 * the last, so a surface is redrawn whenever anything it reads moves — and never held back because
 * it happens to be off screen.
 */
export function heldViews<T extends { id: string }>() {
  let held: T[] = [];
  return (views: T[]): T[] => {
    const previous = held;
    const reused = views.map((view) => {
      const before = previous.find((candidate) => candidate.id === view.id);
      return before && sameFields(before, view) ? before : view;
    });
    if (reused.length === previous.length && reused.every((view, index) => previous[index] === view)) return previous;
    held = reused;
    return reused;
  };
}

function sameFields(left: object, right: object): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key]);
}
