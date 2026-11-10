// Spec: specs/screenshot.spec.ts (SCREENSHOT_EDIT_LIMITS, SCREENSHOT_EDIT_RESULTS, SCREENSHOT_OVERLAY_PREFIX,
// SaveScreenshotEditInput, ScreenshotEntry.editedFrom), specs/screenshot.schema.ts (ScreenshotsAnswerSchema),
// specs/capture-db.spec.ts (SCREENSHOT_EDIT_TABLES)
// Acceptance: specs/screenshot.feature.md (Editing; Scenarios overlay-must-match-crop-size,
// composite-alpha-over-source, source-unchanged-new-hash-and-row, oversize-overlay-refused,
// missing-or-changed-source-no-source, crop-outside-source-invalid, edit-row-links-source, edit-does-not-purge-its-source,
// save-edit-one-at-a-time)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { canonicalJson } from '@app/change-intel';
import { DEFAULT_RENDER_PROFILE } from '@app/specs/render-profile.spec';
import { SCREENSHOT_LIMITS, SCREENSHOT_OVERLAY_PREFIX, ScreenshotsAnswerSchema, type SaveScreenshotEditInput, type ScreenshotEditOp } from '@app/specs/screenshot.schema';
import { compositeEdit, compositeOver, opaqueBounds, pngSize, rectInside } from '../composite';
import { overlayBytes, saveScreenshotEdit } from '../edit';
import type { Bitmap } from '../stitch';
import { documentRows, fakePng, serviceSetup, type ServiceSetup } from './fakes';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let setup: ServiceSetup | null = null;
afterEach(async () => {
  const done = setup;
  setup = null;
  await done?.cleanup();
});
const start = (deps: Parameters<typeof serviceSetup>[0] = {}) => (setup = serviceSetup(deps));

/** A `width` × `height` bitmap, every pixel `pixel` (BGRA, premultiplied). */
const filled = (width: number, height: number, pixel: readonly number[] = [0, 0, 0, 0]): Bitmap => {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) bitmap.set(pixel, i * 4);
  return { bitmap, width, height };
};
const pixelAt = (bitmap: Bitmap, x: number, y: number): number[] => [...bitmap.bitmap.subarray((y * bitmap.width + x) * 4, (y * bitmap.width + x) * 4 + 4)];
/** `bitmap` with `pixel` over the rectangle. */
const paint = (bitmap: Bitmap, rect: { x: number; y: number; width: number; height: number }, pixel: readonly number[]): Bitmap => {
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) bitmap.bitmap.set(pixel, (y * bitmap.width + x) * 4);
  return bitmap;
};
const dataUrl = (png: Buffer) => `${SCREENSHOT_OVERLAY_PREFIX}${png.toString('base64')}`;
const BOX: ScreenshotEditOp = { tool: 'box', color: '#e5484d', size: 2, rect: { x: 12, y: 22, width: 4, height: 3 }, filled: true };
const RED = [0x4d, 0x48, 0xe5, 255];

/** A viewport screenshot of the fake tab (230 × 160 device px, each row coded with its document row). */
async function source(s: ServiceSetup): Promise<{ id: string; sha256: string; png: Buffer; row: Record<string, unknown> }> {
  const taken = await s.service.take(1, { kind: 'viewport' });
  if (taken.status !== 'saved') throw new Error(`refused: ${taken.reason}`);
  const row = s.raw.prepare('SELECT * FROM ci_screenshots WHERE id = ?').get(taken.id) as Record<string, unknown>;
  const sha256 = String(row['sha256']);
  return { id: taken.id, sha256, png: readFileSync(s.files.fileFor(sha256)), row: { ...row } };
}
/** An edit of `sourceId`: a crop and an overlay with one red box (in crop pixels). */
function edit(sourceId: string, crop: SaveScreenshotEditInput['crop'] = { x: 10, y: 20, width: 40, height: 30 }, overlay?: Buffer): SaveScreenshotEditInput {
  const size = crop ?? { width: 230, height: 160 };
  return { sourceId, crop, overlay: dataUrl(overlay ?? fakePng(paint(filled(size.width, size.height), { x: 2, y: 2, width: 4, height: 3 }, RED))), ops: [BOX] };
}
const shotRows = (s: ServiceSetup) => s.raw.prepare('SELECT * FROM ci_screenshots ORDER BY created_at').all().map((row) => ({ ...row }));
const editRows = (s: ServiceSetup) => s.raw.prepare('SELECT * FROM screenshot_edits').all().map((row) => ({ ...row }));
const fileNames = (s: ServiceSetup) => readdirSync(s.files.dir).sort();

describe('screenshot edits', () => {
  test('composite-alpha-over-source', () => {
    // Pure, premultiplied BGRA "source over": transparent leaves the base, opaque replaces it, half alpha blends.
    const base = filled(4, 3, [200, 100, 50, 255]);
    const overlay = filled(4, 3);
    overlay.bitmap.set([10, 20, 30, 255], (1 * 4 + 1) * 4);
    overlay.bitmap.set([0, 0, 128, 128], (1 * 4 + 2) * 4);
    expect(opaqueBounds(overlay)).toEqual({ x: 1, y: 1, width: 2, height: 1 });
    expect(opaqueBounds(filled(3, 3))).toBeNull();
    expect(compositeOver(base, overlay)).toBe(true);
    expect(pixelAt(base, 1, 1)).toEqual([10, 20, 30, 255]);
    // 200 × 127/255 ≈ 100, 100 × 127/255 ≈ 50, 128 + 50 × 127/255 ≈ 153, alpha 128 + 127.
    expect(pixelAt(base, 2, 1)).toEqual([100, 50, 153, 255]);
    for (const [x, y] of [[0, 0], [3, 2], [0, 1], [3, 1], [2, 0]] as const) expect(pixelAt(base, x, y), `${x},${y}`).toEqual([200, 100, 50, 255]);
    // A transparent base takes the overlay as it is; channels never pass 255.
    const clear = filled(1, 1);
    compositeOver(clear, filled(1, 1, [0, 0, 128, 128]));
    expect(pixelAt(clear, 0, 0)).toEqual([0, 0, 128, 128]);
    const bright = filled(1, 1, [255, 255, 255, 255]);
    compositeOver(bright, filled(1, 1, [255, 0, 0, 200]));
    expect(pixelAt(bright, 0, 0)[0]).toBe(255);
    // Sizes must agree; nothing changes otherwise.
    const untouched = filled(2, 2, [1, 2, 3, 255]);
    expect(compositeOver(untouched, filled(2, 3, [9, 9, 9, 255]))).toBe(false);
    expect(compositeOver(untouched, { bitmap: Buffer.alloc(4), width: 2, height: 2 })).toBe(false);
    expect(untouched.bitmap).toEqual(filled(2, 2, [1, 2, 3, 255]).bitmap);

    // Cropped first: rows of the source's document, the overlay over the crop; the source buffer is not touched by a crop.
    const shot: Bitmap = { bitmap: documentRows(20, 10, 0), width: 20, height: 10 };
    const before = Buffer.from(shot.bitmap);
    const out = compositeEdit(shot, { x: 5, y: 3, width: 6, height: 4 }, paint(filled(6, 4), { x: 0, y: 0, width: 1, height: 1 }, [1, 2, 3, 255]))!;
    expect(out).toMatchObject({ width: 6, height: 4 });
    expect(pixelAt(out, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(pixelAt(out, 1, 0)).toEqual([3, 0, 9, 255]);
    expect(pixelAt(out, 5, 3)).toEqual([6, 0, 9, 255]);
    expect(shot.bitmap).toEqual(before);
    // Without a crop the overlay is the whole source's size.
    expect(compositeEdit(shot, null, filled(20, 10))).toMatchObject({ width: 20, height: 10 });
    expect(compositeEdit(shot, null, filled(6, 4))).toBeNull();
    expect(compositeEdit(shot, { x: 15, y: 0, width: 6, height: 4 }, filled(6, 4))).toBeNull();
  });

  test('overlay-must-match-crop-size', async () => {
    // The header is read without decoding; only a PNG header counts.
    expect(pngSize(fakePng(filled(7, 5)))).toEqual({ width: 7, height: 5 });
    expect(pngSize(Buffer.from('GIF89a'.padEnd(40, ' ')))).toBeNull();
    expect(pngSize(fakePng(filled(7, 5)).subarray(0, 20))).toBeNull();
    expect(overlayBytes('data:image/jpeg;base64,AAAA', 100)).toBe('invalid');
    expect(overlayBytes(`${SCREENSHOT_OVERLAY_PREFIX}AA AA`, 100)).toBe('invalid');

    const s = start();
    const { id } = await source(s);
    const decodedBefore = s.imaging.decoded;
    const crop = { x: 10, y: 20, width: 40, height: 30 };
    // A header naming another size (bigger, smaller, the whole shot for a crop) is refused before any decode.
    for (const header of [{ width: 41, height: 30 }, { width: 40, height: 29 }, { width: 230, height: 160 }, { width: 100_000, height: 100_000 }]) {
      expect(await s.service.saveEdit(edit(id, crop, fakePng(filled(40, 30), header))), JSON.stringify(header)).toEqual({ status: 'invalid' });
    }
    // Not a PNG at all.
    expect(await s.service.saveEdit({ ...edit(id, crop), overlay: dataUrl(Buffer.from('not a png, just text that is long enough')) })).toEqual({ status: 'invalid' });
    expect(s.imaging.decoded).toBe(decodedBefore);
    // The right header but bytes that do not decode to it.
    expect(await s.service.saveEdit(edit(id, crop, fakePng(filled(40, 29), { width: 40, height: 30 })))).toEqual({ status: 'invalid' });
    // Without a crop, the overlay is the whole screenshot's size.
    expect(await s.service.saveEdit(edit(id, null, fakePng(filled(40, 30))))).toEqual({ status: 'invalid' });
    expect(shotRows(s)).toHaveLength(1);
    expect(await s.service.saveEdit(edit(id, null))).toMatchObject({ status: 'saved', width: 230, height: 160 });
    expect(await s.service.saveEdit(edit(id, crop))).toMatchObject({ status: 'saved', width: 40, height: 30 });
    expect(shotRows(s)).toHaveLength(3);
  });

  test('source-unchanged-new-hash-and-row', async () => {
    const s = start();
    s.state.profiles.set(1, { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' });
    const project = await s.opened.changeIntel.createProject('Tea', Date.now());
    const taken = await s.service.take(1, { kind: 'viewport', projectId: project!.id });
    if (taken.status !== 'saved') throw new Error('not taken');
    const row = { ...(s.raw.prepare('SELECT * FROM ci_screenshots').get() as Record<string, unknown>) };
    const sourceFile = s.files.fileFor(String(row['sha256']));
    const sourceBytes = readFileSync(sourceFile);
    const files = fileNames(s);

    const answer = await s.service.saveEdit(edit(taken.id));
    if (answer.status !== 'saved') throw new Error(answer.status);
    expect(answer).toMatchObject({ width: 40, height: 30 });
    expect(answer.id).not.toBe(taken.id);
    // The source's bytes and row are as they were.
    expect(readFileSync(sourceFile)).toEqual(sourceBytes);
    const [first, second] = shotRows(s);
    expect(first).toEqual(row);
    // A new hash-named file: the composite, encoded again (never the overlay as sent).
    const added = fileNames(s).filter((name) => !files.includes(name));
    expect(added).toHaveLength(1);
    const written = readFileSync(s.files.fileFor(added[0]!.slice(0, 64)));
    expect(added[0]).toBe(`${sha(written)}.png`);
    expect(second).toMatchObject({ sha256: sha(written), bytes: written.length, width: 40, height: 30 });
    // The row: the source's project, page, kind, area, segments, profile and search parameters; no capture.
    for (const key of ['project_id', 'page_url', 'kind', 'rect', 'segments', 'render_profile', 'search_params']) expect(second![key], key).toEqual(row[key]);
    expect(second).toMatchObject({ id: answer.id, capture_id: null });
    expect(second!['sha256']).not.toBe(row['sha256']);
    // The pixels: the source's rows 20…49, columns 10…49, the red box over (12…15, 22…24).
    const composite = s.imaging.encoded.at(-1)!;
    expect(composite).toMatchObject({ width: 40, height: 30 });
    expect(pixelAt(composite, 0, 0)).toEqual([20, 0, 9, 255]);
    expect(pixelAt(composite, 39, 29)).toEqual([49, 0, 9, 255]);
    expect(pixelAt(composite, 2, 2)).toEqual(RED);
    expect(pixelAt(composite, 5, 4)).toEqual(RED);
    expect(pixelAt(composite, 6, 4)).toEqual([24, 0, 9, 255]);
    // Its thumbnail was made from the bitmap in hand, and the copy lists first.
    expect(await s.service.image(answer.id, 'thumb')).toBe(`data:image/png;base64,${Buffer.from('thumb:PNG 40x30').toString('base64')}`);
    expect((await s.service.list({ projectId: project!.id })).screenshots.map((shot) => shot.id)).toEqual([answer.id, taken.id]);
  });

  test('oversize-overlay-refused', async () => {
    const s = start({ editLimits: { maxOverlayBytes: 1_000 } });
    const { id } = await source(s);
    const files = fileNames(s);
    // 40 × 30 × 4 + 33 bytes is over 1,000: refused from the base64's length, then from the bytes.
    expect(overlayBytes(dataUrl(Buffer.alloc(1_001)), 1_000)).toBe('too-large');
    expect(overlayBytes(dataUrl(Buffer.alloc(1_000)), 1_000)).toEqual(Buffer.alloc(1_000));
    expect(await s.service.saveEdit(edit(id))).toEqual({ status: 'too-large' });
    expect(await s.service.saveEdit(edit(id, { x: 0, y: 0, width: 15, height: 20 }, fakePng(filled(15, 20))))).toEqual({ status: 'too-large' });
    expect(await s.service.saveEdit(edit(id, { x: 0, y: 0, width: 10, height: 10 }, fakePng(filled(10, 10))))).toMatchObject({ status: 'saved' });
    // A result over `maxPngBytes` is refused too, and nothing is written for it.
    const encode = s.imaging.encodePng;
    s.imaging.encodePng = () => Buffer.alloc(SCREENSHOT_LIMITS.maxPngBytes + 1);
    expect(await s.service.saveEdit(edit(id, { x: 0, y: 0, width: 10, height: 10 }, fakePng(filled(10, 10))))).toEqual({ status: 'too-large' });
    s.imaging.encodePng = encode;
    expect(shotRows(s)).toHaveLength(2);
    expect(fileNames(s)).toHaveLength(files.length + 1);
    expect(s.logs.some((line) => line.includes('over its cap'))).toBe(true);
  });

  test('missing-or-changed-source-no-source', async () => {
    const s = start();
    // No such screenshot.
    expect(await s.service.saveEdit(edit('01920000-0000-7000-8000-000000000001'))).toEqual({ status: 'no-source' });
    const { id, sha256, png } = await source(s);
    const file = s.files.fileFor(sha256);
    // Its file changed on disk: the hash no longer matches.
    writeFileSync(file, Buffer.concat([png, Buffer.from('x')]));
    expect(await s.service.saveEdit(edit(id))).toEqual({ status: 'no-source' });
    // Its file gone.
    unlinkSync(file);
    expect(await s.service.saveEdit(edit(id))).toEqual({ status: 'no-source' });
    writeFileSync(file, png);
    expect(await s.service.saveEdit(edit(id))).toMatchObject({ status: 'saved' });
    // A file that does not decode to the row's size.
    const decode = s.imaging.decode;
    s.imaging.decode = (bytes, expected) => (bytes.equals(png) ? null : decode(bytes, expected));
    expect(await s.service.saveEdit(edit(id))).toEqual({ status: 'no-source' });
    s.imaging.decode = decode;

    // Purged (here: its project deleted) while the edit was being saved: no row, `no-source`.
    const store = s.opened.changeIntel;
    const project = await store.createProject('Going', Date.now());
    const taken = await s.service.take(1, { kind: 'viewport', projectId: project!.id });
    if (taken.status !== 'saved') throw new Error('not taken');
    const racing = { ...store, appendScreenshotEdit: async (input: Parameters<typeof store.appendScreenshotEdit>[0]) => (await store.tombstoneProject(project!.id, Date.now()), store.appendScreenshotEdit(input)) };
    const answer = await saveScreenshotEdit(
      { store: racing, files: s.files, imaging: s.imaging, limits: SCREENSHOT_LIMITS, now: Date.now, uuid: () => '01920000-0000-7000-8000-0000000000ff', log: () => undefined, thumbnail: () => undefined, saved: () => undefined },
      edit(taken.id),
    );
    expect(answer).toEqual({ status: 'no-source' });
    expect(shotRows(s).filter((row) => row['project_id'] === project!.id)).toHaveLength(1);
    expect(editRows(s)).toHaveLength(1);
  });

  test('crop-outside-source-invalid', async () => {
    const s = start();
    const { id } = await source(s);
    expect(rectInside({ x: 0, y: 0, width: 230, height: 160 }, 230, 160)).toBe(true);
    const files = fileNames(s);
    for (const crop of [
      { x: 200, y: 0, width: 31, height: 10 },
      { x: 0, y: 150, width: 10, height: 11 },
      { x: 230, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 231, height: 160 },
      { x: 1.5, y: 0, width: 10, height: 10 },
    ]) {
      expect(rectInside(crop, 230, 160), JSON.stringify(crop)).toBe(false);
      expect(await s.service.saveEdit(edit(id, crop, fakePng(filled(Math.ceil(crop.width), Math.ceil(crop.height))))), JSON.stringify(crop)).toEqual({ status: 'invalid' });
    }
    expect(shotRows(s)).toHaveLength(1);
    expect(fileNames(s)).toEqual(files);
  });

  test('edit-row-links-source', async () => {
    const s = start();
    const { id } = await source(s);
    const input = edit(id);
    const answer = await s.service.saveEdit(input);
    if (answer.status !== 'saved') throw new Error(answer.status);
    const [link] = editRows(s);
    expect(link).toEqual({ screenshot_id: answer.id, source_id: id, crop: canonicalJson(input.crop), ops: canonicalJson(input.ops), created_at: shotRows(s)[1]!['created_at'] });
    // Listed with `editedFrom`: the copy names its source; the source names none.
    const listed = await s.service.list({ url: 'https://example.com/page' });
    expect(ScreenshotsAnswerSchema.safeParse(listed).success).toBe(true);
    expect(listed.screenshots.map((shot) => [shot.id, shot.editedFrom])).toEqual([
      [answer.id, id],
      [id, null],
    ]);
    // An edit of the edit links to the copy.
    const again = await s.service.saveEdit(edit(answer.id, { x: 0, y: 0, width: 10, height: 10 }, fakePng(filled(10, 10))));
    if (again.status !== 'saved') throw new Error(again.status);
    expect(editRows(s).find((row) => row['screenshot_id'] === again.id)).toMatchObject({ source_id: answer.id, ops: canonicalJson([BOX]) });
  });

  test('edit-does-not-purge-its-source', async () => {
    const s = start();
    const store = s.opened.changeIntel;
    const project = (await store.createProject('Kept', Date.now()))!;
    expect(await store.setRetention(project.id, 'versions', 1, Date.now())).toBe(true);
    // Retention runs after each save, as main's does (`retention.ts`, on `onSaved`).
    const enforce = async () => {
      const plan = await store.planPurge({ projectId: project.id, policy: { mode: 'versions', value: 1 }, now: Date.now() });
      if (plan && plan.screenshotIds.length > 0) await store.executePurge(plan, 'retention', Date.now());
    };
    const taken = await s.service.take(1, { kind: 'viewport', projectId: project.id });
    if (taken.status !== 'saved') throw new Error('not taken');
    await enforce();
    const first = await s.service.saveEdit(edit(taken.id));
    if (first.status !== 'saved') throw new Error(first.status);
    await enforce();
    // Versions = 1: the source and its copy are both kept (copies are a lane of their own).
    expect(shotRows(s).map((row) => row['id'])).toEqual([taken.id, first.id]);
    // A second copy of the same lane pushes out only the older copy.
    const second = await s.service.saveEdit(edit(taken.id, { x: 0, y: 0, width: 10, height: 10 }, fakePng(filled(10, 10))));
    if (second.status !== 'saved') throw new Error(second.status);
    await enforce();
    expect(shotRows(s).map((row) => row['id'])).toEqual([taken.id, second.id]);
    expect(editRows(s).map((row) => [row['screenshot_id'], row['source_id']])).toEqual([[second.id, taken.id]]);
  });

  test('save-edit-one-at-a-time', async () => {
    const s = start();
    const { id } = await source(s);
    // A second call while one is being saved answers `busy`; once it is done, edits go on.
    const running = s.service.saveEdit(edit(id));
    expect(await s.service.saveEdit(edit(id))).toEqual({ status: 'busy' });
    expect(await running).toMatchObject({ status: 'saved' });
    expect(await s.service.saveEdit(edit(id))).toMatchObject({ status: 'saved' });
    // A refused edit frees it too.
    expect(await s.service.saveEdit(edit(id, { x: 999, y: 0, width: 5, height: 5 }, fakePng(filled(5, 5))))).toEqual({ status: 'invalid' });
    expect(await s.service.saveEdit(edit(id))).toMatchObject({ status: 'saved' });
    expect(shotRows(s)).toHaveLength(4);
  });
});
