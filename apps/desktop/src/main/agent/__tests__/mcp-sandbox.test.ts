// Spec: specs/agent-mcp.spec.ts (MCP_SANDBOX_MODES, MACOS_SANDBOX_EXEC, BUBBLEWRAP_PATHS, mcpSandboxSentence)
// Acceptance: specs/agent-mcp.feature.md (Sandboxes, Command servers)
import { describe, expect, test } from 'vitest';
import { bubblewrapArgs, detectSandbox, launchPlan, MACOS_HIDDEN_FOLDERS, macosSandboxProfile, resolveCommand, sbplString, serverEnv, type LaunchInput } from '../mcp/sandbox';

const input: LaunchInput = {
  command: '/usr/bin/node',
  args: ['server.js', '--port', '3000'],
  tempDir: '/tmp/frost-mcp-abc',
  hidden: ['/home/me', '/home/me/.config/frost'],
  allowNetwork: false,
  readPaths: ['/home/me/servers/docs'],
  pathEnv: '/usr/local/bin:/usr/bin',
  env: { MODE: 'test' },
  disableUserns: true,
};

describe('sandbox launch plans', () => {
  test('mcp-bubblewrap-argv-golden', () => {
    expect(bubblewrapArgs(input)).toEqual([
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--unshare-user',
      '--disable-userns',
      '--cap-drop',
      'ALL',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/run',
      // userData lies inside home: hiding home covers it.
      '--tmpfs',
      '/home/me',
      // Listed folders strictly read-only; the server's own folder last.
      '--ro-bind',
      '/home/me/servers/docs',
      '/home/me/servers/docs',
      '--bind',
      '/tmp/frost-mcp-abc',
      '/tmp/frost-mcp-abc',
      '--chdir',
      '/tmp/frost-mcp-abc',
      '--json-status-fd',
      '3',
      '--',
      '/usr/bin/node',
      'server.js',
      '--port',
      '3000',
    ]);
    // Never a writable bind but the server's own folder.
    const args = bubblewrapArgs(input);
    expect(args.filter((arg) => arg === '--bind')).toHaveLength(1);
    expect(args[args.indexOf('--bind') + 1]).toBe(input.tempDir);
    // Without `--disable-userns` support, the flags aren't passed (an older bubblewrap would refuse them).
    expect(bubblewrapArgs({ ...input, disableUserns: false })).not.toContain('--disable-userns');
  });

  test('mcp-bubblewrap-hides-every-home-and-user-data', () => {
    // Two homes (HOME set elsewhere than the account's) and userData outside both: each hidden.
    const args = bubblewrapArgs({ ...input, hidden: ['/home/me', '/srv/me', '/data/frost-profile'], readPaths: [] });
    const tmpfs = args.flatMap((arg, i) => (arg === '--tmpfs' ? [args[i + 1]] : []));
    expect(tmpfs).toEqual(['/tmp', '/run', '/home/me', '/srv/me', '/data/frost-profile']);
  });

  test('mcp-bubblewrap-network-and-home-command', () => {
    const args = bubblewrapArgs({ ...input, allowNetwork: true, command: '/home/me/.local/bin/server', readPaths: [] });
    expect(args.slice(0, 6)).toEqual(['--die-with-parent', '--new-session', '--unshare-all', '--unshare-user', '--disable-userns', '--share-net']);
    // Name resolution with the network: systemd-resolved's stub, back over the empty /run.
    expect(args.join(' ')).toContain('--tmpfs /home/me --ro-bind-try /run/systemd/resolve /run/systemd/resolve');
    // A command inside the hidden home folder is put back, read-only, by itself.
    expect(args.join(' ')).toContain('--ro-bind /home/me/.local/bin/server /home/me/.local/bin/server');
    expect(bubblewrapArgs(input)).not.toContain('--share-net');
    // The command and its arguments come after `--`: an argument can't be read as an option.
    const hostile = bubblewrapArgs({ ...input, args: ['--bind', '/', '/'] });
    expect(hostile.slice(hostile.indexOf('--') + 1)).toEqual(['/usr/bin/node', '--bind', '/', '/']);
  });

  test('mcp-macos-profile-golden', () => {
    const mac: LaunchInput = { ...input, tempDir: '/private/var/folders/ab/xyz/T/frost-mcp-1', hidden: ['/Users/me', '/Users/me/Library/Application Support/frost'], readPaths: ['/Users/me/servers/docs'] };
    expect(macosSandboxProfile(mac)).toBe(
      [
        '(version 1)',
        '(deny default)',
        '(allow process-fork)',
        '(allow process-exec (literal "/usr/bin/node") (subpath "/Users/me/servers/docs"))',
        '(allow signal (target same-sandbox))',
        '(allow sysctl-read)',
        '(allow file-read*)',
        // Other accounts, drives and every temporary folder (other servers', caches) are hidden too.
        '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp"))',
        '(allow file-read-metadata)',
        '(allow file-read* (literal "/usr/bin/node") (subpath "/private/var/folders/ab/xyz/T/frost-mcp-1") (subpath "/Users/me/servers/docs"))',
        '(allow file-write* (subpath "/private/var/folders/ab/xyz/T/frost-mcp-1"))',
        '(allow file-write-data (literal "/dev/null"))',
        '',
      ].join('\n'),
    );
    expect(MACOS_HIDDEN_FOLDERS).toEqual(['/Users', '/Volumes', '/private/var/folders', '/private/tmp']);
    // A home or userData elsewhere is denied by its own path.
    expect(macosSandboxProfile({ ...mac, hidden: ['/opt/home/me', '/Users/me/x'] })).toContain('(subpath "/opt/home/me")');
    const networked = macosSandboxProfile({ ...mac, allowNetwork: true });
    // IP only, plus the DNS socket: never `network-outbound` to any unix socket (agents, docker.sock).
    expect(networked).toContain('(allow network-outbound (remote ip))');
    expect(networked).toContain('(allow network-outbound (literal "/private/var/run/mDNSResponder"))');
    expect(networked).not.toMatch(/\(allow network-outbound\)/);
    expect(macosSandboxProfile(mac)).not.toContain('network');
    // A quote or backslash in a path can't end the string literal.
    expect(sbplString('/a"b\\c')).toBe('"/a\\"b\\\\c"');
    expect(macosSandboxProfile({ ...mac, readPaths: ['/x") (allow default) ("'] })).toContain('(subpath "/x\\") (allow default) (\\"")');
  });

  test('mcp-stdio-launch-minimal-env-and-cwd', () => {
    expect(serverEnv(input)).toEqual({ MODE: 'test', PATH: '/usr/local/bin:/usr/bin', HOME: '/tmp/frost-mcp-abc' });
    // The user's variables never replace PATH or HOME.
    expect(serverEnv({ ...input, env: { PATH: '/evil', HOME: '/evil' } })).toEqual({ PATH: '/usr/local/bin:/usr/bin', HOME: '/tmp/frost-mcp-abc' });
    const none = launchPlan('none', input);
    expect(none).toEqual({ mode: 'none', command: '/usr/bin/node', args: ['server.js', '--port', '3000'], env: serverEnv(input), cwd: '/tmp/frost-mcp-abc', statusFd: false });
    const bwrap = launchPlan('bubblewrap', input);
    // bubblewrap from its fixed system path, never PATH.
    expect(bwrap).toMatchObject({ mode: 'bubblewrap', command: '/usr/bin/bwrap', cwd: '/tmp/frost-mcp-abc', statusFd: true, env: serverEnv(input) });
    // Secrets travel in the environment, never in the launcher's arguments (which other users may list).
    expect(bwrap.args.join(' ')).not.toContain('test');
    const mac = launchPlan('macos-sandbox', input);
    expect(mac.command).toBe('/usr/bin/sandbox-exec');
    expect(mac.args.slice(0, 1)).toEqual(['-p']);
    expect(mac.args.slice(2)).toEqual(['/usr/bin/node', 'server.js', '--port', '3000']);
    expect(launchPlan('n/a', input).mode).toBe('none');
  });

  test('mcp-resolve-command', () => {
    const files = new Set(['/usr/bin/node', '/opt/x/tool', 'C:\\Tools\\srv.exe']);
    const exec = (file: string) => files.has(file);
    expect(resolveCommand('node', '/usr/local/bin:/usr/bin', 'linux', exec)).toBe('/usr/bin/node');
    expect(resolveCommand('/opt/x/tool', '', 'linux', exec)).toBe('/opt/x/tool');
    expect(resolveCommand('tool', 'relative:/usr/bin', 'linux', exec)).toBeNull();
    expect(resolveCommand('missing', '/usr/bin', 'linux', exec)).toBeNull();
    expect(resolveCommand('./node', '/usr/bin', 'linux', exec)).toBeNull();
    expect(resolveCommand('srv', 'C:\\Tools', 'win32', exec)).toBe('C:\\Tools\\srv.exe');
    expect(resolveCommand('srv.cmd', 'C:\\Tools', 'win32', (file) => file.endsWith('.cmd'))).toBeNull();
  });
});

describe('sandbox detection', () => {
  const runs = (answers: Record<string, { code: number | null; stdout: string } | null>) => async (_command: string, args: readonly string[]) => answers[args[0]!] ?? null;
  const at = (...files: string[]) => async (file: string) => files.includes(file);

  test('mcp-sandbox-detected', async () => {
    expect(await detectSandbox({ platform: 'darwin', exists: at('/usr/bin/sandbox-exec'), run: runs({}) })).toEqual({ mode: 'macos-sandbox', launcher: '/usr/bin/sandbox-exec' });
    expect(await detectSandbox({ platform: 'linux', exists: at('/usr/bin/bwrap'), run: runs({ '--version': { code: 0, stdout: 'bubblewrap 0.13.1\n' }, '--help': { code: 0, stdout: '  --disable-userns  Disable…' } }) })).toEqual({
      mode: 'bubblewrap',
      launcher: '/usr/bin/bwrap',
      disableUserns: true,
    });
    expect(await detectSandbox({ platform: 'linux', exists: at('/bin/bwrap'), run: runs({ '--version': { code: 0, stdout: 'bubblewrap 0.4.0' }, '--help': { code: 0, stdout: '--unshare-all' } }) })).toEqual({
      mode: 'bubblewrap',
      launcher: '/bin/bwrap',
      disableUserns: false,
    });
  });

  test('mcp-sandbox-fallback-reported-as-none', async () => {
    const ok = { '--version': { code: 0, stdout: 'bubblewrap 0.13.1' } };
    expect((await detectSandbox({ platform: 'darwin', exists: at(), run: runs(ok) })).mode).toBe('none');
    // Only the fixed system paths: a `bwrap` elsewhere (on PATH, in home) is never used.
    expect((await detectSandbox({ platform: 'linux', exists: at('/home/me/bin/bwrap', '/usr/local/bin/bwrap'), run: runs(ok) })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'linux', exists: at('/usr/bin/bwrap'), run: runs({ '--version': { code: 1, stdout: 'bubblewrap 0.13.1' } }) })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'linux', exists: at('/usr/bin/bwrap'), run: runs({}) })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'linux', exists: at('/usr/bin/bwrap'), run: runs({ '--version': { code: 0, stdout: 'something else' } }) })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'linux', exists: at('/usr/bin/bwrap'), run: async () => Promise.reject(new Error('x')) })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'win32', exists: at('/usr/bin/bwrap'), run: runs(ok) })).mode).toBe('none');
  });
});
