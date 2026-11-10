import type { DictationModelStatus } from "./ipc.js";

export type DictationPort = {
  runtime: {
    /** Where the speech model stands, told at once and again whenever it moves. */
    onDictationModel(listener: (status: DictationModelStatus) => void): () => void;
    /** Starts the microphone for the hold `id`, resolving once it hears. */
    startDictation(id: string): Promise<void>;
    /** Stops the hold's microphone and answers with the words it heard. */
    stopDictation(id: string): Promise<string>;
    cancelDictation(id: string): Promise<void>;
    downloadDictationModel(): Promise<void>;
    /** Stops the download and removes the part of the model it fetched. */
    cancelDictationDownload(): Promise<void>;
    /** Turns a phone's recording, base64 WAV, into words. */
    transcribeAudio(audio: string): Promise<string>;
  };
  windowOwn: {
    /** How loud the hold's microphone is, from 0 to 1, many times a second. Never becomes state. */
    onDictationLevel(listener: (level: number) => void): () => void;
  };
};
