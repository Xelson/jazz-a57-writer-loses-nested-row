import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Every test starts its own in-memory sync server and memory clients; run the
    // files one after another so the host never carries more than a few engines.
    fileParallelism: false,
    testTimeout: 60_000,
  },
})
