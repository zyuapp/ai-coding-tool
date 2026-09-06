import { mkdtemp, rm } from "node:fs/promises";
import { onTestFinished } from "vitest";

export async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(prefix);
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
