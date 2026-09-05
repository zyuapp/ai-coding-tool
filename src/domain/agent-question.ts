/** A question the agent can leave open while continuing its work. */
export type AgentQuestion = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
};

export type QuestionRequest = {
  questions: AgentQuestion[];
  blocking: boolean;
};

export type QuestionAddress = {
  runId: string;
  requestId: string;
  questionId: string;
};

export type PendingQuestion = AgentQuestion & QuestionAddress & {
  blocking: boolean;
  submitting?: boolean;
};

export type QuestionAnswers = Record<string, string>;

export function isQuestionRequest(value: unknown): value is QuestionRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (typeof request.blocking !== "boolean" || !Array.isArray(request.questions) || request.questions.length === 0 || request.questions.length > 100) return false;
  const ids = new Set<string>();
  return request.questions.every((value: unknown) => {
    if (!value || typeof value !== "object") return false;
    const question = value as Record<string, unknown>;
    if (typeof question.id !== "string" || !question.id || ids.has(question.id)) return false;
    ids.add(question.id);
    return typeof question.header === "string" && typeof question.question === "string"
      && Array.isArray(question.options) && question.options.every((value: unknown) => {
        if (!value || typeof value !== "object") return false;
        const option = value as Record<string, unknown>;
        return typeof option.label === "string" && typeof option.description === "string";
      });
  });
}
