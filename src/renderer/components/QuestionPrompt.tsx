import { useId, useState } from "react";
import type { PendingQuestion } from "../../domain/agent-question";
import { displayShortcut } from "../../domain/shortcuts";
import { MAC } from "../platform";
import "./question-prompt.css";

export function QuestionPrompt({ question, answer, disabled = false, submitOnEnter = true, onAnswerChange, onSubmit }: {
  question: PendingQuestion;
  answer: string;
  disabled?: boolean;
  submitOnEnter?: boolean;
  onAnswerChange: (answer: string) => void;
  onSubmit: () => void;
}) {
  const id = useId();
  const unavailable = disabled || question.submitting;
  /** Whether the answer was typed rather than picked, so a typed answer that matches an option's label stays typed. */
  const [typed, setTyped] = useState(false);
  const [asked, setAsked] = useState(question.id);
  if (asked !== question.id) {
    setAsked(question.id);
    setTyped(false);
  }
  const chosen = !typed && question.options.some((option) => option.label === answer);
  return (
    <form className="question-prompt" aria-label="Pending question" onSubmit={(event) => {
      event.preventDefault();
      if (!unavailable && answer.trim()) onSubmit();
    }}>
      <div className="question-prompt-content" aria-live="polite">
        <div className="question-prompt-heading">
          <strong>{question.header || "Question"}</strong>
          <span>{question.blocking ? "Waiting for your answer" : "Working while you answer"}</span>
        </div>
        <p id={id}>{question.question}</p>
        {question.options.length > 0 && <div className="question-options" role="radiogroup" aria-labelledby={id}>
          {question.options.map((option, index) => <label className="question-option" key={index}>
            <input type="radio" name={id} value={option.label} checked={chosen && answer === option.label} disabled={unavailable} onChange={() => { setTyped(false); onAnswerChange(option.label); }} onKeyDown={(event) => {
              if (submitOnEnter && event.key === "Enter" && event.currentTarget.checked) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }} />
            <span><strong>{option.label}</strong>{option.description && <span className="question-option-description">{option.description}</span>}</span>
          </label>)}
        </div>}
      </div>
      <div className="question-answer">
        <label htmlFor={`${id}-answer`}>Your answer</label>
        <textarea
          id={`${id}-answer`}
          value={chosen ? "" : answer}
          rows={2}
          placeholder={question.options.length ? "Or type your answer…" : "Type your answer…"}
          aria-describedby={id}
          disabled={unavailable}
          onInput={(event) => { setTyped(true); onAnswerChange(event.currentTarget.value); }}
          onKeyDown={(event) => {
            if (submitOnEnter && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" disabled={unavailable || !answer.trim()}>
          {question.submitting ? "Sending…" : "Send answer"}
          {submitOnEnter && !question.submitting && <kbd aria-hidden="true">{displayShortcut("Enter", MAC)}</kbd>}
        </button>
      </div>
    </form>
  );
}
