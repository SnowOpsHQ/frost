// Spec: specs/linux-package.spec.ts · Acceptance: specs/linux-package.feature.md (CI)
// Spec: specs/macos-package.spec.ts · Acceptance: specs/macos-package.feature.md (CI)
// Spec: specs/windows-package.spec.ts · Acceptance: specs/windows-package.feature.md (CI)
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { CI_RUNNERS } from '@app/specs/ci-pipeline.spec';
import { LINUX_ARCHS, linuxArtifacts } from '@app/specs/linux-package.spec';
import { MAC_ARCHS, macArtifacts } from '@app/specs/macos-package.spec';
import { WIN_ARCHS, winArtifacts } from '@app/specs/windows-package.spec';
import { CI_WORKFLOW, SETUP_USES, type Job, jobNamed, jobsOf, read, stepNamed } from './workflow-text';

const jobs = jobsOf(read(CI_WORKFLOW));

/** The job's named steps, in order (the unnamed ones are `uses:` steps). */
const names = (job: Job) => job.steps.map((step) => step.name).filter((name) => name !== undefined);

/** Checkout, then the setup action, are the job's first steps after `before`. */
function startsWithSetup(job: Job, before: number) {
  expect(job.steps[before]?.uses, job.id).toMatch(/^actions\/checkout@/);
  expect(job.steps[before + 1]?.uses, job.id).toBe(SETUP_USES);
}

/** A package job does nothing but make and verify: the other jobs lint, test and run the e2e. */
function onlyPackages(job: Job) {
  for (const { run } of job.steps) expect(run ?? '', job.id).not.toMatch(/turbo run|test:e2e|\blint\b|vitest|@app\/desktop build/);
}

describe('CI pipeline (platform packages)', () => {
  test('linux-package-ci-job', () => {
    const job = jobNamed(jobs, 'package-linux');
    expect(job.keys).toMatchObject({ name: 'Package · Linux x64', 'runs-on': CI_RUNNERS.linux });
    startsWithSetup(job, 0);
    expect(names(job)).toEqual([
      'Install packaging tools',
      'Make (AppImage + deb + zip, x64)',
      'Allow unprivileged user namespaces (Chromium sandbox)',
      'Verify package',
      'Upload AppImage + deb',
    ]);
    expect(stepNamed(job.steps, 'Install packaging tools').run).toMatch(/apt-get install .*\bsquashfs-tools\b.*\bunzip\b.*\bxvfb\b/);
    // Packaged once: `make` packages the app itself.
    expect(stepNamed(job.steps, 'Make (AppImage + deb + zip, x64)')).toMatchObject({ id: 'make', run: 'pnpm make:linux' });
    // The sandbox stays on: user namespaces are allowed instead (never --no-sandbox).
    expect(stepNamed(job.steps, 'Allow unprivileged user namespaces (Chromium sandbox)').run).toBe('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0');
    expect(stepNamed(job.steps, 'Verify package')).toMatchObject({ id: 'verify', run: 'xvfb-run -a pnpm verify:linux' });
    onlyPackages(job);

    // Only packages that passed verify:linux are uploaded (run artifacts only; nothing is published).
    const upload = stepNamed(job.steps, 'Upload AppImage + deb');
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}\b/);
    expect(upload.if).toBe("${{ steps.verify.outcome == 'success' }}");
    expect(upload.with).toContain('name: frost-linux-x64');
    for (const arch of LINUX_ARCHS) {
      const { appImage, deb } = linuxArtifacts('0.0.0', arch);
      expect(upload.with).toContain(`apps/desktop/out/${path.posix.dirname(appImage)}/*.AppImage`);
      expect(upload.with).toContain(`apps/desktop/out/${path.posix.dirname(deb)}/*.deb`);
    }
    expect(upload.with).toContain('if-no-files-found: error');
    expect(upload.with).toMatch(/retention-days: 7$/m);
    // The upload is the last step, and no step before it may fail quietly.
    expect(job.steps.at(-1)).toBe(upload);
    for (const step of job.steps) expect(step['continue-on-error'], step.name).toBeUndefined();
  });

  test('macos-ci-job', () => {
    const job = jobNamed(jobs, 'package-macos');
    expect(job.keys).toMatchObject({ name: 'Package · macOS arm64', 'runs-on': CI_RUNNERS.macos });
    expect(CI_RUNNERS.macos).toBe('macos-15'); // arm64
    startsWithSetup(job, 0);
    expect(names(job)).toEqual(['Make (zip + dmg, arm64)', 'Verify package', 'Upload zip + dmg']);
    // Made again, once, only when the DMG maker could not unmount its volume (a runner flake).
    expect(stepNamed(job.steps, 'Make (zip + dmg, arm64)')).toMatchObject({
      id: 'make',
      run: [
        'if ! pnpm make:mac 2>&1 | tee "$RUNNER_TEMP/make.log"; then',
        `grep -q 'hdiutil: detach failed' "$RUNNER_TEMP/make.log" || exit 1`,
        `echo "::warning title=DMG maker retried::hdiutil could not detach the DMG maker's volume; making the packages again."`,
        'pnpm make:mac',
        'fi',
      ].join('\n'),
    });
    expect(stepNamed(job.steps, 'Verify package')).toMatchObject({ id: 'verify', run: 'pnpm verify:mac' });
    onlyPackages(job);
    // Ad-hoc signed: no signing secret reaches the job (specs/macos-package.spec.ts MAC_SIGNING_ENV).
    expect(job.text).not.toMatch(/secrets\.|APPLE_/);

    // Only a package whose bundle and artifacts passed verify:mac is uploaded.
    const upload = stepNamed(job.steps, 'Upload zip + dmg');
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}\b/);
    expect(upload.if).toBe("${{ steps.verify.outcome == 'success' }}");
    expect(upload.with).toContain('name: frost-macos-arm64');
    for (const arch of MAC_ARCHS) {
      const { zip, dmg } = macArtifacts('0.0.0', arch);
      expect(upload.with).toContain(`apps/desktop/out/${path.posix.dirname(zip)}/*.zip`);
      expect(upload.with).toContain(`apps/desktop/out/${path.posix.dirname(dmg)}/*.dmg`);
    }
    expect(upload.with).toContain('if-no-files-found: error');
    expect(upload.with).toMatch(/retention-days: 14$/m);
    expect(job.steps.at(-1)).toBe(upload);
    for (const step of job.steps) expect(step['continue-on-error'], step.name).toBeUndefined();
  });

  test('windows-ci-job', () => {
    const job = jobNamed(jobs, 'package-windows');
    expect(job.keys).toMatchObject({ name: 'Package · Windows x64', 'runs-on': CI_RUNNERS.windows });
    // LF line endings are kept before anything is checked out: the packaged files are the repository's.
    expect(job.steps[0]).toEqual({ name: 'Keep LF line endings', run: 'git config --global core.autocrlf false' });
    startsWithSetup(job, 1);
    expect(names(job)).toEqual(['Keep LF line endings', 'Make (Squirrel + zip, x64)', 'Verify package', 'Upload Setup.exe + zip']);
    expect(stepNamed(job.steps, 'Make (Squirrel + zip, x64)')).toMatchObject({ id: 'make', run: 'pnpm make:win' });
    // Never run with fewer checks in CI (no `--static`).
    expect(stepNamed(job.steps, 'Verify package')).toMatchObject({ id: 'verify', run: 'pnpm verify:win' });
    onlyPackages(job);
    // Unsigned: no signing secret reaches the job.
    expect(job.text).not.toMatch(/secrets\./);

    // Only packages that passed verify:win are uploaded (run artifacts only; nothing is published).
    const upload = stepNamed(job.steps, 'Upload Setup.exe + zip');
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}\b/);
    expect(upload.if).toBe("${{ steps.verify.outcome == 'success' }}");
    expect(upload.with).toContain('name: frost-windows-x64');
    for (const arch of WIN_ARCHS) {
      const { setupExe, zip } = winArtifacts('0.0.0', arch);
      expect(upload.with).toContain(`apps/desktop/out/${path.posix.dirname(setupExe)}/*-setup.exe`);
      expect(upload.with).toContain(`apps/desktop/out/${path.posix.dirname(zip)}/*.zip`);
    }
    expect(upload.with).toContain('if-no-files-found: error');
    expect(upload.with).toMatch(/retention-days: 7$/m);
    expect(job.steps.at(-1)).toBe(upload);
    for (const step of job.steps) expect(step['continue-on-error'], step.name).toBeUndefined();
  });
});
