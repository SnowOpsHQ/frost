import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTENT_NATIVE_FILES } from '@app/specs/sync-package.spec';
import { packageDir } from './third-party-notices.ts';

// The intent classifier's native runtime in the package (Phase 3 Task 2;
// `specs/intent-classifier.feature.md`, Packaging). Forge's Vite plugin packages only `.vite/`, so
// `onnxruntime-node` (external to the worker bundle, `vite.intent.config.ts`) and the
// `onnxruntime-common` it requires are copied into the app directory by forge.config.ts's
// `packageAfterCopy` hook, before the ASAR is made: each package's `package.json` and CommonJS
// `dist/` JavaScript, and of the N-API binaries only the target platform and architecture's binding
// and the one shared library it links against (`libonnxruntime.1.dylib` on macOS — the
// `.1.31.1.dylib` beside it in the package is the same file under another name — and
// `libonnxruntime.so.1` on Linux, found through the binding's `@loader_path` / `$ORIGIN` rpath;
// `onnxruntime.dll` beside the binding on Windows).
// `INTENT_ASAR_UNPACK` then takes the native files out of `app.asar` into `app.asar.unpacked`,
// where the process can load them (`require` of the binding from the archive is redirected there).

// The packages, binaries per target and unpack glob are the spec's (Packaging).
export { INTENT_ASAR_UNPACK, INTENT_NATIVE_FILES } from '@app/specs/sync-package.spec';

const ORT = 'onnxruntime-node';
const COMMON = 'onnxruntime-common';

/** The repository root (apps/desktop is two levels down). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The `.js` files directly in `dir` (relative to `root`, `/`-separated), sorted. */
function scripts(root: string, dir: string): string[] {
  return readdirSync(path.join(root, dir))
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => `${dir}/${file}`);
}

/** Where each package is installed (resolved like Node does from @app/desktop and from onnxruntime-node). */
function sources(): { readonly ort: string; readonly common: string } {
  const ort = packageDir(ORT, 'apps/desktop');
  return { ort, common: packageDir(COMMON, path.relative(ROOT, ort)) };
}

/**
 * The files copied for `platform`/`arch`, relative to the app directory (`node_modules/…`). Throws
 * for a target the runtime is not packaged for, so such a build fails rather than ships without it.
 */
export function intentRuntimeFiles(platform: string, arch: string): string[] {
  const natives = INTENT_NATIVE_FILES[`${platform}-${arch}`];
  if (!natives) throw new Error(`intent runtime: no onnxruntime-node binaries are packaged for ${platform}-${arch}`);
  const { ort, common } = sources();
  return [
    `node_modules/${ORT}/package.json`,
    ...scripts(ort, 'dist').map((file) => `node_modules/${ORT}/${file}`),
    ...natives.map((file) => `node_modules/${ORT}/bin/napi-v6/${platform}/${arch}/${file}`),
    `node_modules/${COMMON}/package.json`,
    `node_modules/${COMMON}/dist/cjs/package.json`,
    ...scripts(common, 'dist/cjs').map((file) => `node_modules/${COMMON}/${file}`),
  ];
}

/** Copies `intentRuntimeFiles(platform, arch)` from the installed packages into `buildPath` (the app directory). */
export function copyIntentRuntime(buildPath: string, platform: string, arch: string): void {
  const { ort, common } = sources();
  for (const file of intentRuntimeFiles(platform, arch)) {
    const [, pkg, ...rest] = file.split('/');
    const from = path.join(pkg === ORT ? ort : common, ...rest);
    const to = path.join(buildPath, ...file.split('/'));
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}
