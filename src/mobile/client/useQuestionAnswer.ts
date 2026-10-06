import { useState } from "react";
import type { PendingQuestion, QuestionAddress } from "../../domain/agent-question";

/**
 * Like the phone's chat draft, typing stays local until the user sends it. `refused` names the last
 * answer the computer turned down, which lets go of the answer so it can be sent again.
 */
export function useQuestionAnswer(question: PendingQuestion | null | undefined, send?: (question: QuestionAddress, text: string) => void, refused: string | null = null) {
  const key = question ? JSON.stringify([question.runId, question.requestId, question.questionId]) : "";
  const [draft, setDraft] = useState({ key: "", text: "", submitting: false });
  const [released, setReleased] = useState<string | null>(null);
  if (refused !== null && refused !== released) {
    setReleased(refused);
    if (draft.submitting) setDraft({ ...draft, submitting: false });
  }
  const answer = draft.key === key ? draft.text : question?.answer ?? "";
  const submitting = Boolean(question?.submitting || (draft.key === key && draft.submitting));
  return {
    answer,
    submitting,
    change: (text: string) => setDraft({ key, text, submitting: false }),
    submit: () => {
      if (!question || !send || submitting || !answer.trim()) return;
      setDraft({ key, text: answer, submitting: true });
      send(question, answer.trim());
    },
  };
}
