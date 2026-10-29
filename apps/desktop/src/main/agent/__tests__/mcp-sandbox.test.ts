// Spec: specs/agent-mcp.spec.ts (MCP_SANDBOX_MODES, MACOS_SANDBOX_EXEC, BUBBLEWRAP_COMMAND)
// Acceptance: specs/agent-mcp.feature.md (Sandboxes, Command servers)
import { describe, expect, test } from 'vitest';
import { bubblewrapArgs, detectSandbox, launchPlan, macosSandboxProfile, resolveCommand, sbplString, serverEnv, type LaunchInput } from '../mcp/sandbox';

const input: LaunchInput = {
  command: '/usr/bin/node',
  args: ['server.js', '--port', '3000'],
  tempDir: '/tmp/frost-mcp-abc',
  home: '/home/me',
  allowNetwork: false,
  readPaths: ['/home/me/servers/docs'],
  pathEnv: '/usr/local/bin:/usr/bin',
  env: { MODE: 'test' },
};

describe('sandbox launch plans', () => {
  test('mcp-bubblewrap-argv-golden', () => {
    expect(bubblewrapArgs(input)).toEqual([
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
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
      '--tmpfs',
      '/home/me',
      '--bind',
      '/tmp/frost-mcp-abc',
      '/tmp/frost-mcp-abc',
      '--ro-bind-try',
      '/home/me/servers/docs',
      '/home/me/servers/docs',
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
  });

  test('mcp-bubblewrap-network-and-home-command', () => {
    const args = bubblewrapArgs({ ...input, allowNetwork: true, command: '/home/me/.local/bin/server', readPaths: [] });
    expect(args.slice(0, 4)).toEqual(['--die-with-parent', '--new-session', '--unshare-all', '--share-net']);
    // Name resolution with the network: systemd-resolved's stub, back over the empty /run.
    expect(args.join(' ')).toContain('--tmpfs /run --tmpfs /home/me --ro-bind-try /run/systemd/resolve /run/systemd/resolve');
    // A command inside the hidden home folder is put back, read-only, by itself.
    expect(args.join(' ')).toContain('--ro-bind /home/me/.local/bin/server /home/me/.local/bin/server');
    // Without the network there is no --share-net at all.
    expect(bubblewrapArgs(input)).not.toContain('--share-net');
    // The command and its arguments come after `--`: an argument can't be read as an option.
    const hostile = bubblewrapArgs({ ...input, args: ['--bind', '/', '/'] });
    expect(hostile.slice(hostile.indexOf('--') + 1)).toEqual(['/usr/bin/node', '--bind', '/', '/']);
  });

  test('mcp-macos-profile-golden', () => {
    expect(macosSandboxProfile(input)).toBe(
      [
        '(version 1)',
        '(deny default)',
        '(allow process-fork)',
        '(allow process-exec (literal "/usr/bin/node") (subpath "/home/me/servers/docs"))',
        '(allow signal (target same-sandbox))',
        '(allow sysctl-read)',
        '(allow file-read*)',
        '(deny file-read* (subpath "/home/me"))',
        '(allow file-read-metadata)',
        '(allow file-read* (literal "/usr/bin/node") (subpath "/tmp/frost-mcp-abc") (subpath "/home/me/servers/docs"))',
        '(allow file-write* (subpath "/tmp/frost-mcp-abc"))',
        '(allow file-write-data (literal "/dev/null"))',
        '',
      ].join('\n'),
    );
    const networked = macosSandboxProfile({ ...input, allowNetwork: true });
    expect(networked).toContain('(allow network-outbound)');
    expect(macosSandboxProfile(input)).not.toContain('network');
    // A quote or backslash in a path can't end the string literal.
    expect(sbplString('/a"b\\c')).toBe('"/a\\"b\\\\c"');
    expect(macosSandboxProfile({ ...input, readPaths: ['/x") (allow default) ("'] })).toContain('(subpath "/x\\") (allow default) (\\"")');
  });

  test('mcp-stdio-launch-minimal-env-and-cwd', () => {
    expect(serverEnv(input)).toEqual({ MODE: 'test', PATH: '/usr/local/bin:/usr/bin', HOME: '/tmp/frost-mcp-abc' });
    // The user's variables never replace PATH or HOME.
    expect(serverEnv({ ...input, env: { PATH: '/evil', HOME: '/evil' } })).toEqual({ PATH: '/usr/local/bin:/usr/bin', HOME: '/tmp/frost-mcp-abc' });
    const none = launchPlan('none', input);
    expect(none).toEqual({ mode: 'none', command: '/usr/bin/node', args: ['server.js', '--port', '3000'], env: serverEnv(input), cwd: '/tmp/frost-mcp-abc', statusFd: false });
    const bwrap = launchPlan('bubblewrap', input, undefined, '/usr/bin/bwrap');
    expect(bwrap).toMatchObject({ mode: 'bubblewrap', command: '/usr/bin/bwrap', cwd: '/tmp/frost-mcp-abc', statusFd: true, env: serverEnv(input) });
    // Secrets travel in the environment, never in the launcher's arguments (which other users may list).
    expect(bwrap.args.join(' ')).not.toContain('test');
    const mac = launchPlan('macos-sandbox', input);
    expect(mac.command).toBe('/usr/bin/sandbox-exec');
    expect(mac.args.slice(0, 1)).toEqual(['-p']);
    expect(mac.args.slice(2)).toEqual(['/usr/bin/node', 'server.js', '--port', '3000']);
    // `n/a` is never a command mode: run as `none`, and reported as `none`.
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
    // A .cmd needs a shell: never looked for.
    expect(resolveCommand('srv.cmd', 'C:\\Tools', 'win32', (file) => file.endsWith('.cmd'))).toBeNull();
  });
});

describe('sandbox detection', () => {
  const run = (code: number | null, stdout: string) => async () => ({ code, stdout });

  test('mcp-sandbox-detected', async () => {
    expect(await detectSandbox({ platform: 'darwin', exists: async (file) => file === '/usr/bin/sandbox-exec', run: run(0, ''), findBubblewrap: () => null })).toEqual({ mode: 'macos-sandbox', launcher: '/usr/bin/sandbox-exec' });
    expect(await detectSandbox({ platform: 'linux', exists: async () => false, run: run(0, 'bubblewrap 0.13.1\n'), findBubblewrap: () => '/usr/bin/bwrap' })).toEqual({ mode: 'bubblewrap', launcher: '/usr/bin/bwrap' });
  });

  test('mcp-sandbox-fallback-reported-as-none', async () => {
    // No launcher, one that fails, or one that answers something else: `none`, never a claimed sandbox.
    expect((await detectSandbox({ platform: 'darwin', exists: async () => false, run: run(0, ''), findBubblewrap: () => null })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'linux', exists: async () => true, run: run(0, ''), findBubblewrap: () => null })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'linux', exists: async () => true, run: run(1, 'bubblewrap 0.13.1'), findBubblewrap: () => '/usr/bin/bwrap' })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'linux', exists: async () => true, run: async () => null, findBubblewrap: () => '/usr/bin/bwrap' })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'linux', exists: async () => true, run: run(0, 'something else'), findBubblewrap: () => '/usr/bin/bwrap' })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'linux', exists: async () => true, run: async () => Promise.reject(new Error('x')), findBubblewrap: () => '/usr/bin/bwrap' })).mode).toBe('none');
    expect((await detectSandbox({ platform: 'win32', exists: async () => true, run: run(0, 'bubblewrap'), findBubblewrap: () => 'bwrap' })).mode).toBe('none');
  });
});
