export type ActiveGoal = {
  objective: string;
  /** A native provider may stop for a reason the user can resolve without discarding the goal. */
  status: "active" | "blocked";
  iterations?: number;
  lastReason?: string;
};

