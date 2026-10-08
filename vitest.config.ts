import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'connectors/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // No passWithNoTests. A green run that ran nothing is believed.
    passWithNoTests: false,
  },
})
