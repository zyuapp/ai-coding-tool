const DAY_MS = 86_400_000;

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const DATE_YEAR = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function dayStart(moment: number) {
  const day = new Date(moment);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * When something last moved, as short as the gap allows: the time today, then "Yesterday", the
 * weekday inside a week, and the date past that. Days are calendar days, so a moment before
 * midnight is yesterday an hour later.
 */
export function recencyLabel(at: number, now: number): string {
  const days = Math.round((dayStart(now) - dayStart(at)) / DAY_MS);
  if (days <= 0) return TIME.format(at);
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAY.format(at);
  return (new Date(at).getFullYear() === new Date(now).getFullYear() ? DATE : DATE_YEAR).format(at);
}
