import { useEffect, useState, type RefObject } from "react";
import type { SimulatorFrame } from "../../domain/simulator";

/** "avc1.PPCCLL" from an avcC record: its profile, profile compatibility and level bytes. */
function codecOf(avcC: Uint8Array) {
  return `avc1.${[avcC[1], avcC[2], avcC[3]].map((byte) => (byte ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Paints a device's screen into the canvas while `udid` is set: main streams it as H.264 for as long
 * as this watches, and the GPU decodes it. Answers with the screen's size in pixels once it is known,
 * or why the stream could not start, with a way to try again.
 */
export function useSimulatorStream(canvas: RefObject<HTMLCanvasElement | null>, udid: string | null) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setSize(null);
    setError(null);
    const target = canvas.current;
    if (!udid || !target) return;
    const context = target.getContext("2d", { alpha: false, desynchronized: true });
    let decoder: VideoDecoder | null = null;
    let config = "";
    /** After a configure or an error the decoder can only start again from a keyframe. */
    let needsKey = true;
    let stopped = false;

    const reset = () => {
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
      config = "";
      needsKey = true;
    };

    const configure = (frame: Extract<SimulatorFrame, { kind: "config" }>) => {
      const signature = `${frame.width}x${frame.height}:${frame.data.join(",")}`;
      if (signature === config && decoder?.state === "configured") return;
      reset();
      decoder = new VideoDecoder({
        output: (picture) => {
          if (!stopped && context) {
            if (target.width !== picture.displayWidth || target.height !== picture.displayHeight) {
              target.width = picture.displayWidth;
              target.height = picture.displayHeight;
            }
            context.drawImage(picture, 0, 0);
          }
          picture.close();
        },
        error: () => reset(),
      });
      decoder.configure({ codec: codecOf(frame.data), description: frame.data, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
      config = signature;
      setSize((current) => current?.width === frame.width && current.height === frame.height ? current : { width: frame.width, height: frame.height });
    };

    const stop = window.desktop.onSimulatorFrame((frame) => {
      if (frame.udid !== udid || stopped) return;
      if (frame.kind === "config") return configure(frame);
      if (!decoder || decoder.state !== "configured") return;
      /** A decoder that falls behind skips to the next keyframe rather than queueing a backlog. */
      if (!frame.key && (needsKey || decoder.decodeQueueSize > 8)) {
        needsKey = true;
        return;
      }
      needsKey = false;
      decoder.decode(new EncodedVideoChunk({ type: frame.key ? "key" : "delta", timestamp: frame.timestamp, data: frame.data }));
    });
    window.desktop.watchSimulator(udid).catch((failure: unknown) => {
      if (!stopped) setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(failure));
    });

    return () => {
      stopped = true;
      stop();
      reset();
      void window.desktop.unwatchSimulator(udid).catch(() => undefined);
    };
  }, [canvas, udid, attempt]);

  return { size, error, retry: () => setAttempt((count) => count + 1) };
}
