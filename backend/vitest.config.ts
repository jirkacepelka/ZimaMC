import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests share one data folder, so run files one after another.
    fileParallelism: false,
    env: { DATA_DIR: path.join(os.tmpdir(), `zimamc-test-${process.pid}`) },
  },
});
