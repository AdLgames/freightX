import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker',
    include: ['test/**/*.test.ts'],
  },
});
