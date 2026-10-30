import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'dialects/br',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
