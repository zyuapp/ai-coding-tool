import { useEffect, useMemo, useRef, type HTMLAttributes, type KeyboardEvent, type RefObject } from "react";
import { hidUsage, MAX_PASTE_TEXT, turned, untilted, type SimulatorInput, type SimulatorOrientation } from "../../domain/simulator";
import { WheelPinch, type PinchFingers } from "./wheel-pinch";
import { WheelSwipe } from "./wheel-swipe";

/** ⌘ shortcuts the device takes while its screen has focus, beside ⌘C, ⌘X and ⌘V, which arrive as clipboard events. */
const DEVICE_SHORTCUTS = new Set(["KeyA", "KeyZ", "ArrowUp", "ArrowDown", "Backspace"]);
const KEY_C = 6;
/** The HID usage of the first modifier key; every key after it is a modifier too. */
const FIRST_MODIFIER = 224;
const KEY_X = 27;

/** How a drag with ⌥ held places its second finger: mirrored through the screen's middle, or, with ⇧ too, moving alongside the first. */
type TwoFingers = { mirror: true } | { mirror: false; dx: number; dy: number };

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const mirrored = (x: number, y: number) => ({ x2: 1 - x, y2: 1 - y });

/** Where a pointer is on the screen as it is shown, as fractions of it from its top left. */
function shownAt(element: HTMLElement, clientX: number, clientY: number) {
  const box = element.getBoundingClientRect();
  return { x: clamp((clientX - box.left) / box.width), y: clamp((clientY - box.top) / box.height) };
}

/** Marks where a pinch's two fingers are, as fractions of the screen as it is shown, or hides them. */
function showFingers(marks: HTMLDivElement | null, fingers: PinchFingers | null) {
  if (!marks) return;
  marks.hidden = !fingers;
  if (!fingers) return;
  const [first, second] = marks.children as unknown as [HTMLElement, HTMLElement];
  first.style.left = `${fingers.x * 100}%`;
  first.style.top = `${fingers.y * 100}%`;
  second.style.left = `${fingers.x2 * 100}%`;
  second.style.top = `${fingers.y2 * 100}%`;
}

type SendInput = (udid: string, input: SimulatorInput) => void;

/** Touches on one device held one way: each lands on the device's own portrait screen, wherever the turned picture puts it. */
function touchOn(device: string | null, orientation: SimulatorOrientation, onInput: RefObject<SendInput>) {
  return (phase: "down" | "move" | "up", shownX: number, shownY: number, second?: { x2: number; y2: number }) => {
    if (!device) return;
    const other = second && untilted(second.x2, second.y2, orientation);
    onInput.current(device, { kind: "touch", phase, ...untilted(shownX, shownY, orientation), ...(other ? { x2: other.x, y2: other.y } : {}) });
  };
}

/**
 * What the pointer, trackpad, keyboard and clipboard do to a device's screen as it is shown. A finger
 * the trackpad left down lifts on the device it landed on once the device or the way it is held changes.
 */
export function useScreenInput(device: string | null, orientation: SimulatorOrientation, onInput: SendInput) {
  const pressed = useRef<Set<number>>(new Set());
  const fingerMarks = useRef<HTMLDivElement>(null);
  const twoFingers = useRef<TwoFingers | null>(null);
  const latestInput = useRef(onInput);
  latestInput.current = onInput;
  const send = (input: SimulatorInput) => { if (device) onInput(device, input); };
  const touch = touchOn(device, orientation, latestInput);
  const gestures = useMemo(() => {
    const touchHere = touchOn(device, orientation, latestInput);
    return {
      wheel: new WheelSwipe((phase, x, y) => touchHere(phase, x, y)),
      pinch: new WheelPinch((phase, { x, y, x2, y2 }) => {
        touchHere(phase, x, y, { x2, y2 });
        showFingers(fingerMarks.current, phase === "up" ? null : { x, y, x2, y2 });
      }),
    };
  }, [device, orientation]);
  const { wheel, pinch } = gestures;
  useEffect(() => () => { gestures.wheel.lift(); gestures.pinch.lift(); }, [gestures]);

  const secondFinger = (x: number, y: number) => {
    const mode = twoFingers.current;
    if (!mode) return undefined;
    return mode.mirror ? mirrored(x, y) : { x2: clamp(x + mode.dx), y2: clamp(y + mode.dy) };
  };
  const release = () => {
    for (const usage of pressed.current) send({ kind: "key", usage, down: false });
    pressed.current.clear();
  };

  const onKey = (event: KeyboardEvent<HTMLElement>, down: boolean) => {
    /** Simulator.app's own keys for the hardware: ⌘⇧H goes home, ⌘← and ⌘→ turn the device. */
    const hardware: SimulatorInput | null = !down || !event.metaKey ? null
      : event.shiftKey && event.code === "KeyH" ? { kind: "button", button: "home" }
      : !event.shiftKey && event.code === "ArrowLeft" ? { kind: "rotate", orientation: turned(orientation, -1) }
      : !event.shiftKey && event.code === "ArrowRight" ? { kind: "rotate", orientation: turned(orientation, 1) }
      : null;
    if (hardware) {
      event.preventDefault();
      if (!event.repeat) send(hardware);
      return;
    }
    if (event.metaKey && DEVICE_SHORTCUTS.has(event.code)) {
      event.preventDefault();
      if (down && !event.repeat) send({ kind: "shortcut", usage: hidUsage(event.code)! });
      return;
    }
    const usage = hidUsage(event.code);
    /** Every other ⌘ key keeps meaning the app's own shortcuts; ⇧, ⌥ and ⌃ still reach the device, which a shortcut such as ⌘⇧Z needs. */
    if (usage === undefined || (event.metaKey && usage < FIRST_MODIFIER)) return;
    event.preventDefault();
    if (down && (event.repeat || pressed.current.has(usage))) return;
    if (down) pressed.current.add(usage);
    else if (!pressed.current.delete(usage)) return;
    send({ kind: "key", usage, down });
  };

  const handlers: HTMLAttributes<HTMLDivElement> = {
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      wheel.lift();
      pinch.lift();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true, focusVisible: false });
      const at = shownAt(event.currentTarget, event.clientX, event.clientY);
      const landing = mirrored(at.x, at.y);
      twoFingers.current = !event.altKey ? null : event.shiftKey ? { mirror: false, dx: landing.x2 - at.x, dy: landing.y2 - at.y } : { mirror: true };
      const second = secondFinger(at.x, at.y);
      showFingers(fingerMarks.current, second ? { ...at, ...second } : null);
      touch("down", at.x, at.y, second);
    },
    onPointerMove: (event) => {
      const at = shownAt(event.currentTarget, event.clientX, event.clientY);
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        /** Holding ⌥ over the screen shows where a pinch's two fingers would land. */
        showFingers(fingerMarks.current, event.altKey ? { ...at, ...mirrored(at.x, at.y) } : null);
        return;
      }
      const second = secondFinger(at.x, at.y);
      if (second) showFingers(fingerMarks.current, { ...at, ...second });
      touch("move", at.x, at.y, second);
    },
    onPointerUp: (event) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      const at = shownAt(event.currentTarget, event.clientX, event.clientY);
      touch("up", at.x, at.y, secondFinger(at.x, at.y));
      twoFingers.current = null;
      showFingers(fingerMarks.current, event.altKey ? { ...at, ...mirrored(at.x, at.y) } : null);
    },
    onPointerCancel: (event) => {
      const at = shownAt(event.currentTarget, event.clientX, event.clientY);
      touch("up", at.x, at.y, secondFinger(at.x, at.y));
      twoFingers.current = null;
      showFingers(fingerMarks.current, null);
    },
    onPointerLeave: (event) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) showFingers(fingerMarks.current, null);
    },
    onWheel: (event) => {
      const at = shownAt(event.currentTarget, event.clientX, event.clientY);
      /** A trackpad's pinch arrives as a wheel with Control held. */
      if (event.ctrlKey) {
        wheel.lift();
        pinch.pinch(at.x, at.y, event.deltaY);
        return;
      }
      pinch.lift();
      const box = event.currentTarget.getBoundingClientRect();
      wheel.wheel(at.x, at.y, event.deltaX / box.width, event.deltaY / box.height);
    },
    onCopy: (event) => {
      event.preventDefault();
      send({ kind: "shortcut", usage: KEY_C });
    },
    onCut: (event) => {
      event.preventDefault();
      send({ kind: "shortcut", usage: KEY_X });
    },
    onPaste: (event) => {
      const text = event.clipboardData.getData("text/plain").slice(0, MAX_PASTE_TEXT);
      if (!text) return;
      event.preventDefault();
      send({ kind: "paste", text });
    },
    onKeyDown: (event) => onKey(event, true),
    onKeyUp: (event) => onKey(event, false),
    onFocus: () => send({ kind: "pasteboard", phase: "enter" }),
    onBlur: () => {
      release();
      send({ kind: "pasteboard", phase: "leave" });
    },
  };
  return { handlers, fingerMarks };
}
