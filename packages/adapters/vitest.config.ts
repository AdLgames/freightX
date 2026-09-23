import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'adapters',
    include: ['test/**/*.test.ts'],
  },
});
