import type { ProviderRunInput } from "../agent/agent-provider.mjs";
import type { AsyncUserInputQuestion } from "./protocol/v2/AsyncUserInputQuestion.js";
import type { IncomingRequest } from "./app-server-client.mjs";
import type { CodexClient } from "./codex-session.mjs";

/** Pending server requests are withdrawn when Codex resolves them or their owning turn ends. */
export class CodexQuestions {
  readonly pending = new Map<string | number, AbortController>();

  answer(request: Extract<IncomingRequest, { method: "item/tool/requestUserInput" }>, input: ProviderRunInput) {
    const { questions, isBlocking } = request.params;
    const controller = new AbortController();
    this.pending.set(request.id, controller);
    void input.askQuestion({
      blocking: isBlocking,
      questions: questions.map(({ id, header, question, options }) => ({ id, header, question, options: options ?? [] })),
    }, controller.signal).then((answers) => {
      if (controller.signal.aborted) return;
      if (answers === null) request.fail({ code: -32000, message: "The question was closed without an answer." });
      else request.respond({ answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { answers: [answer] }])) });
    }).catch(() => {
      if (!controller.signal.aborted) request.fail({ code: -32000, message: "The question could not be answered." });
    }).finally(() => this.pending.delete(request.id));
  }

  async answerAsync(native: AsyncUserInputQuestion[], input: ProviderRunInput, client: CodexClient, threadId: string, activeTurnId: () => string | undefined) {
    const questions = native.map((question, index) => ({
      id: String(index), header: "Question", question: question.title,
      options: (question.options ?? []).map((label) => ({ label, description: "" })),
    }));
    const answers = await input.askQuestion({ questions, blocking: false });
    const turnId = activeTurnId();
    if (!answers || !turnId) return;
    const text = questions.map((question) => `${question.question}\n${answers[question.id]}`).join("\n\n");
    await client.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] });
  }

  close() {
    for (const question of this.pending.values()) question.abort();
    this.pending.clear();
  }
}
