import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web',
    include: ['app/**/*.test.ts', 'app/**/*.test.tsx'],
    environment: 'node',
  },
});
