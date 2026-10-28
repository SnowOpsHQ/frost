import { defineConfig } from 'vite';

// The intent utility process's bundle (.vite/build/intent-worker.cjs; Phase 3 Task 2,
// specs/intent-classifier.feature.md, Packaging). Forge's Vite plugin supplies the lib entry, the CJS
// output and Node's builtins as externals (forge.config.ts). `onnxruntime-node` stays external too: it
// is a native module, loaded at run time from the copy forge.config.ts's packaging hook puts in the
// app (intent-runtime.ts). Everything else (the tokenizer, prototypes, specs, Zod) is bundled.
// `dynamicImportInCjs: false` turns the worker's lazy `import('onnxruntime-node')` into a plain
// `require("onnxruntime-node")`, so the native module is loaded by Node's CommonJS loader (with
// Electron's ASAR support and its redirect to app.asar.unpacked), never by the ESM loader from inside
// app.asar (forge-config.test.ts, intent-worker-requires-the-runtime).
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['onnxruntime-node'],
      output: { dynamicImportInCjs: false },
    },
  },
});
