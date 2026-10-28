import type { PendingQuestion, QuestionAddress } from "../../domain/agent-question";
import { QuestionPrompt } from "../../renderer/components/QuestionPrompt";
import { useQuestionAnswer } from "../client/useQuestionAnswer";
import { LuArrowUp as ArrowUp, LuChevronDown as ChevronDown, LuCloudOff as CloudOff, LuCornerDownRight as CornerDownRight, LuZap as Zap } from "react-icons/lu";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MobileThreadSettings } from "../../contracts/mobile";
import { engineLabel } from "../../domain/agent-engine";
import { settingsSummary } from "../format";

const MAX_ROWS_PX = 168;

/** Unsent words by thread, kept for as long as the page is open. */
const drafts = new Map<string, string>();

/** The composer on screen, which words handed back from the transcript go to. */
let handBack: ((text: string) => void) | null = null;

/** Puts a message's words back in the composer on screen, after anything already typed there. */
export function returnToComposer(text: string) {
  handBack?.(text);
}

function keep(key: string | undefined, text: string) {
  if (!key) return;
  if (text) drafts.set(key, text);
  else drafts.delete(key);
}

/**
 * The composer sits above the keyboard and never scrolls with the transcript. Enter inserts a
 * newline the way every other phone keyboard does; sending is the button, which is where a thumb
 * already is, or Cmd/Ctrl+Enter on a hardware keyboard.
 */
/** A command of this thread's the computer turned down: a message's words, or the question it answered. */
export type ReturnedToComposer = { id: string; text?: string; answer?: string };

export function Composer({ draftKey, running, waiting, returned, settings, question, onAnswerQuestion, onSend, onSteer, onStop, onOpenSettings, onEditWaiting, children }: {
  /** The thread the words belong to, so leaving it and coming back finds them where they were. */
  draftKey?: string;
  running: boolean;
  /** What the computer last turned down here. A message's words come back to an empty field. */
  returned?: ReturnedToComposer | null;
  question?: PendingQuestion | null;
  onAnswerQuestion?: (question: QuestionAddress, text: string) => void;
  /** Commands the phone is holding until the line comes back. */
  waiting: number;
  /** Takes the held messages back out of the outbox and into the field. */
  onEditWaiting?: () => void;
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
  const answer = useQuestionAnswer(question, onAnswerQuestion, returned?.answer ? returned.id : null);
  const [draft, setDraftState] = useState(() => (draftKey && drafts.get(draftKey)) || "");
  const [keyed, setKeyed] = useState(draftKey);
  if (keyed !== draftKey) {
    setKeyed(draftKey);
    setDraftState((draftKey && drafts.get(draftKey)) || "");
  }
  function setDraft(text: string) {
    setDraftState(text);
    keep(draftKey, text);
  }
  const [given, setGiven] = useState<string | null>(null);
  if (returned?.text && returned.id !== given) {
    setGiven(returned.id);
    if (!draft.trim()) setDraft(returned.text);
  }
  const field = useRef<HTMLTextAreaElement>(null);
  const { mode, model, effort } = settingsSummary(settings);

  useEffect(() => {
    const take = (text: string) => setDraftState((current) => {
      const next = current.trim() ? `${current.trimEnd()}\n\n${text}` : text;
      keep(draftKey, next);
      return next;
    });
    handBack = take;
    return () => {
      if (handBack === take) handBack = null;
    };
  }, [draftKey]);

  /** A question the run is stopped on takes the composer's place: one field, one send. */
  const blocked = question?.blocking === true;

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_ROWS_PX)}px`;
  }, [draft, blocked]);

  const typed = !blocked && draft.trim().length > 0;
  /** With words typed during a run, the right-most disc queues them, so a thumb on its usual spot never stops the run. */
  const queueing = running && typed;

  function send(how: (text: string) => void) {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    how(text);
  }

  const stop = <button type="button" className={queueing ? "send-button stop-aside" : "send-button running"} onClick={onStop} aria-label="Stop this run"><span className="stop-glyph" /></button>;

  return (
    <div className="composer">
      {waiting > 0 && (
        <div className="composer-waiting" role="status">
          <CloudOff size={14} strokeWidth={2} aria-hidden="true" />
          <span>{waiting} {waiting === 1 ? "message is" : "messages are"} waiting for the line to come back.</span>
          {onEditWaiting && <button type="button" className="composer-waiting-edit" onClick={onEditWaiting}>Edit</button>}
        </div>
      )}
      {question && <QuestionPrompt question={question} answer={answer.answer} disabled={answer.submitting} submitOnEnter={false} onAnswerChange={answer.change} onSubmit={answer.submit} />}
      {children}
      <div className="composer-card" data-blocked={blocked || undefined}>
        {!blocked && <textarea
          ref={field}
          rows={1}
          value={draft}
          placeholder={`Ask ${engineLabel(settings.engine)} to work on anything`}
          aria-label="Message"
          enterKeyHint="enter"
          autoCapitalize="sentences"
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send(onSend);
          }}
        />}
        <div className="composer-bar">
          <button type="button" className="composer-settings" aria-label={`Thread settings: ${[mode, model, effort].filter(Boolean).join(", ")}`} aria-haspopup="dialog" onClick={onOpenSettings}>
            <span className="composer-settings-values">
              <span className="setting-axis">Mode</span><span className="setting-value">{mode}</span>
              <span className="setting-axis">Model</span><span className="setting-value">{model}</span>
              {effort && <><span className="setting-axis">Effort</span><span className="setting-value">{effort}</span></>}
            </span>
            <ChevronDown className="composer-settings-chevron" size={14} strokeWidth={2} aria-hidden="true" />
          </button>
          {queueing && onStop && stop}
          {queueing && onSteer && <button type="button" className="composer-pill" aria-description="Sends it into the running turn" onClick={() => send(onSteer)}><Zap size={14} strokeWidth={2.2} aria-hidden="true" />Steer now</button>}
          {queueing
            ? <button type="button" className="composer-pill primary" aria-description="Sends it when this run ends" onClick={() => send(onSend)}><CornerDownRight size={14} strokeWidth={2.2} aria-hidden="true" />Queue</button>
            : running
              ? stop
              : !blocked && <button type="button" className="send-button" onClick={() => send(onSend)} disabled={!typed} aria-label="Send"><ArrowUp size={18} strokeWidth={2.4} /></button>}
        </div>
      </div>
    </div>
  );
}
