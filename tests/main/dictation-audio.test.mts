import assert from "node:assert/strict";
import { test } from "vitest";
import { audioLevel, pcm16Samples, resampled, wavSamples } from "../../src/main/dictation-audio.ts";
import { parakeetText, parakeetVocabulary } from "../../src/main/parakeet-onnx.ts";

function wav(options: { tag?: number; channels: number; rate: number; bits: number; data: Buffer; subformat?: number }) {
  const fmt = Buffer.alloc(options.subformat === undefined ? 16 : 40);
  fmt.writeUInt16LE(options.tag ?? 1, 0);
  fmt.writeUInt16LE(options.channels, 2);
  fmt.writeUInt32LE(options.rate, 4);
  fmt.writeUInt32LE(options.rate * options.channels * (options.bits / 8), 8);
  fmt.writeUInt16LE(options.channels * (options.bits / 8), 12);
  fmt.writeUInt16LE(options.bits, 14);
  if (options.subformat !== undefined) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(options.subformat, 24);
  }
  const chunk = (id: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, "ascii");
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), chunk("fmt ", fmt), chunk("LIST", Buffer.from("odd")), chunk("data", options.data)]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function int16(...values: number[]) {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeInt16LE(value, index * 2));
  return bytes;
}

test("16-bit samples read as -1 to 1, and a trailing odd byte is dropped", () => {
  assert.deepEqual([...pcm16Samples(Buffer.concat([int16(0, 16_384, -32_768), Buffer.from([7])]))], [0, 0.5, -1]);
});

test("silence reads as no level, a full-scale wave as nearly full, and nothing at all as silence", () => {
  assert.equal(audioLevel(new Float32Array(160)), 0);
  assert.equal(audioLevel(new Float32Array(0)), 0);
  const loud = audioLevel(Float32Array.from({ length: 160 }, (_, index) => (index % 2 ? 1 : -1)));
  assert.equal(loud, 1);
  const quiet = audioLevel(Float32Array.from({ length: 160 }, (_, index) => (index % 2 ? 0.01 : -0.01)));
  assert.ok(quiet > 0 && quiet < 0.5, `a quiet voice reads low but above silence, read ${quiet}`);
});

test("a stereo 16-bit WAV is mixed to mono at its own rate, past chunks it doesn't know", () => {
  const read = wavSamples(wav({ channels: 2, rate: 44_100, bits: 16, data: int16(16_384, 0, -32_768, 0) }));
  assert.equal(read.sampleRate, 44_100);
  assert.deepEqual([...read.samples], [0.25, -0.5]);
});

test("float WAVs read too, plainly or in the extensible format", () => {
  const data = Buffer.alloc(8);
  data.writeFloatLE(0.5, 0);
  data.writeFloatLE(-0.25, 4);
  assert.deepEqual([...wavSamples(wav({ tag: 3, channels: 1, rate: 16_000, bits: 32, data })).samples], [0.5, -0.25]);
  assert.deepEqual([...wavSamples(wav({ tag: 0xfffe, subformat: 3, channels: 1, rate: 16_000, bits: 32, data })).samples], [0.5, -0.25]);
});

test("anything but a readable WAV is refused", () => {
  assert.throws(() => wavSamples(Buffer.from("not a wav at all")), /Not a WAV/);
  assert.throws(() => wavSamples(wav({ channels: 1, rate: 16_000, bits: 8, data: Buffer.alloc(4) })), /format/);
  const noData = wav({ channels: 1, rate: 16_000, bits: 16, data: Buffer.alloc(0) }).subarray(0, 12 + 8 + 16);
  assert.throws(() => wavSamples(noData), /no sound/);
});

test("sound at the model's own rate is left alone, and other rates land on it", () => {
  const same = Float32Array.of(0.1, 0.2);
  assert.equal(resampled(same, 16_000, 16_000), same);
  assert.deepEqual([...resampled(Float32Array.of(0, 0.75, 0.25, 0.25, 0.5, 0.5), 48_000, 16_000)].map((value) => Math.round(value * 1000) / 1000), [0.333, 0.417]);
  assert.deepEqual([...resampled(Float32Array.of(0, 1), 8_000, 16_000)], [0, 0.5, 1, 1]);
  assert.equal(resampled(new Float32Array(44_100), 44_100, 16_000).length, 16_000);
});

test("the vocabulary maps ids to pieces, and pieces join into words at their boundaries", () => {
  const vocabulary = parakeetVocabulary("<unk> 0\n\u2581hel 1\nlo 2\n\u2581world 3\n, 4\n\u2581 5\n<blk> 6\n");
  assert.equal(vocabulary.length, 7);
  assert.equal(vocabulary.indexOf("<blk>"), 6);
  assert.equal(parakeetText([1, 2, 4, 3].map((id) => vocabulary[id]!)), "hello, world");
  assert.equal(parakeetText([5, 5].map((id) => vocabulary[id]!)), "");
});
