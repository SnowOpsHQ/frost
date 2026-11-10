// Spec: specs/location-profiles.spec.ts (locationCredentialSlots, LOCATION_CREDENTIALS_FILE)
// Acceptance: specs/location-profiles.feature.md (Behaviour: a failed sign-in write leaves no half of a sign-in)
// · plan docs/plans/phase-12-big-bets.md, Decision 11, Global constraints "Secrets", Task 10b; council round 1 item 11
import { describe, expect, test } from 'vitest';
import { locationCredentialSlots } from '@app/specs/location-profiles.spec';
import { createFakeSafeStorage, createMemoryFs } from '../../agent/__tests__/fakes';
import { createLocationSecrets } from '../secrets';

const FILE = '/user/location-credentials.json';
const PROFILE = '01920000-0000-7000-8000-000000000d01';

describe('location secrets', () => {
  test('location-credentials-failed-password-write-leaves-no-old-half', async () => {
    const memory = createMemoryFs();
    const safe = createFakeSafeStorage();
    // Armed, the write after `writesLeft` more succeed throws (a disk error).
    let armed = false;
    let writesLeft = 0;
    const fs: typeof memory.fs = {
      ...memory.fs,
      async writeFile(file, data, options) {
        if (armed && writesLeft-- <= 0) {
          armed = false;
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }
        return memory.fs.writeFile(file, data, options);
      },
    };
    let n = 0;
    const secrets = createLocationSecrets({ safeStorage: safe.storage, file: FILE, fs, platform: 'linux', log: () => undefined, tempSuffix: () => `t${(n += 1)}` });
    expect(await secrets.setCredentials(PROFILE, 'old-user', 'old-pass-0123')).toBe('stored');
    const slots = locationCredentialSlots(PROFILE);
    expect(memory.text(FILE)).toContain(slots.password);

    // A new sign-in: the username's write goes through, the password's fails.
    armed = true;
    writesLeft = 1;
    expect(await secrets.setCredentials(PROFILE, 'new-user', 'new-pass-4567')).not.toBe('stored');

    // Neither half is left: not the new username, and not the old password beside nothing.
    expect(await secrets.hasCredentials(PROFILE)).toBe(false);
    const text = memory.text(FILE) ?? '';
    expect(text).not.toContain(slots.username);
    expect(text).not.toContain(slots.password);
  });
});
