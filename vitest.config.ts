import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'packages/ingestors/*/vitest.config.ts',
      'packages/dialects/*/vitest.config.ts',
      { test: { name: 'root', include: ['test/**/*.test.ts'], environment: 'node' } },
    ],
  },
})
