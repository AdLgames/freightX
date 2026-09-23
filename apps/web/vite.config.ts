import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [reactRouter()],
  // Prisma's generated client cannot be bundled (CJS exports, runtime query-engine lookup);
  // keep the workspace db package as a runtime import of the server build.
  ssr: { external: ['@harbour/db'] },
});
