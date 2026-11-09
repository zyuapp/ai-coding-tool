/**
 * Parakeet on a thread of its own. ONNX Runtime loads a model without yielding, which would hold up the
 * Linux dictation helper's microphone and levels for seconds on the first hold.
 *
 * In:  workerData {folder, threads}; messages {id, samples}
 * Out: messages {id, text} or {id, error}
 */
import { parentPort, workerData } from "node:worker_threads";
import { loadParakeet } from "./parakeet-onnx.js";

const { folder, threads } = workerData as { folder: string; threads: number };
const model = loadParakeet(folder, threads);
model.catch(() => undefined);

parentPort!.on("message", async ({ id, samples }: { id: number; samples: Float32Array }) => {
  try {
    parentPort!.postMessage({ id, text: await (await model).transcribe(samples) });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    /** A model that failed once stays failed here, so the next hold starts a fresh thread. */
    process.exit(1);
  }
});
