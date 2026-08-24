import { useEffect, useRef, useState, type DragEvent } from "react";

/** Without this the window would leave the app and show the file a drop outside every surface landed on. */
export function useRefusedStrayDrops() {
  useEffect(() => {
    const refuse = (event: globalThis.DragEvent) => event.preventDefault();
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", refuse);
    return () => {
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", refuse);
    };
  }, []);
}

function carriesFiles(event: DragEvent) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * A surface that takes files dragged in from the desktop. A drag that carries anything else, such as
 * a thread being moved in the sidebar, passes straight through. Nested surfaces take their own drop.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  function settle() {
    depth.current = 0;
    setOver(false);
  }

  return {
    over,
    props: {
      onDragEnter(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current += 1;
        setOver(true);
      },
      onDragOver(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.stopPropagation();
        depth.current -= 1;
        if (depth.current <= 0) settle();
      },
      onDrop(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        settle();
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      },
    },
  };
}
