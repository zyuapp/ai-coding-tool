import { TaskStore, type KeyValueStorage } from "../../application/task-store";

export function createLocalTaskStore() {
  const storage: KeyValueStorage = {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  };
  return new TaskStore(storage);
}
