/**
 * Workspace state on a wire. JSON has no sets, and the state keeps one, so a set travels as an
 * object no state would otherwise hold and comes back as the set it was.
 */
const SET_KEY = "$set";

function encoded(_key: string, value: unknown): unknown {
  return value instanceof Set ? { [SET_KEY]: [...value] } : value;
}

function decoded(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === SET_KEY && Array.isArray(record[SET_KEY])) return new Set(record[SET_KEY]);
  }
  return value;
}

export function stringifyWorkspaceJson(value: unknown): string {
  return JSON.stringify(value, encoded);
}

export function parseWorkspaceJson(text: string): unknown {
  return JSON.parse(text, decoded);
}
