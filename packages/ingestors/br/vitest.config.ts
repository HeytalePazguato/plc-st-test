import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'ingestors/br',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
