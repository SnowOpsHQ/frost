// Spec: specs/browse-guard.spec.ts (CERT_ERROR_CODE_RANGE, UNREACHABLE_ERROR_CODES, OFFLINE_ERROR_CODES,
// LOAD_ERROR_TITLES, CRASH_TITLE) · Acceptance: specs/browse-guard.feature.md (Renderer)
import { describe, expect, test } from 'vitest';
import {
  CERT_ERROR_CODE_RANGE,
  CRASH_TITLE,
  INSECURE_RESPONSE_ERROR_CODE,
  LOAD_ERROR_TITLES,
  OFFLINE_ERROR_CODES,
  UNREACHABLE_ERROR_CODES,
} from '@app/specs/browse-guard.spec';
import { crashView, loadErrorClass, loadErrorView } from '../page-error';

const error = (code: number, url = 'https://shop.example.test:8443/cart', description = 'ERR_X') => ({ code, description, url });

describe('page panels', () => {
  test('load-error-copy-by-class', () => {
    for (const code of [CERT_ERROR_CODE_RANGE.min, -202, -201, CERT_ERROR_CODE_RANGE.max, INSECURE_RESPONSE_ERROR_CODE]) {
      expect(loadErrorClass(code), String(code)).toBe('certificate');
    }
    for (const code of UNREACHABLE_ERROR_CODES) expect(loadErrorClass(code), String(code)).toBe('unreachable');
    for (const code of OFFLINE_ERROR_CODES) expect(loadErrorClass(code), String(code)).toBe('offline');
    for (const code of [-2, -199, -300, -310, -500, -1]) expect(loadErrorClass(code), String(code)).toBe('generic');

    const refused = loadErrorView(error(-102, 'http://127.0.0.1:4100/x', 'ERR_CONNECTION_REFUSED'), false);
    expect(refused).toMatchObject({ errorClass: 'unreachable', title: LOAD_ERROR_TITLES.unreachable, detail: 'ERR_CONNECTION_REFUSED' });
    expect(refused.message).toBe('127.0.0.1:4100 refused to connect.');
    expect(loadErrorView(error(-105, 'https://nowhere.test/'), false).message).toContain('nowhere.test');
    expect(loadErrorView(error(-118), false).message).toContain('took too long');

    for (const [code, errorClass] of [
      [-202, 'certificate'],
      [-106, 'offline'],
      [-20, 'generic'],
    ] as const) {
      const view = loadErrorView(error(code), true);
      expect(view.errorClass).toBe(errorClass);
      expect(view.title).toBe(LOAD_ERROR_TITLES[errorClass]);
      expect(view.message, String(code)).toContain('shop.example.test:8443');
    }
    // A URL without a host still reads naturally.
    expect(loadErrorView(error(-20, ''), false).message).toContain('this site');

    expect(crashView('https://a.test/x')).toEqual({ title: CRASH_TITLE, message: expect.stringContaining('a.test') as string });
  });

  test('cert-error-offers-no-proceed', () => {
    for (const code of [-202, -200, -501, -102, -106, -20]) {
      expect(loadErrorView(error(code), false).actions, String(code)).toEqual(['retry']);
      expect(loadErrorView(error(code), true).actions, String(code)).toEqual(['back', 'retry']);
    }
  });
});
