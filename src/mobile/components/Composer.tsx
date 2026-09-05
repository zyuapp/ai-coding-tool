import type { PendingQuestion } from "../../domain/agent-question";
import { QuestionPrompt } from "../../renderer/components/QuestionPrompt";
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
export function Composer({ running, waiting, settings, question, replyingToQuestion = true, onQuestionReplyMode, onSend, onStop, onOpenSettings }: {
  running: boolean;
  question?: PendingQuestion | null;
  replyingToQuestion?: boolean;
  onQuestionReplyMode?: (replying: boolean) => void;
  /** Commands the phone is holding until the line comes back. */
  waiting: number;
  settings: MobileThreadSettings;
  onSend: (text: string) => void;
  /** Only a thread that exists can be running, so a thread yet to be started passes nothing. */
  onStop?: () => void;
  onOpenSettings: () => void;
}) {
  const answering = Boolean(question && replyingToQuestion);
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const { mode, model, effort } = settingsSummary(settings);

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_ROWS_PX)}px`;
  }, [draft]);

  function send() {
    const text = draft.trim();
    if (!text || (answering && question?.submitting)) return;
    setDraft("");
    onSend(text);
  }

  return (
    <div className="composer">
      {waiting > 0 && <p className="composer-waiting">{waiting} {waiting === 1 ? "message is" : "messages are"} waiting for the line to come back.</p>}
      {question && onQuestionReplyMode && <QuestionPrompt question={question} replying={replyingToQuestion} onReplyMode={onQuestionReplyMode} />}
      <div className="composer-card">
        <textarea
          ref={field}
          rows={1}
          value={draft}
          placeholder={answering ? "Type your answer…" : `Ask ${engineLabel(settings.engine)} to work on anything`}
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
          {question && <button type="button" className="send-button" onClick={send} disabled={!draft.trim() || (answering && question.submitting)} aria-label={answering ? "Send answer" : "Send message"}><ArrowUp size={18} /></button>}
          {running
            ? <button type="button" className="send-button running" onClick={onStop} aria-label="Stop this run"><span className="stop-glyph" /></button>
            : <button type="button" className="send-button" onClick={send} disabled={!draft.trim()} aria-label="Send"><ArrowUp size={18} strokeWidth={2.4} /></button>}
        </div>
      </div>
    </div>
  );
}
