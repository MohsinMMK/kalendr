import type { FileStore } from "@/server/file-store";

/** A file store in memory for import tests: what the app wrote is exactly what can be inspected afterwards. */
export const memoryStore = (() => {
  const files = new Map<string, Buffer>();
  const store: FileStore & { files: Map<string, Buffer> } = {
    files,
    async put(key, bytes) {
      if (files.has(key)) throw new Error("exists");
      files.set(key, Buffer.from(bytes));
    },
    async replace(key, bytes) {
      files.set(key, Buffer.from(bytes));
    },
    async get(key) {
      const found = files.get(key);
      if (!found) throw new Error("missing");
      return Buffer.from(found);
    },
    async remove(key) {
      files.delete(key);
    },
  };
  return store;
})();
