import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'project-model',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
