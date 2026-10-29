import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgeHookFn } from '@electron-forge/shared-types';
import {
  LIBSQL_KEPT_FILES,
  LIBSQL_NATIVE_PACKAGE,
  LIBSQL_PREBUILD_FILE,
  LIBSQL_PREBUILD_TARGETS,
  LIBSQL_RUNTIME_PACKAGES,
  LIBSQL_SKIPPED_FILES,
  LIBSQL_UNLOADED_DEPENDENCIES,
  libsqlPrebuildPackage,
  packagedTarget,
  type PackagedTarget,
} from '@app/specs/sync-package.spec';

// libSQL in the packaged app (specs/sync-package.spec.ts, sync-package.feature.md). Forge's Vite
// plugin packages only `.vite/` and `package.json`; main `require`s `@libsql/client/sqlite3` at
// runtime (vite.main.config.ts keeps it external), so this `packageAfterCopy` hook copies exactly
// the packages that entry loads, and the target's native prebuild, from the hoisted install into
// `<buildPath>/node_modules/`, flat. Packager then packs them into app.asar, unpacking only the
// prebuild's `index.node` (`LIBSQL_ASAR_UNPACK`). Anything unexpected fails the build.

/** The repository root (apps/desktop is two levels down). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The workspace packages a runtime package may be required by, as directories under the root. */
const WORKSPACE_DIRS: Readonly<Record<string, string>> = { '@app/db': 'packages/db' };

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export interface ResolvedPackage {
  readonly name: string;
  /** The installed package directory (symlinks resolved). */
  readonly dir: string;
  readonly manifest: Manifest;
}

function fail(message: string): never {
  throw new Error(`libsql-packaging: ${message}`);
}

/** The directory of package `name` as Node would find it from `fromDir` (walking up `node_modules`), or `null`. */
export function findPackageDir(name: string, fromDir: string): string | null {
  for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest;
}

/** The packaged target of a Forge platform / arch; throws for one frost does not package. */
export function requirePackagedTarget(platform: string, arch: string): PackagedTarget {
  const target = packagedTarget(platform, arch);
  if (target === null) fail(`frost ships libSQL for ${Object.keys(LIBSQL_PREBUILD_TARGETS).join(', ')} only, not ${platform}-${arch}`);
  return target;
}

/**
 * Resolves `LIBSQL_RUNTIME_PACKAGES` and the target's prebuild from the install under `root`, and
 * checks the set is closed: every dependency a runtime package declares is either shipped (and
 * resolves, from that package, to the very directory that is shipped, so copying them flat keeps
 * what each one loads) or listed in `LIBSQL_UNLOADED_DEPENDENCIES`. Throws on anything missing or
 * unexpected; the prebuild is listed last.
 */
export function resolveLibsqlPackages(target: PackagedTarget, root: string = ROOT): ResolvedPackage[] {
  const resolved = new Map<string, ResolvedPackage>();
  for (const { name, requiredBy } of LIBSQL_RUNTIME_PACKAGES) {
    const workspace = WORKSPACE_DIRS[requiredBy];
    const fromDir = workspace !== undefined ? path.join(root, workspace) : resolved.get(requiredBy)?.dir;
    if (fromDir === undefined) fail(`${name} is required by ${requiredBy}, which is not resolved before it`);
    const dir = findPackageDir(name, fromDir);
    if (dir === null) fail(`${name} (required by ${requiredBy}) is not installed; run pnpm install`);
    const manifest = readManifest(dir);
    if (manifest.name !== name) fail(`${dir}/package.json names ${manifest.name}, expected ${name}`);
    resolved.set(name, { name, dir, manifest });
  }

  const prebuild = libsqlPrebuildPackage(target);
  const native = resolved.get(LIBSQL_NATIVE_PACKAGE)!;
  const prebuildDir = findPackageDir(prebuild, native.dir);
  if (prebuildDir === null) {
    fail(
      `${prebuild} is not installed, so libSQL's native module for ${target} cannot be shipped. pnpm installs only ` +
        `the build machine's own prebuild: package ${target} on a ${target.replace('-', ' ')} machine (CI builds each ` +
        'platform on its own runner)',
    );
  }
  const prebuildManifest = readManifest(prebuildDir);
  const pinned = native.manifest.optionalDependencies?.[prebuild];
  if (pinned === undefined) fail(`${LIBSQL_NATIVE_PACKAGE} ${native.manifest.version} has no ${prebuild} prebuild`);
  if (prebuildManifest.name !== prebuild || prebuildManifest.version !== pinned) {
    fail(`${prebuildDir} is ${prebuildManifest.name}@${prebuildManifest.version}, but ${LIBSQL_NATIVE_PACKAGE} pins ${prebuild}@${pinned}`);
  }
  if (!existsSync(path.join(prebuildDir, LIBSQL_PREBUILD_FILE))) fail(`${prebuild} has no ${LIBSQL_PREBUILD_FILE}`);
  if (Object.keys({ ...prebuildManifest.dependencies, ...prebuildManifest.optionalDependencies }).length > 0) {
    fail(`${prebuild} declares dependencies; a prebuild is expected to hold only ${LIBSQL_PREBUILD_FILE}`);
  }

  const unloaded: Readonly<Record<string, readonly string[]>> = LIBSQL_UNLOADED_DEPENDENCIES;
  for (const pkg of resolved.values()) {
    const optional = pkg.name === LIBSQL_NATIVE_PACKAGE ? {} : pkg.manifest.optionalDependencies;
    for (const dependency of Object.keys({ ...pkg.manifest.dependencies, ...optional })) {
      const shipped = resolved.get(dependency);
      if (shipped === undefined) {
        if (unloaded[pkg.name]?.includes(dependency)) continue;
        fail(`${pkg.name} depends on ${dependency}, which is neither shipped (LIBSQL_RUNTIME_PACKAGES) nor listed in LIBSQL_UNLOADED_DEPENDENCIES`);
      }
      if (findPackageDir(dependency, pkg.dir) !== shipped.dir) {
        fail(`${pkg.name} resolves a different ${dependency} than the one shipped (${shipped.dir}); copying them flat would change what it loads`);
      }
    }
  }
  return [...resolved.values(), { name: prebuild, dir: prebuildDir, manifest: prebuildManifest }];
}

/**
 * Copies one package directory: no nested `node_modules/` (the set is copied flat), no
 * `LIBSQL_SKIPPED_FILES` (license files are always kept), no symlinks, and a `.node` file only as
 * the prebuild's own `index.node`. Directories are created only for files copied into them.
 */
function copyPackage(source: string, destination: string, isPrebuild: boolean, name: string, relative = ''): void {
  for (const entry of readdirSync(path.join(source, relative), { withFileTypes: true })) {
    const entryPath = path.join(relative, entry.name);
    const from = path.join(source, entryPath);
    if (lstatSync(from).isSymbolicLink()) fail(`${name} holds a symlink (${entryPath}); refusing to ship it`);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') copyPackage(source, destination, isPrebuild, name, entryPath);
      continue;
    }
    if (!entry.isFile()) fail(`${name} holds ${entryPath}, which is not a regular file`);
    if (entry.name.endsWith('.node') && !(isPrebuild && entryPath === LIBSQL_PREBUILD_FILE)) {
      fail(`${name} holds a native module ${entryPath}; only the prebuild's ${LIBSQL_PREBUILD_FILE} may be shipped`);
    }
    if (LIBSQL_SKIPPED_FILES.test(entry.name) && !LIBSQL_KEPT_FILES.test(entry.name)) continue;
    const to = path.join(destination, entryPath);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/**
 * Copies the libSQL runtime for `platform` / `arch` into `<buildPath>/node_modules/` (which must
 * not exist yet). Returns the package names copied, prebuild last.
 */
export function copyLibsqlRuntime(buildPath: string, platform: string, arch: string, root: string = ROOT): string[] {
  const target = requirePackagedTarget(platform, arch);
  const packages = resolveLibsqlPackages(target, root);
  const modules = path.join(buildPath, 'node_modules');
  if (existsSync(modules)) fail(`${modules} already exists; only this hook may create it`);
  const prebuild = libsqlPrebuildPackage(target);
  for (const { name, dir } of packages) copyPackage(dir, path.join(modules, ...name.split('/')), name === prebuild, name);
  return packages.map((pkg) => pkg.name);
}

/** Forge's `packageAfterCopy` hook (forge.config.ts). */
export const libsqlPackageAfterCopy: ForgeHookFn<'packageAfterCopy'> = async (_config, buildPath, _electronVersion, platform, arch) => {
  copyLibsqlRuntime(buildPath, platform, arch);
};
