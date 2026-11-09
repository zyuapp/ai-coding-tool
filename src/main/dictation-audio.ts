/** Sound as numbers: what the Linux dictation helper records, reads from a phone's WAV, and shows as a level. */

/** Signed 16-bit little-endian samples as floats from -1 to 1. A trailing odd byte is dropped. */
export function pcm16Samples(bytes: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(bytes.length / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2) / 32_768;
  return samples;
}

/** How loud a stretch of samples is, from 0 to 1 in two-decimal steps: -55 dB reads as silence and -5 dB as full. */
export function audioLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) + 55) / 50));
  return Math.round(level * 100) / 100;
}

/**
 * Sound at another rate. Going down, each new sample averages the old ones it spans, which keeps most
 * of what would fold back into the voice; going up, it reads between its two neighbours.
 */
export function resampled(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const ratio = from / to;
  const output = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const start = index * ratio;
    if (ratio > 1) {
      const first = Math.floor(start);
      const last = Math.min(samples.length, Math.max(first + 1, Math.floor(start + ratio)));
      let sum = 0;
      for (let at = first; at < last; at += 1) sum += samples[at]!;
      output[index] = sum / (last - first);
    } else {
      const before = Math.min(samples.length - 1, Math.floor(start));
      const after = Math.min(samples.length - 1, before + 1);
      const weight = start - before;
      output[index] = samples[before]! * (1 - weight) + samples[after]! * weight;
    }
  }
  return output;
}

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

/** A WAV file's sound, mixed to mono at its own rate. Reads 16-bit PCM and 32-bit float; anything else is refused. */
export function wavSamples(bytes: Buffer): { samples: Float32Array; sampleRate: number } {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file.");
  let format: { encoding: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    if (id === "fmt " && body.length >= 16) {
      const tag = body.readUInt16LE(0);
      format = { encoding: tag === EXTENSIBLE && body.length >= 26 ? body.readUInt16LE(24) : tag, channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === "data") data = body;
    at += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error("The WAV file has no sound.");
  const { encoding, channels, sampleRate, bits } = format;
  const pcm = encoding === PCM && bits === 16;
  if (!(pcm || (encoding === FLOAT && bits === 32)) || channels < 1 || sampleRate < 1) throw new Error("The WAV file's format can't be read.");
  const width = bits / 8;
  const frames = Math.floor(data.length / (width * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const at = (frame * channels + channel) * width;
      sum += pcm ? data.readInt16LE(at) / 32_768 : data.readFloatLE(at);
    }
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate };
}
