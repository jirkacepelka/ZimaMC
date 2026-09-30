import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { DATA_DIR: path.join(os.tmpdir(), `zimamc-test-${process.pid}`) },
  },
});
