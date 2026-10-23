import { defineConfig } from 'vite';

// Sandboxed preloads must be CommonJS; Forge's Vite plugin emits CJS for preload targets.
export default defineConfig({});
