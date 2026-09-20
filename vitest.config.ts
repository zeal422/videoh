import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/**
 * Unit tests run in a plain Node environment — the state core (commands, store,
 * snap, serialization, transition math) is deliberately pure so it can be tested
 * without a browser.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: [
        'src/lib/editor/commands.ts',
        'src/lib/editor/factories.ts',
        'src/lib/editor/snap.ts',
        'src/lib/editor/time.ts',
        'src/lib/editor/transition.ts',
        'src/lib/editor/tracks.ts',
        'src/lib/editor/timeline-scroll.ts',
        'src/lib/editor/serialization.ts',
        'src/lib/editor/store.ts',
        'src/lib/editor/persistence.ts',
        'src/lib/editor/workspace.ts',
        'src/lib/editor/menus.ts',
      ],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 75,
        lines: 70,
      },
    },
  },
})
