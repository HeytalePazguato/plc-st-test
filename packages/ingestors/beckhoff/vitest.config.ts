import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'ingestors/beckhoff',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
