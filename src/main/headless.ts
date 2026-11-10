/** A refusal for what only the desktop app can do, on a host that draws nothing. */
export function needsDesktop(what: string) {
  return async (): Promise<never> => { throw new Error(`${what} needs the desktop app.`); };
}

export const nothing = () => {};

/** A subscription to something that never happens here. */
export const unsubscribed = () => () => {};

/** A value answered once, then null from then on. */
export function answeredOnce<Value>(value: Value | null) {
  let held = value;
  return async () => {
    const answer = held;
    held = null;
    return answer;
  };
}
