import { defineConfig } from "vitest/config";

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
      PEON_SHOW_ALL_PROJECTS: "1"
    }
  }
});

