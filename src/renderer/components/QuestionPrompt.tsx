import { useId } from "react";
import type { PendingQuestion } from "../../domain/agent-question";
import "./question-prompt.css";

export function QuestionPrompt({ question, replying, answer, disabled = false, onAnswerChange, onReplyMode }: {
  question: PendingQuestion;
  replying: boolean;
  answer: string;
  disabled?: boolean;
  onAnswerChange: (answer: string) => void;
  onReplyMode: (replying: boolean) => void;
}) {
  const id = useId();
  return (
    <section className="question-prompt" aria-label="Pending question" aria-live="polite">
      <div className="question-prompt-heading">
        <strong>{question.header || "Question"}</strong>
        <span>{question.blocking ? "Waiting for your answer" : "Working while you answer"}</span>
      </div>
      <p id={id}>{question.question}</p>
      {question.options.length > 0 && <div className="question-options" role="radiogroup" aria-labelledby={id}>
        {question.options.map((option, index) => <label className="question-option" key={index}>
          <input type="radio" name={id} value={option.label} checked={answer === option.label} disabled={disabled || !replying || question.submitting} onChange={() => onAnswerChange(option.label)} />
          <span><strong>{option.label}</strong>{option.description && <span className="question-option-description">{option.description}</span>}</span>
        </label>)}
      </div>}
      <button type="button" onClick={() => onReplyMode(!replying)}>
        {replying ? "Send a message instead" : "Reply to question"}
      </button>
    </section>
  );
}
