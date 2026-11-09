/**
 * Parakeet TDT through ONNX Runtime, from the ONNX export onnx-asr reads: a preprocessor turns sound into
 * mel features, the encoder turns those into frames, and a joint decoder walks the frames, choosing a token
 * and how many frames to skip at each step.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type * as Ort from "onnxruntime-node";

export const PARAKEET_SAMPLE_RATE = 16_000;
/** Tokens one frame may emit before the walk moves on regardless. */
const MAX_TOKENS_PER_FRAME = 10;
const BLANK = "<blk>";
/** SentencePiece's word boundary. */
const SPACE = "▁";

export const PARAKEET_FILES = {
  preprocessor: "nemo128.onnx",
  encoder: "encoder-model.int8.onnx",
  decoder: "decoder_joint-model.int8.onnx",
  vocabulary: "vocab.txt",
} as const;

export type Parakeet = { transcribe(samples: Float32Array): Promise<string> };

/** Each line of vocab.txt is a piece and its id. */
export function parakeetVocabulary(text: string): string[] {
  const pieces: string[] = [];
  for (const line of text.split("\n")) {
    const at = line.lastIndexOf(" ");
    if (at <= 0) continue;
    const id = Number(line.slice(at + 1));
    if (Number.isInteger(id) && id >= 0) pieces[id] = line.slice(0, at);
  }
  return pieces;
}

/** Pieces back into words. */
export function parakeetText(pieces: readonly string[]): string {
  return pieces.join("").replaceAll(SPACE, " ").replace(/\s+/g, " ").trim();
}

function argmax(values: Float32Array, from: number, to: number): number {
  let best = from;
  for (let index = from + 1; index < to; index += 1) if (values[index]! > values[best]!) best = index;
  return best;
}

/** The size of a fixed axis the model declares, or the fallback when it doesn't say. */
function declared(session: Ort.InferenceSession, input: string, axis: number, fallback: number): number {
  const meta = session.inputMetadata.find((entry) => entry.name === input);
  const size = meta?.isTensor ? meta.shape[axis] : undefined;
  return typeof size === "number" ? size : fallback;
}

/** Loads the three graphs once; each transcription after that reuses them. */
export async function loadParakeet(folder: string, threads: number): Promise<Parakeet> {
  const ort = createRequire(__filename)("onnxruntime-node") as typeof Ort;
  const options: Ort.InferenceSession.SessionOptions = { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: "all" };
  const file = (name: string) => path.join(folder, name);
  const [preprocessor, encoder, decoder, vocabulary] = await Promise.all([
    ort.InferenceSession.create(file(PARAKEET_FILES.preprocessor), options),
    ort.InferenceSession.create(file(PARAKEET_FILES.encoder), options),
    ort.InferenceSession.create(file(PARAKEET_FILES.decoder), options),
    readFile(file(PARAKEET_FILES.vocabulary), "utf8").then(parakeetVocabulary),
  ]);
  const blank = vocabulary.indexOf(BLANK);
  if (blank < 0) throw new Error("The speech model's vocabulary has no blank.");
  const tokens = vocabulary.length;
  const layers = declared(decoder, "input_states_1", 0, 2);
  const hidden = declared(decoder, "input_states_1", 2, 640);
  const emptyState = () => new ort.Tensor("float32", new Float32Array(layers * hidden), [layers, 1, hidden]);
  const one = new ort.Tensor("int32", Int32Array.of(1), [1]);

  return {
    async transcribe(samples) {
      const features = await preprocessor.run({
        waveforms: new ort.Tensor("float32", samples, [1, samples.length]),
        waveforms_lens: new ort.Tensor("int64", BigInt64Array.of(BigInt(samples.length)), [1]),
      });
      const encoded = await encoder.run({ audio_signal: features.features!, length: features.features_lens! });
      const frames = encoded.outputs!;
      const [, width = 0, stride = 0] = frames.dims;
      const length = Number((encoded.encoded_lengths!.data as BigInt64Array)[0]);
      const data = frames.data as Float32Array;
      const frame = new Float32Array(width);
      let states: [Ort.Tensor, Ort.Tensor] = [emptyState(), emptyState()];
      const said: number[] = [];
      let frameTokens = 0;
      for (let at = 0; at < length;) {
        for (let index = 0; index < width; index += 1) frame[index] = data[index * stride + at]!;
        const step = await decoder.run({
          encoder_outputs: new ort.Tensor("float32", frame, [1, width, 1]),
          targets: new ort.Tensor("int32", Int32Array.of(said.at(-1) ?? blank), [1, 1]),
          target_length: one,
          input_states_1: states[0],
          input_states_2: states[1],
        });
        const logits = step.outputs!.data as Float32Array;
        const token = argmax(logits, 0, tokens);
        const skip = argmax(logits, tokens, logits.length) - tokens;
        if (token !== blank) {
          states = [step.output_states_1!, step.output_states_2!];
          said.push(token);
          frameTokens += 1;
        }
        if (skip > 0) {
          at += skip;
          frameTokens = 0;
        } else if (token === blank || frameTokens === MAX_TOKENS_PER_FRAME) {
          at += 1;
          frameTokens = 0;
        }
      }
      return parakeetText(said.map((id) => vocabulary[id] ?? ""));
    },
  };
}
