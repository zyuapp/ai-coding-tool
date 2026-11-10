/** One change to a published workspace state, addressed by its path into the record. */
export type WorkspaceSplice = { index: number; deleteCount: number; items: unknown[] };
export type WorkspacePatch =
  | { path: Array<string | number>; value?: unknown; remove?: true }
  | { path: Array<string | number>; splice: WorkspaceSplice };
