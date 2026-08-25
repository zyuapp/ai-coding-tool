import { ArrowUp, Square, SlidersHorizontal } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

const MAX_ROWS_PX = 168;

/**
 * The composer sits above the keyboard and never scrolls with the transcript. Enter inserts a
 * newline the way every other phone keyboard does; sending is the button, which is where a thumb
 * already is.
 */
export function Composer({ running, waiting, settingsLabel, onSend, onStop, onOpenSettings }: {
  running: boolean;
  /** Commands the phone is holding until the line comes back. */
  waiting: number;
  settingsLabel: string;
  onSend: (text: string) => void;
  /** Only a thread that exists can be running, so a thread yet to be started passes nothing. */
  onStop?: () => void;
  onOpenSettings: () => void;
}) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_ROWS_PX)}px`;
  }, [draft]);

  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onSend(text);
  }

  return (
    <div className="composer">
      {waiting > 0 && <p className="composer-waiting">{waiting} {waiting === 1 ? "message is" : "messages are"} waiting for the line to come back.</p>}
      <div className="composer-field">
        <textarea
          ref={field}
          rows={1}
          value={draft}
          placeholder="Message"
          enterKeyHint="enter"
          autoCapitalize="sentences"
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        {running
          ? <button type="button" className="round stop" onClick={onStop} aria-label="Stop this run"><Square size={16} strokeWidth={2.4} /></button>
          : <button type="button" className="round send" onClick={send} disabled={!draft.trim()} aria-label="Send"><ArrowUp size={20} strokeWidth={2.4} /></button>}
      </div>
      <button type="button" className="composer-settings" onClick={onOpenSettings}>
        <SlidersHorizontal size={14} strokeWidth={1.9} />
        <span>{settingsLabel}</span>
      </button>
    </div>
  );
}
