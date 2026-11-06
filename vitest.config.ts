import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The app test shares one file DB; run files one after another.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
