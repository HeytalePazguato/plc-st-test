import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'dialects/twincat',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
