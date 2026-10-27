export type ApprovalCardProps = {
  approval: {
    approvalId: string;
    taskId: string;
    runId: string;
    title: string;
    description: string;
    toolName: string;
    input: Record<string, unknown>;
  };
  onDecide: (approval: Pick<ApprovalCardProps["approval"], "taskId" | "runId" | "approvalId">, allow: boolean) => void;
};

export function ApprovalCard({ approval, onDecide }: ApprovalCardProps) {
  return (
    <section className="approval-card" aria-live="assertive">
      <div className="approval-icon" aria-hidden="true">!</div>
      <div>
        <strong>{approval.title}</strong>
        <p>{approval.description}</p>
        <details>
          <summary>{approval.toolName}</summary>
          <pre>{JSON.stringify(approval.input, null, 2)}</pre>
        </details>
        <div className="approval-actions">
          <button type="button" className="secondary" onClick={() => onDecide(approval, false)}>Deny</button>
          <button type="button" onClick={() => onDecide(approval, true)}>Allow once</button>
        </div>
      </div>
    </section>
  );
}
