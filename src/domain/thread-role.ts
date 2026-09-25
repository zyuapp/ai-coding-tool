/** The part a thread plays among the others the user runs side by side. Chosen by the user; nothing infers it. */
export const THREAD_ROLES = [
  { role: "coordinator", label: "Coordinator" },
  { role: "implementer", label: "Implementer" },
  { role: "reviewer", label: "Reviewer" },
  { role: "researcher", label: "Researcher" },
] as const;

export type ThreadRole = typeof THREAD_ROLES[number]["role"];

export function isThreadRole(value: unknown): value is ThreadRole {
  return THREAD_ROLES.some((option) => option.role === value);
}

export function threadRoleLabel(role: ThreadRole): string {
  return THREAD_ROLES.find((option) => option.role === role)!.label;
}
