/** What a thread's own report, decision or memory change came to: recorded, naming the note it saved, or why nothing was. */
export type CoordinationAnswer = { recorded: true; noteId?: string } | { recorded: false; reason: string };

/** `answer` is the reducer's word back to a thread's own coordination request; a refusal there is no failure of the input. */
export type WorkspaceCommandResult = { ok: true; taskId?: string; answer?: CoordinationAnswer } | { ok: false; message: string };
