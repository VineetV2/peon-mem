import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Keep the suite hermetic: never touch the network even if a real .env with an
    // OPENROUTER_API_KEY is found up the tree. Forces deterministic local embeddings.
    env: {
      PEON_EMBEDDING_MODE: "local",
      // Tests use temp dirs as stand-in projects; show them (production hides temp/empty).
      PEON_SHOW_ALL_PROJECTS: "1",
      // Isolate the global brain from the real one so tests can't read or pollute it.
      PEON_GLOBAL_DIR: join(tmpdir(), "peon-test-global")
    }
  }
});

