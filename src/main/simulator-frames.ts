import type { SimulatorFrame } from "../domain/simulator.js";

/** What the helper says: a JSON answer or event, or a piece of a screen stream. */
export type HelperMessage = { kind: "json"; json: Record<string, unknown> } | { kind: "frame"; frame: SimulatorFrame };

const JSON_KIND = 0;
const CHUNK_KIND = 1;
const CONFIG_KIND = 2;
/** Far beyond any frame a phone's screen encodes to, so a corrupt length is caught rather than awaited. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

function binary(kind: number, payload: Buffer): SimulatorFrame | null {
  if (payload.length < 2) return null;
  const headerLength = payload.readUInt16BE(0);
  if (payload.length < 2 + headerLength) return null;
  const header = JSON.parse(payload.subarray(2, 2 + headerLength).toString("utf8")) as Record<string, unknown>;
  if (typeof header.udid !== "string") return null;
  const data = new Uint8Array(payload.subarray(2 + headerLength));
  if (kind === CONFIG_KIND) return { udid: header.udid, kind: "config", width: Number(header.width), height: Number(header.height), data };
  return { udid: header.udid, kind: "chunk", key: header.key === true, timestamp: Number(header.ts), data };
}

/** Splits the helper's stdout, `[u32 length][u8 kind][payload]` after another, however the pipe chunks it. */
export class FrameReader {
  private buffered: Buffer[] = [];
  private size = 0;

  constructor(private readonly deliver: (message: HelperMessage) => void) {}

  push(chunk: Buffer) {
    this.buffered.push(chunk);
    this.size += chunk.length;
    while (this.size >= 4) {
      const length = this.peekLength();
      if (length < 1 || length > MAX_FRAME_BYTES) throw new Error("The simulator helper sent a malformed frame.");
      if (this.size < 4 + length) return;
      const body = this.take(4 + length).subarray(4);
      const kind = body[0];
      const payload = body.subarray(1);
      try {
        if (kind === JSON_KIND) {
          const json = JSON.parse(payload.toString("utf8")) as unknown;
          if (json && typeof json === "object") this.deliver({ kind: "json", json: json as Record<string, unknown> });
        } else if (kind === CHUNK_KIND || kind === CONFIG_KIND) {
          const frame = binary(kind, payload);
          if (frame) this.deliver({ kind: "frame", frame });
        }
      } catch {
        // A frame that does not parse is dropped; the next keyframe recovers the stream.
      }
    }
  }

  /** The next frame's length, read across chunks without joining them. */
  private peekLength() {
    const head = Buffer.alloc(4);
    let filled = 0;
    for (const chunk of this.buffered) {
      filled += chunk.copy(head, filled, 0, Math.min(chunk.length, 4 - filled));
      if (filled === 4) break;
    }
    return head.readUInt32BE(0);
  }

  /** Consumes the first `count` bytes, joining chunks only once a whole frame is in. */
  private take(count: number): Buffer {
    const joined = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered, this.size);
    const rest = joined.subarray(count);
    this.buffered = rest.length ? [rest] : [];
    this.size = rest.length;
    return joined.subarray(0, count);
  }
}
