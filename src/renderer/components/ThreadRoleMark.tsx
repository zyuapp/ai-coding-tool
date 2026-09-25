import type { IconType } from "react-icons";
import { LuFlaskConical as FlaskConical, LuHammer as Hammer, LuSearchCheck as SearchCheck, LuWaypoints as Waypoints } from "react-icons/lu";
import { threadRoleLabel, type ThreadRole } from "../../domain/thread-role";

const ROLE_ICONS: Record<ThreadRole, IconType> = {
  coordinator: Waypoints,
  implementer: Hammer,
  reviewer: SearchCheck,
  researcher: FlaskConical,
};

/** The mark a thread with a role carries in its row's rail, in the role's colour. */
export function ThreadRoleMark({ role, size }: { role: ThreadRole; size: number }) {
  const Icon = ROLE_ICONS[role];
  return <Icon className={`task-role role-${role}`} size={size} aria-label={threadRoleLabel(role)} />;
}
