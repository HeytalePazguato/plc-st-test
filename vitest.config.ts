import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'packages/ingestors/*/vitest.config.ts',
      'packages/dialects/*/vitest.config.ts',
      { test: { name: 'github-action', include: ['integrations/github-action/test/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'security', include: ['test/security/**/*.test.ts'], environment: 'node', testTimeout: 120_000 } },
      { test: { name: 'root', include: ['test/**/*.test.ts'], exclude: ['test/security/**'], environment: 'node' } },
    ],
  },
})
