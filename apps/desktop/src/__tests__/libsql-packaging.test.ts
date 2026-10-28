// Spec: specs/sync-package.spec.ts · Acceptance: specs/sync-package.feature.md (Forge configuration)
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPackageWithOptions, getRawHeader } from '@electron/asar';
import { afterEach, describe, expect, test } from 'vitest';
import { LINUX_ARCHS } from '@app/specs/linux-package.spec';
import { MAC_ARCHS } from '@app/specs/macos-package.spec';
import {
  LIBSQL_ASAR_UNPACK,
  LIBSQL_ASAR_UNPACK_DOT_DIRS,
  LIBSQL_PREBUILD_TARGETS,
  LIBSQL_RUNTIME_PACKAGES,
  LIBSQL_SQLITE_VERSION,
  INTENT_ASAR_UNPACK,
  INTENT_NATIVE_FILES,
  INTENT_RUNTIME_PACKAGES,
  LIBSQL_ASAR_NODE_MODULES,
  PACKAGED_ASAR_NODE_MODULES,
  PACKAGED_ASAR_UNPACK,
  PACKAGED_UNPACKED_ALLOWLIST,
  libsqlPrebuildPackage,
  packagedTarget,
  type PackagedTarget,
} from '@app/specs/sync-package.spec';
import { WIN_ARCHS } from '@app/specs/windows-package.spec';
import { makeForgeConfig } from '../../forge.config';
import { copyLibsqlRuntime, findPackageDir } from '../../libsql-packaging';
import viteMainConfig from '../../vite.main.config';

const temps: string[] = [];
/** A fresh directory, by its real path (macOS: `/var/…` is `/private/var/…`, as module paths are). */
function tempDir(prefix: string, parent = tmpdir()): string {
  const dir = realpathSync(mkdtempSync(path.join(parent, prefix)));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      // Windows keeps a loaded `.node` locked until the process exits (the real-install test loads
      // the copied prebuild): left to the OS temp cleaner there.
      const code = (error as { code?: unknown }).code;
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
    }
  }
});

function writeFile(file: string, content: string | Buffer = ''): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

interface FakePackage {
  readonly dir: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly files?: Record<string, string>;
  readonly name: string;
}

function fakePackage(root: string, pkg: FakePackage): void {
  const dir = path.join(root, pkg.dir);
  const { name, version = '1.0.0', dependencies, optionalDependencies } = pkg;
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version, dependencies, optionalDependencies }));
  for (const [file, content] of Object.entries(pkg.files ?? { 'index.js': `module.exports = ${JSON.stringify(name)};` })) {
    writeFile(path.join(dir, file), content);
  }
}

const PREBUILDS = Object.fromEntries(Object.keys(LIBSQL_PREBUILD_TARGETS).map((t) => [libsqlPrebuildPackage(t as PackagedTarget), '0.5.29']));

/**
 * A fake hoisted install shaped like the real one: `@app/db` in packages/db, `@libsql/client` and
 * its dependencies hoisted, `libsql`'s exact `detect-libc` nested under it (a different one
 * hoisted), only the linux-x64 prebuild installed, and the unloaded dependencies present.
 */
function fakeInstall(overrides: Partial<Record<string, Partial<FakePackage> | null>> = {}): string {
  const root = tempDir('frost-libsql-root-');
  mkdirSync(path.join(root, 'packages/db'), { recursive: true });
  const packages: FakePackage[] = [
    {
      name: '@libsql/client',
      dir: 'node_modules/@libsql/client',
      dependencies: { '@libsql/core': '^0.18.0', '@libsql/hrana-client': '^0.10.0', 'js-base64': '^3.7.5', libsql: '^0.5.28', 'promise-limit': '^2.7.0' },
      files: { 'lib-cjs/sqlite3.js': '', 'lib-esm/sqlite3.js': '', 'lib-esm/sqlite3.d.ts': '', 'lib-cjs/sqlite3.js.map': '', 'README.md': '' },
    },
    { name: '@libsql/core', dir: 'node_modules/@libsql/core', dependencies: { 'js-base64': '^3.7.5' }, files: { 'lib-cjs/api.js': '', 'LICENSE.md': 'MIT' } },
    { name: 'js-base64', dir: 'node_modules/js-base64', files: { 'base64.js': '', 'LICENSE.md': 'BSD' } },
    {
      name: 'libsql',
      dir: 'node_modules/libsql',
      version: '0.5.29',
      dependencies: { '@neon-rs/load': '^0.0.4', 'detect-libc': '2.0.2' },
      optionalDependencies: PREBUILDS,
      files: { 'index.js': '', 'types/index.d.ts': '', LICENSE: 'MIT' },
    },
    { name: 'detect-libc', dir: 'node_modules/libsql/node_modules/detect-libc', version: '2.0.2' },
    { name: 'detect-libc', dir: 'node_modules/detect-libc', version: '2.1.2' },
    { name: '@neon-rs/load', dir: 'node_modules/@neon-rs/load', files: { 'dist/index.js': '' } },
    { name: '@libsql/linux-x64-gnu', dir: 'node_modules/@libsql/linux-x64-gnu', version: '0.5.29', files: { 'index.node': 'ELF', 'README.md': '' } },
    { name: '@libsql/hrana-client', dir: 'node_modules/@libsql/hrana-client' },
    { name: 'promise-limit', dir: 'node_modules/promise-limit' },
  ];
  for (const pkg of packages) {
    const key = pkg.dir.replace(/^node_modules\//, '');
    const override = overrides[key];
    if (override === null) continue;
    fakePackage(root, { ...pkg, ...override });
  }
  return root;
}

/** The packages under a `node_modules` directory (scoped ones as `@scope/name`). */
function packagesIn(modules: string): string[] {
  return readdirSync(modules)
    .flatMap((entry) => (entry.startsWith('@') ? readdirSync(path.join(modules, entry)).map((name) => `${entry}/${name}`) : [entry]))
    .sort();
}

/** Every file under `dir`, relative and `/`-separated. */
function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name), base) : [path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/')]))
    .sort();
}

describe('libSQL in the packaged app', () => {
  test('libsql-runtime-copied', () => {
    const root = fakeInstall();
    const buildPath = tempDir('frost-libsql-build-');
    const copied = copyLibsqlRuntime(buildPath, 'linux', 'x64', root);
    const modules = path.join(buildPath, 'node_modules');
    // Exactly the runtime set and the target's prebuild, flat, prebuild last.
    expect(copied).toEqual([...LIBSQL_RUNTIME_PACKAGES.map((pkg) => pkg.name), '@libsql/linux-x64-gnu']);
    expect(packagesIn(modules)).toEqual(LIBSQL_ASAR_NODE_MODULES['linux-x64']);
    // detect-libc is the one libsql resolves (nested 2.0.2), not the hoisted 2.1.2.
    expect(JSON.parse(readFileSync(path.join(modules, 'detect-libc/package.json'), 'utf8')).version).toBe('2.0.2');
    // Docs, types and source maps are skipped; licenses are kept; no nested node_modules.
    expect(filesUnder(path.join(modules, '@libsql/client'))).toEqual(['lib-cjs/sqlite3.js', 'lib-esm/sqlite3.js', 'package.json']);
    expect(filesUnder(path.join(modules, 'libsql'))).toEqual(['LICENSE', 'index.js', 'package.json']);
    expect(filesUnder(path.join(modules, '@libsql/core'))).toContain('LICENSE.md');
    expect(filesUnder(path.join(modules, '@libsql/linux-x64-gnu'))).toEqual(['index.node', 'package.json']);
    expect(filesUnder(modules).filter((file) => file.includes('node_modules'))).toEqual([]);
    // The hook Forge runs copies libSQL (beside the intent runtime): forge-config.test.ts,
    // intent-runtime-copied-by-the-package-hook, checks both packages land for the host's target.
  });

  test('libsql-runtime-copied (the real install)', () => {
    const target = packagedTarget(process.platform, process.arch);
    if (target === null) return; // a host frost does not package (its prebuild is not the one shipped)
    const buildPath = tempDir('frost-libsql-build-');
    copyLibsqlRuntime(buildPath, process.platform, process.arch);
    expect(packagesIn(path.join(buildPath, 'node_modules'))).toEqual(LIBSQL_ASAR_NODE_MODULES[target]);
    // The copy alone is enough to load libSQL, as main does (from .vite/build/), nothing from outside it.
    const requireFromMain = createRequire(path.join(buildPath, '.vite', 'build', 'main.cjs'));
    const client = (requireFromMain('@libsql/client/sqlite3') as typeof import('@libsql/client/sqlite3')).createClient({ url: ':memory:' });
    const loaded = Object.keys(requireFromMain.cache).filter((file) => file.includes(`${path.sep}node_modules${path.sep}`) && file.startsWith(path.dirname(buildPath)));
    expect(loaded.every((file) => file.startsWith(`${buildPath}${path.sep}`))).toBe(true);
    expect(loaded.some((file) => file.endsWith(`${path.sep}index.node`))).toBe(true);
    return client.execute('SELECT sqlite_version() AS v').then((result) => {
      client.close();
      expect(result.rows[0]?.['v']).toBe(LIBSQL_SQLITE_VERSION);
    });
  });

  test('libsql-prebuild-missing-fails', () => {
    // pnpm installs only the build machine's prebuild: packaging win32 on Linux fails, clearly.
    const root = fakeInstall();
    const buildPath = tempDir('frost-libsql-build-');
    expect(() => copyLibsqlRuntime(buildPath, 'win32', 'x64', root)).toThrow(
      /@libsql\/win32-x64-msvc is not installed.*package win32-x64 on a win32 x64 machine/,
    );
    expect(existsSync(path.join(buildPath, 'node_modules'))).toBe(false);
    // A missing runtime package, a target frost does not package, a prebuild of another version.
    expect(() => copyLibsqlRuntime(buildPath, 'linux', 'x64', fakeInstall({ 'js-base64': null }))).toThrow(/js-base64 \(required by @libsql\/core\) is not installed/);
    expect(() => copyLibsqlRuntime(buildPath, 'linux', 'arm64', root)).toThrow(/not linux-arm64/);
    expect(() => copyLibsqlRuntime(buildPath, 'darwin', 'x64', root)).toThrow(/not darwin-x64/);
    expect(() => copyLibsqlRuntime(buildPath, 'linux', 'x64', fakeInstall({ '@libsql/linux-x64-gnu': { version: '0.5.30' } }))).toThrow(/pins @libsql\/linux-x64-gnu@0\.5\.29/);
    expect(existsSync(path.join(buildPath, 'node_modules'))).toBe(false);
  });

  test('libsql-runtime-is-closed', () => {
    const buildPath = tempDir('frost-libsql-build-');
    // A dependency that is neither shipped nor known to be unloaded fails the build.
    const added = fakeInstall({ '@libsql/core': { dependencies: { 'js-base64': '^3.7.5', 'left-pad': '1' } } });
    expect(() => copyLibsqlRuntime(buildPath, 'linux', 'x64', added)).toThrow(/@libsql\/core depends on left-pad/);
    // A shipped dependency that resolves elsewhere from its dependent cannot be copied flat.
    const nested = fakeInstall();
    fakePackage(nested, { name: 'js-base64', dir: 'node_modules/@libsql/core/node_modules/js-base64', version: '2.0.0' });
    expect(() => copyLibsqlRuntime(buildPath, 'linux', 'x64', nested)).toThrow(/@libsql\/client resolves a different js-base64/);
    // A native module anywhere but the prebuild's index.node is refused.
    const stray = fakeInstall({ libsql: { files: { 'index.js': '', 'index.node': 'ELF' } } });
    expect(() => copyLibsqlRuntime(tempDir('frost-libsql-build-'), 'linux', 'x64', stray)).toThrow(/libsql holds a native module index\.node/);
    // The hook never merges into an existing node_modules.
    mkdirSync(path.join(buildPath, 'node_modules'));
    expect(() => copyLibsqlRuntime(buildPath, 'linux', 'x64', fakeInstall())).toThrow(/already exists/);
  });

  /** Packs `files` under `<temp>/<dotDirs…>/app` with @electron/asar as Packager does; the entries it marks unpacked. */
  async function unpackedWith(dotDirs: string[], files: string[]) {
    const app = path.join(tempDir('frost-libsql-asar-'), ...dotDirs, 'app');
    for (const file of files) writeFile(path.join(app, file), 'x');
    const asar = path.join(path.dirname(app), 'app.asar');
    await createPackageWithOptions(app, asar, { unpack: LIBSQL_ASAR_UNPACK });
    const unpacked: string[] = [];
    const walk = (node: { files?: Record<string, { unpacked?: boolean; files?: unknown }> }, prefix: string) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const entryPath = prefix ? `${prefix}/${name}` : name;
        if (entry.unpacked) unpacked.push(entryPath);
        if (entry.files) walk(entry as never, entryPath);
      }
    };
    walk(getRawHeader(asar).header as never, '');
    return { unpacked, onDisk: existsSync(`${asar}.unpacked`) ? filesUnder(`${asar}.unpacked`) : [] };
  }

  test('libsql-unpack-pattern', async () => {
    expect(makeForgeConfig({}).packagerConfig?.asar).toEqual({ unpack: PACKAGED_ASAR_UNPACK });
    expect(PACKAGED_ASAR_UNPACK).toBe(`{${LIBSQL_ASAR_UNPACK},${INTENT_ASAR_UNPACK}}`);
    // @electron/asar matches the absolute path, without minimatch's `dot`: only a prebuild's
    // index.node is unpacked, here under two dot directories in the build path.
    const files = [
      '.vite/build/main.cjs',
      '.vite/build/stray.node',
      'package.json',
      'node_modules/@libsql/linux-x64-gnu/index.node',
      'node_modules/@libsql/linux-x64-gnu/package.json',
      'node_modules/@libsql/linux-x64-gnu/other.node',
      'node_modules/@libsql/client/lib-cjs/sqlite3.js',
      'node_modules/libsql/index.node',
      'node_modules/libsql/index.js',
    ];
    const prebuild = ['node_modules/@libsql/linux-x64-gnu/index.node'];
    expect(await unpackedWith(['.cache', 'build', '.tmp'], files)).toEqual({ unpacked: prebuild, onDisk: prebuild });
    // Up to LIBSQL_ASAR_UNPACK_DOT_DIRS dot directories (and none); one more unpacks nothing, which
    // fails closed in the verifiers' unpacked-allowlist.
    const dots = (n: number) => Array.from({ length: n }, (_, i) => `.d${i}`);
    for (const n of [0, LIBSQL_ASAR_UNPACK_DOT_DIRS]) expect((await unpackedWith(dots(n), prebuild)).unpacked, `${n} dot dirs`).toEqual(prebuild);
    expect((await unpackedWith(dots(LIBSQL_ASAR_UNPACK_DOT_DIRS + 1), prebuild)).unpacked).toEqual([]);
    // The allowlist is that one file per target, and the intent runtime's native files (INTENT_NATIVE_FILES).
    for (const target of Object.keys(LIBSQL_PREBUILD_TARGETS) as PackagedTarget[]) {
      const [platform, arch] = target.split('-');
      const intent = (INTENT_NATIVE_FILES[target] ?? []).map((file) => `app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/${platform}/${arch}/${file}`);
      expect(intent.length, target).toBeGreaterThan(0);
      expect(PACKAGED_UNPACKED_ALLOWLIST[target]).toEqual([`app.asar.unpacked/node_modules/${libsqlPrebuildPackage(target)}/index.node`, ...intent].sort());
      expect(PACKAGED_ASAR_NODE_MODULES[target]).toEqual([...LIBSQL_ASAR_NODE_MODULES[target], ...INTENT_RUNTIME_PACKAGES].sort());
    }
  });

  test('libsql-external-in-main', () => {
    const { external } = viteMainConfig.build?.rollupOptions ?? {};
    expect(Array.isArray(external)).toBe(true);
    const isExternal = (id: string) => (external as (string | RegExp)[]).some((rule) => (typeof rule === 'string' ? rule === id : rule.test(id)));
    for (const id of ['@libsql/client', '@libsql/client/sqlite3', 'libsql', 'libsql/promise', 'node:sqlite']) expect(isExternal(id), id).toBe(true);
    for (const id of ['@libsql/core', '@libsql/clientx', 'libsqlx', 'drizzle-orm', '@app/db']) expect(isExternal(id), id).toBe(false);
    // `await import()` of an external is emitted as `require` (the packaged main is CommonJS).
    expect(viteMainConfig.build?.rollupOptions?.output).toMatchObject({ dynamicImportInCjs: false });
  });

  test('libsql-targets-are-the-packaged-ones', () => {
    const packaged = [...MAC_ARCHS.map((a) => `darwin-${a}`), ...LINUX_ARCHS.map((a) => `linux-${a}`), ...WIN_ARCHS.map((a) => `win32-${a}`)].sort();
    expect(Object.keys(LIBSQL_PREBUILD_TARGETS).sort()).toEqual(packaged);
    // Every shipped prebuild is one the installed libsql pins.
    const libsql = JSON.parse(readFileSync(path.join(findPackageDir('libsql', path.resolve(import.meta.dirname, '../../../../packages/db'))!, 'package.json'), 'utf8')) as {
      optionalDependencies: Record<string, string>;
    };
    for (const target of packaged as PackagedTarget[]) expect(Object.keys(libsql.optionalDependencies)).toContain(libsqlPrebuildPackage(target));
  });
});
