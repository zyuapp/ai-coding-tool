import type { Project } from "../../domain/project.js";

/**
 * The folder editor, open on one project. A name typed beside a folder that is still being opened
 * waits here, so a directory the app cannot open leaves the name where the user last saw it too.
 */
export type ProjectEdit = {
  projectId: string;
  name?: string | null;
  saving: boolean;
  error: string | null;
};

export type ProjectsState = {
  projects: Project[];
  /** The folder the editor is open on, if any, and what came back the last time it tried to save. */
  projectEdit: ProjectEdit | null;
};

export function initialProjectsState(): ProjectsState {
  return { projects: [], projectEdit: null };
}
