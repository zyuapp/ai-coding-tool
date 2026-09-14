/** User input and frames for a browser whose pixels are drawn on another computer. */
export type BrowserViewport = { width: number; height: number };
export type BrowserFrame = BrowserViewport & { data: string; epoch: number };
export type BrowserControl =
  | { kind: "pointer"; phase: "down" | "up" | "move"; x: number; y: number; button: "left" | "middle" | "right" | "none"; buttons: number; clicks: number; modifiers: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { kind: "key"; phase: "down" | "up"; key: string; code: string; keyCode: number; modifiers: number; repeat: boolean }
  | { kind: "text"; text: string };

export const MAX_BROWSER_FRAME_BYTES = 512 * 1024;
export const MAX_BROWSER_VIEWPORT = 1920;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function coordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 16_384;
}
export function isBrowserViewport(value: unknown): value is BrowserViewport {
  return record(value) && integer(value.width, 1, MAX_BROWSER_VIEWPORT) && integer(value.height, 1, MAX_BROWSER_VIEWPORT);
}
export function isBrowserFrame(value: unknown): value is BrowserFrame | null {
  return value === null || record(value) && integer(value.width, 1, 16_384) && integer(value.height, 1, 16_384)
    && integer(value.epoch, 0, Number.MAX_SAFE_INTEGER) && typeof value.data === "string"
    && value.data.length > 0 && value.data.length <= MAX_BROWSER_FRAME_BYTES && /^[A-Za-z0-9+/]+=*$/.test(value.data);
}
export function isBrowserControl(value: unknown): value is BrowserControl {
  if (!record(value)) return false;
  if (value.kind === "text") return typeof value.text === "string" && value.text.length > 0 && value.text.length <= 16_384;
  if (!integer(value.modifiers, 0, 15)) return false;
  if (value.kind === "key") return (value.phase === "down" || value.phase === "up")
    && typeof value.key === "string" && value.key.length <= 100 && typeof value.code === "string" && value.code.length <= 100
    && integer(value.keyCode, 0, 255) && typeof value.repeat === "boolean";
  if (!coordinate(value.x) || !coordinate(value.y)) return false;
  if (value.kind === "pointer") return ["down", "up", "move"].includes(String(value.phase))
    && ["left", "middle", "right", "none"].includes(String(value.button)) && integer(value.buttons, 0, 7) && integer(value.clicks, 0, 3);
  return value.kind === "wheel" && typeof value.deltaX === "number" && Number.isFinite(value.deltaX) && Math.abs(value.deltaX) <= 10_000
    && typeof value.deltaY === "number" && Number.isFinite(value.deltaY) && Math.abs(value.deltaY) <= 10_000;
}
