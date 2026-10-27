// Spec: specs/render-profile.spec.ts (MAX_RENDER_PROFILE_PINS, DEFAULT_RENDER_PROFILE), specs/render-profile.schema.spec.ts (RenderProfileSchema)
// Acceptance: specs/render-profile.feature.md (Scope and lifetime: Pin to this site)
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_RENDER_PROFILE, MAX_RENDER_PROFILE_PINS, type RenderProfile } from '@app/specs/render-profile.spec';
import { createDrizzle } from '../client';
import { runMigrations } from '../migrations';
import { createSessionRepository, type SessionRepository } from '../repository';
import { createSessionWriter } from '../writer';

let raw: DatabaseSync;
let repo: SessionRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  repo = createSessionRepository(createDrizzle(raw));
});

const phoneBot: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
const noJs: RenderProfile = { ...DEFAULT_RENDER_PROFILE, javascriptDisabled: true, network: 'slow-3g' };

describe('render-profile pins', () => {
  test('render-profile-pins-roundtrip', async () => {
    await repo.saveRenderProfilePin('https://a.example', phoneBot, 1);
    await repo.saveRenderProfilePin('http://127.0.0.1:8080', noJs, 2);
    // Oldest first.
    expect(await repo.loadRenderProfilePins()).toEqual([
      { origin: 'https://a.example', profile: phoneBot },
      { origin: 'http://127.0.0.1:8080', profile: noJs },
    ]);
    // Pinning again replaces the profile and makes it the newest.
    await repo.saveRenderProfilePin('https://a.example', noJs, 3);
    expect(await repo.loadRenderProfilePins()).toEqual([
      { origin: 'http://127.0.0.1:8080', profile: noJs },
      { origin: 'https://a.example', profile: noJs },
    ]);
    await repo.deleteRenderProfilePin('http://127.0.0.1:8080');
    expect(await repo.loadRenderProfilePins()).toEqual([{ origin: 'https://a.example', profile: noJs }]);
  });

  test('render-profile-pins-only-valid', async () => {
    // Not an origin, or not a profile: never stored.
    await repo.saveRenderProfilePin('https://a.example/path', phoneBot, 1);
    await repo.saveRenderProfilePin('file:///etc', phoneBot, 1);
    await repo.saveRenderProfilePin('https://b.example', { ...phoneBot, customUserAgent: 'x' }, 1);
    await repo.saveRenderProfilePin('https://c.example', DEFAULT_RENDER_PROFILE, 1);
    expect(await repo.loadRenderProfilePins()).toEqual([]);
  });

  test('tampered-pin-rows-skipped', async () => {
    const insert = raw.prepare('INSERT INTO render_profile_pins (origin, profile, updated_at) VALUES (?, ?, ?)');
    insert.run('https://ok.example', JSON.stringify(phoneBot), 1);
    insert.run('https://json.example', '{not json', 2);
    insert.run('https://shape.example', JSON.stringify({ ...phoneBot, extra: 1 }), 3);
    insert.run('https://ua.example', JSON.stringify({ ...phoneBot, userAgent: 'custom', customUserAgent: 'bad\u0007ua' }), 4);
    insert.run('not an origin', JSON.stringify(phoneBot), 5);
    insert.run('https://huge.example', JSON.stringify({ ...phoneBot, pad: 'x'.repeat(100_000) }), 6);
    expect(await repo.loadRenderProfilePins()).toEqual([{ origin: 'https://ok.example', profile: phoneBot }]);
  });

  test('render-profile-pins-capped', async () => {
    for (let i = 0; i < MAX_RENDER_PROFILE_PINS + 5; i++) await repo.saveRenderProfilePin(`https://s${i}.example`, phoneBot, i);
    const pins = await repo.loadRenderProfilePins();
    expect(pins).toHaveLength(MAX_RENDER_PROFILE_PINS);
    // The oldest went.
    expect(pins[0]!.origin).toBe('https://s5.example');
  });

  test('clear-browsing-data-forgets-pins', async () => {
    await repo.saveRenderProfilePin('https://a.example', phoneBot, 1);
    await repo.clearBrowsingData();
    expect(await repo.loadRenderProfilePins()).toEqual([]);
  });

  test('pins-written-at-once', async () => {
    const writer = createSessionWriter(repo, { now: () => 7, setTimer: () => 0, clearTimer: () => undefined });
    writer.saveRenderProfilePin('https://a.example', phoneBot);
    await writer.flush();
    expect(await repo.loadRenderProfilePins()).toEqual([{ origin: 'https://a.example', profile: phoneBot }]);
    writer.deleteRenderProfilePin('https://a.example');
    await writer.flush();
    expect(await repo.loadRenderProfilePins()).toEqual([]);
  });
});
