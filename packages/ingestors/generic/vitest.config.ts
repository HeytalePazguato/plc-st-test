import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'ingestors/generic',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
