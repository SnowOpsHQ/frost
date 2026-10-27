import { defineConfig } from 'vitest/config';
import { webVitalsSource } from './vite.web-vitals.ts';

export default defineConfig({
  plugins: [webVitalsSource()],
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
