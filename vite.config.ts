import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages 프로젝트 사이트 경로(https://gyutae-kim.github.io/2dcad-viewer/)
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
