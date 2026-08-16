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
  onDecide: (allow: boolean) => void;
};

export function ApprovalCard({ approval, onDecide }: ApprovalCardProps) {
  return (
    <section className="approval-card" aria-live="assertive">
      <div className="approval-icon">!</div>
      <div>
        <strong>{approval.title}</strong>
        <p>{approval.description}</p>
        <details>
          <summary>{approval.toolName}</summary>
          <pre>{JSON.stringify(approval.input, null, 2)}</pre>
        </details>
        <div className="approval-actions">
          <button className="secondary" onClick={() => onDecide(false)}>Deny</button>
          <button onClick={() => onDecide(true)}>Allow once</button>
        </div>
      </div>
    </section>
  );
}
