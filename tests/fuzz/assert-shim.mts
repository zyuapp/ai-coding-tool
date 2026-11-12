/** `node:assert` for a bundle that runs in a browser: the fixtures it carries only call `ok`. */
function ok(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(message ?? "assertion failed");
}
export default Object.assign(ok, { ok });
