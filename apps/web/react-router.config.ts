import type { Config } from '@react-router/dev/config';
import { vercelPreset } from '@vercel/react-router/vite';

/**
 * On Vercel (`VERCEL=1` during builds) the preset emits serverless functions. Everywhere else
 * (local dev, `react-router-serve`, Fly/Railway per brief §3) the plain Node server build is used.
 */
export default {
  appDirectory: 'app',
  ssr: true,
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
