import type { IconType } from "react-icons";
import { LuFlaskConical as FlaskConical, LuHammer as Hammer, LuSearchCheck as SearchCheck, LuWaypoints as Waypoints } from "react-icons/lu";
import { threadRoleLabel, type ThreadRole } from "../../domain/thread-role";

const ROLE_ICONS: Record<ThreadRole, IconType> = {
  coordinator: Waypoints,
  implementer: Hammer,
  reviewer: SearchCheck,
  researcher: FlaskConical,
};

/** The icon a role is drawn with, or none for a role this build does not know. */
export function roleIcon(role: ThreadRole): IconType | undefined {
  return Object.hasOwn(ROLE_ICONS, role) ? ROLE_ICONS[role] : undefined;
}

/** The mark a thread with a role carries in its row's rail, in the role's colour. A role this build does not know draws none. */
export function ThreadRoleMark({ role, size }: { role: ThreadRole; size: number }) {
  const Icon = roleIcon(role);
  if (!Icon) return null;
  return <Icon className={`task-role role-${role}`} size={size} aria-label={threadRoleLabel(role)} />;
}
