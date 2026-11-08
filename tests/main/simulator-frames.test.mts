import assert from "node:assert/strict";
import { test } from "vitest";
import { FrameReader, type HelperMessage } from "../../src/main/simulator-frames.ts";

function frame(kind: number, payload: Buffer) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = kind;
  return Buffer.concat([head, payload]);
}

function binary(header: object, data: number[]) {
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(2);
  length.writeUInt16BE(json.length, 0);
  return Buffer.concat([length, json, Buffer.from(data)]);
}

test("frames are read whole however the pipe splits them", () => {
  const messages: HelperMessage[] = [];
  const reader = new FrameReader((message) => messages.push(message));
  const stream = Buffer.concat([
    frame(0, Buffer.from(JSON.stringify({ id: 1, ok: true }))),
    frame(2, binary({ udid: "U", width: 1206, height: 2622 }, [1, 100, 0, 31])),
    frame(1, binary({ udid: "U", key: true, ts: 16_000 }, [0, 0, 0, 1, 9])),
  ]);
  for (let index = 0; index < stream.length; index += 3) reader.push(stream.subarray(index, index + 3));

  assert.deepEqual(messages, [
    { kind: "json", json: { id: 1, ok: true } },
    { kind: "frame", frame: { udid: "U", kind: "config", width: 1206, height: 2622, data: new Uint8Array([1, 100, 0, 31]) } },
    { kind: "frame", frame: { udid: "U", kind: "chunk", key: true, timestamp: 16_000, data: new Uint8Array([0, 0, 0, 1, 9]) } },
  ]);
});

test("a frame that does not parse is dropped and the next one still reads", () => {
  const messages: HelperMessage[] = [];
  const reader = new FrameReader((message) => messages.push(message));
  reader.push(Buffer.concat([frame(0, Buffer.from("{nope")), frame(0, Buffer.from("{\"event\":\"ready\"}"))]));
  assert.deepEqual(messages, [{ kind: "json", json: { event: "ready" } }]);
  assert.throws(() => reader.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0])), /malformed frame/);
});
