/** Where each computer keeps the speech model its dictation helper reads, and which files make it whole. */
import os from "node:os";
import path from "node:path";
import { PARAKEET_FILES } from "./parakeet-onnx.js";

export type DictationModelPlace = {
  /** The folder the helper reads unless it is handed another. */
  folder: string;
  /** What must be in the folder for the model to load. */
  files: readonly string[];
};

/** Parakeet v2 for Core ML, in the folder FluidAudio shares between apps. */
const MAC: DictationModelPlace = {
  folder: path.join(os.homedir(), "Library", "Application Support", "FluidAudio", "Models", "parakeet-tdt-0.6b-v2-coreml"),
  files: ["Preprocessor.mlmodelc", "Encoder.mlmodelc", "Decoder.mlmodelc", "JointDecision.mlmodelc", "parakeet_vocab.json"],
};

/** Parakeet v2 for ONNX Runtime, its encoder and decoder quantized to int8, in the user's data folder. */
export const LINUX_MODEL_FILES: readonly string[] = Object.values(PARAKEET_FILES);

function linuxDataHome() {
  const named = process.env.XDG_DATA_HOME;
  return named && path.isAbsolute(named) ? named : path.join(os.homedir(), ".local", "share");
}

/** Where this computer's model goes, or null where no helper runs. */
export function dictationModelPlace(platform: NodeJS.Platform = process.platform, arch: string = process.arch): DictationModelPlace | null {
  if (platform === "darwin" && arch === "arm64") return MAC;
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return { folder: path.join(linuxDataHome(), "aicodingtool", "models", "parakeet-tdt-0.6b-v2-int8"), files: LINUX_MODEL_FILES };
  }
  return null;
}
