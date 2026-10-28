import { defineConfig } from 'vite';

// The intent utility process's bundle (.vite/build/intent-worker.cjs; Phase 3 Task 2,
// specs/intent-classifier.feature.md, Packaging). Forge's Vite plugin supplies the lib entry, the CJS
// output and Node's builtins as externals (forge.config.ts). `onnxruntime-node` stays external too: it
// is a native module, loaded at run time from the copy forge.config.ts's packaging hook puts in the
// app (intent-runtime.ts). Everything else (the tokenizer, prototypes, specs, Zod) is bundled.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['onnxruntime-node'],
    },
  },
});
