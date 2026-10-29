import path from 'node:path';
import { BUBBLEWRAP_PATHS, isPathWithin, MACOS_SANDBOX_EXEC, type McpSandboxMode } from '@app/specs/agent-mcp.spec';

// How a command server is launched (Phase 5 Task 10 and its security review; spec
// `specs/agent-mcp.spec.ts`, `MCP_SANDBOX_MODES`; acceptance `specs/agent-mcp.feature.md`,
// Sandboxes). Pure builders (golden tested) and the run-time detection:
//
// - **bubblewrap** (Linux, `/usr/bin/bwrap` or `/bin/bwrap` answering `--version`; never looked up
//   on `PATH`): `/` read-only; fresh `/dev` and `/proc`; empty `/tmp` and `/run` (so no socket of the
//   session's — the D-Bus session bus, the display server, agents, the keyring — is reachable
//   through the file system); the home folders and frost's `userData` replaced by empty ones; then
//   the folders the user listed (each vetted by main on its real path, `isAllowedMcpReadFolder`)
//   put back strictly read-only (`--ro-bind`), and last the server's own temporary folder
//   (writable). Every namespace unshared (`--unshare-all`; the user namespace explicitly, with
//   `--disable-userns` where bubblewrap has it, so the server can't make namespaces of its own); no
//   network unless the user allowed it (`--share-net`, which also shares localhost and abstract
//   sockets); `--die-with-parent` (the server is killed when bubblewrap or frost, its parent, dies),
//   `--new-session` (no terminal to inject keystrokes into), every capability dropped. No seccomp
//   filter is installed. bubblewrap reports on fd 3 once the sandbox is up (`--json-status-fd`), so
//   frost can tell its refusal from the server's own exit.
// - **macOS sandbox** (`/usr/bin/sandbox-exec` present): a deny-by-default profile frost writes: run
//   the command and programs in the listed folders; read the file system except `/Users`, `/Volumes`,
//   `/private/var/folders`, `/private/tmp`, the home folders and `userData` (names stay visible:
//   metadata only), with the command, its temporary folder and the listed folders allowed back; write
//   only in its temporary folder; no network unless allowed, and then IP only (plus the system's DNS
//   socket): a unix socket (an agent, `docker.sock`) is never reachable; no service lookups beyond DNS.
// - **none** (Windows, Linux without bubblewrap): the command itself, as the user.
//
// The environment is minimal everywhere: `PATH` (main's), `HOME` (the server's temporary folder),
// and the variables the user added (whose values main keeps encrypted). It goes through the
// launcher's environment, never its arguments (which other users' processes may list).

export interface LaunchInput {
  /** The command, resolved to its real path. */
  readonly command: string;
  readonly args: readonly string[];
  /** The server's own, empty temporary folder (its real path). */
  readonly tempDir: string;
  /** Real paths hidden from the server: the home folders and frost's `userData`. */
  readonly hidden: readonly string[];
  readonly allowNetwork: boolean;
  /** Folders the sandboxed command may read (real paths main vetted). */
  readonly readPaths: readonly string[];
  /** `PATH` as main has it. */
  readonly pathEnv: string;
  /** The user's variables, values decrypted for this start. */
  readonly env: Readonly<Record<string, string>>;
  /** bubblewrap has `--disable-userns` (detected). */
  readonly disableUserns?: boolean;
}

export interface LaunchPlan {
  readonly mode: McpSandboxMode;
  /** The program spawned (the launcher, or the command) and its arguments. */
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  /** Whether fd 3 carries bubblewrap's status. */
  readonly statusFd: boolean;
}

/** The environment a command server gets: `PATH`, `HOME` (its temporary folder) and the user's variables. */
export function serverEnv(input: Pick<LaunchInput, 'pathEnv' | 'tempDir' | 'env'>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env)) env[name] = value;
  env['PATH'] = input.pathEnv;
  env['HOME'] = input.tempDir;
  return env;
}

/** `paths` without repeats and without one inside another (the outer one covers it). */
function outermost(paths: readonly string[]): string[] {
  const unique = [...new Set(paths.filter((item) => item.startsWith('/')))];
  return unique.filter((item) => !unique.some((other) => other !== item && isPathWithin(item, other)));
}

/** bubblewrap's arguments for `input` (the command and its arguments after `--`). */
export function bubblewrapArgs(input: LaunchInput): string[] {
  const args = ['--die-with-parent', '--new-session', '--unshare-all'];
  if (input.disableUserns === true) args.push('--unshare-user', '--disable-userns');
  if (input.allowNetwork) args.push('--share-net');
  args.push('--cap-drop', 'ALL', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run');
  const hidden = outermost(input.hidden);
  for (const folder of hidden) args.push('--tmpfs', folder);
  // With the network, name resolution reads systemd-resolved's stub (`/etc/resolv.conf` points into /run).
  if (input.allowNetwork) args.push('--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve');
  // The listed folders: strictly read-only (main checked each one's real path exists and is allowed).
  for (const folder of input.readPaths) args.push('--ro-bind', folder, folder);
  // A command inside a hidden folder must still be there to run: put back by itself, read-only.
  if (hidden.some((folder) => isPathWithin(input.command, folder)) && !input.readPaths.some((folder) => isPathWithin(input.command, folder))) args.push('--ro-bind', input.command, input.command);
  // Its own folder last, so nothing listed can cover it.
  args.push('--bind', input.tempDir, input.tempDir, '--chdir', input.tempDir, '--json-status-fd', '3', '--', input.command, ...input.args);
  return args;
}

/** A string literal in the sandbox profile language (`"` and `\` escaped). */
export function sbplString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Folders macOS's profile hides whatever else it allows (other accounts, drives, temporary folders). */
export const MACOS_HIDDEN_FOLDERS = ['/Users', '/Volumes', '/private/var/folders', '/private/tmp'] as const;

/** The macOS sandbox profile for `input`. */
export function macosSandboxProfile(input: Pick<LaunchInput, 'command' | 'tempDir' | 'hidden' | 'allowNetwork' | 'readPaths'>): string {
  const reads = input.readPaths.map((folder) => `(subpath ${sbplString(folder)})`).join(' ');
  const hidden = outermost([...MACOS_HIDDEN_FOLDERS, ...input.hidden])
    .map((folder) => `(subpath ${sbplString(folder)})`)
    .join(' ');
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    `(allow process-exec (literal ${sbplString(input.command)})${reads === '' ? '' : ` ${reads}`})`,
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(deny file-read* ${hidden})`,
    '(allow file-read-metadata)',
    `(allow file-read* (literal ${sbplString(input.command)}) (subpath ${sbplString(input.tempDir)})${reads === '' ? '' : ` ${reads}`})`,
    `(allow file-write* (subpath ${sbplString(input.tempDir)}))`,
    '(allow file-write-data (literal "/dev/null"))',
  ];
  if (input.allowNetwork) {
    // IP only, and the system's DNS socket: never another unix socket (agents, docker.sock).
    lines.push(
      '(allow network-outbound (remote ip))',
      '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
      '(allow network-inbound (local ip))',
      '(allow system-socket)',
      '(allow mach-lookup (global-name "com.apple.dnssd.service"))',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** How to launch `input` under `mode` (`n/a` is not a command mode: treated as `none`, never claimed). */
export function launchPlan(mode: McpSandboxMode, input: LaunchInput, sandboxExec: string = MACOS_SANDBOX_EXEC, bubblewrap: string = BUBBLEWRAP_PATHS[0]): LaunchPlan {
  const env = serverEnv(input);
  switch (mode) {
    case 'bubblewrap':
      return { mode, command: bubblewrap, args: bubblewrapArgs(input), env, cwd: input.tempDir, statusFd: true };
    case 'macos-sandbox':
      return { mode, command: sandboxExec, args: ['-p', macosSandboxProfile(input), input.command, ...input.args], env, cwd: input.tempDir, statusFd: false };
    case 'none':
    case 'n/a':
      return { mode: 'none', command: input.command, args: [...input.args], env, cwd: input.tempDir, statusFd: false };
  }
}

/**
 * `command` as an absolute path: itself if absolute and executable, else the first executable match
 * in `pathEnv`'s absolute folders (on Windows with `.exe` or `.com` added; a `.cmd` or `.bat` needs a
 * shell, which frost doesn't use). `null` when none is found.
 */
export function resolveCommand(command: string, pathEnv: string, platform: NodeJS.Platform, isExecutable: (file: string) => boolean): string | null {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const candidates = (base: string) => (win ? (/\.(exe|com)$/i.test(base) ? [base] : [`${base}.exe`, `${base}.com`]) : [base]);
  if (p.isAbsolute(command)) return candidates(command).find(isExecutable) ?? null;
  if (/[\\/]/.test(command)) return null;
  for (const folder of pathEnv.split(win ? ';' : ':')) {
    if (folder === '' || !p.isAbsolute(folder)) continue;
    const found = candidates(p.join(folder, command)).find(isExecutable);
    if (found !== undefined) return found;
  }
  return null;
}

export interface DetectedSandbox {
  readonly mode: McpSandboxMode;
  readonly launcher: string | null;
  /** bubblewrap lists `--disable-userns` in its `--help`. */
  readonly disableUserns?: boolean;
}

export interface SandboxDetectDeps {
  readonly platform: NodeJS.Platform;
  /** Whether `file` exists and is executable (macOS: `sandbox-exec`; Linux: `BUBBLEWRAP_PATHS`). */
  readonly exists: (file: string) => Promise<boolean>;
  /** Runs `command args` and answers its exit code and stdout (bounded, with a timeout), or `null` if it can't run. */
  readonly run: (command: string, args: readonly string[]) => Promise<{ readonly code: number | null; readonly stdout: string } | null>;
}

/** The sandbox a command server would get here, detected now (`none` whenever in doubt). */
export async function detectSandbox(deps: SandboxDetectDeps): Promise<DetectedSandbox> {
  try {
    if (deps.platform === 'darwin') return (await deps.exists(MACOS_SANDBOX_EXEC)) ? { mode: 'macos-sandbox', launcher: MACOS_SANDBOX_EXEC } : { mode: 'none', launcher: null };
    if (deps.platform === 'linux') {
      let bwrap: string | null = null;
      for (const candidate of BUBBLEWRAP_PATHS) {
        if (await deps.exists(candidate)) {
          bwrap = candidate;
          break;
        }
      }
      if (bwrap === null) return { mode: 'none', launcher: null };
      const answer = await deps.run(bwrap, ['--version']);
      if (answer === null || answer.code !== 0 || !/^bubblewrap\b/i.test(answer.stdout.trim())) return { mode: 'none', launcher: null };
      const help = await deps.run(bwrap, ['--help']).catch(() => null);
      return { mode: 'bubblewrap', launcher: bwrap, disableUserns: help !== null && /--disable-userns\b/.test(help.stdout) };
    }
  } catch {
    // Detection failed: no sandbox is claimed.
  }
  return { mode: 'none', launcher: null };
}
