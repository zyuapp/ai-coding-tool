import type { PendingQuestion, QuestionAddress } from "../../domain/agent-question";
import { QuestionPrompt } from "../../renderer/components/QuestionPrompt";
import { useQuestionAnswer } from "../client/useQuestionAnswer";
import { LuArrowUp as ArrowUp } from "react-icons/lu";
import { useLayoutEffect, useRef, useState } from "react";
import type { MobileThreadSettings } from "../../contracts/mobile";
import { engineLabel } from "../../domain/agent-engine";
import { settingsSummary } from "../format";

const MAX_ROWS_PX = 168;

/**
 * The composer sits above the keyboard and never scrolls with the transcript. Enter inserts a
 * newline the way every other phone keyboard does; sending is the button, which is where a thumb
 * already is.
 */
export function Composer({ running, waiting, settings, question, onAnswerQuestion, onSend, onSteer, onStop, onOpenSettings, children }: {
  running: boolean;
  question?: PendingQuestion | null;
  onAnswerQuestion?: (question: QuestionAddress, text: string) => void;
  /** Commands the phone is holding until the line comes back. */
  waiting: number;
  settings: MobileThreadSettings;
  /** While a run is going this queues the message behind it. */
  onSend: (text: string) => void;
  /** Pushes the message into the run that is going, which only a thread that exists can have. */
  onSteer?: (text: string) => void;
  /** Only a thread that exists can be running, so a thread yet to be started passes nothing. */
  onStop?: () => void;
  onOpenSettings: () => void;
  /** What sits above the card: how a draft starts, or nothing. */
  children?: React.ReactNode;
}) {
  const answer = useQuestionAnswer(question, onAnswerQuestion);
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const { mode, model, effort } = settingsSummary(settings);

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_ROWS_PX)}px`;
  }, [draft]);

  const typed = draft.trim().length > 0;

  function send(how: (text: string) => void) {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    how(text);
  }

  return (
    <div className="composer">
      {waiting > 0 && <p className="composer-waiting">{waiting} {waiting === 1 ? "message is" : "messages are"} waiting for the line to come back.</p>}
      {question && <QuestionPrompt question={question} answer={answer.answer} disabled={answer.submitting} submitOnEnter={false} onAnswerChange={answer.change} onSubmit={answer.submit} />}
      {children}
      <div className="composer-card">
        <textarea
          ref={field}
          rows={1}
          value={draft}
          placeholder={`Ask ${engineLabel(settings.engine)} to work on anything`}
          aria-label="Message"
          enterKeyHint="enter"
          autoCapitalize="sentences"
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <div className="composer-bar">
          <button type="button" className="composer-settings" aria-label="Thread settings" onClick={onOpenSettings}>
            <span className="setting-axis">Mode</span><span className="setting-value">{mode}</span>
            <span className="setting-axis">Model</span><span className="setting-value">{model}</span>
            {effort && <><span className="setting-axis">Effort</span><span className="setting-value">{effort}</span></>}
          </button>
          {/** While the run is going a message may join the queue behind it or cut into it; the stop stays where it was. */}
          {running && typed && onSteer && <button type="button" className="steer-button" onClick={() => send(onSteer)}>Steer</button>}
          {running && typed && <button type="button" className="send-button queue" onClick={() => send(onSend)} aria-label="Queue message"><ArrowUp size={18} strokeWidth={2.4} /></button>}
          {running
            ? <button type="button" className="send-button running" onClick={onStop} aria-label="Stop this run"><span className="stop-glyph" /></button>
            : <button type="button" className="send-button" onClick={() => send(onSend)} disabled={!typed} aria-label="Send"><ArrowUp size={18} strokeWidth={2.4} /></button>}
        </div>
      </div>
    </div>
  );
}
