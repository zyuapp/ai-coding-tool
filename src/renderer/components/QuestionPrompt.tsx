import type { PendingQuestion } from "../../domain/agent-question";
import "./question-prompt.css";

export function QuestionPrompt({ question, replying, onReplyMode }: {
  question: PendingQuestion;
  replying: boolean;
  onReplyMode: (replying: boolean) => void;
}) {
  return (
    <section className="question-prompt" aria-label="Pending question" aria-live="polite">
      <div className="question-prompt-heading">
        <strong>{question.header || "Question"}</strong>
        <span>{question.blocking ? "Waiting for your answer" : "Working while you answer"}</span>
      </div>
      <p>{question.question}</p>
      {question.options.length > 0 && <ul>{question.options.map((option, index) => <li key={index}><strong>{option.label}</strong>{option.description && ` — ${option.description}`}</li>)}</ul>}
      <button type="button" onClick={() => onReplyMode(!replying)}>
        {replying ? "Send a message instead" : "Reply to question"}
      </button>
    </section>
  );
}
