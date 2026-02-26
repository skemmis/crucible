import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: {
    // Match the TypeScript target so ES2016+ operators like ** are valid.
    target: 'es2020',
  },
});
