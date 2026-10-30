import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'plugin-api',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
