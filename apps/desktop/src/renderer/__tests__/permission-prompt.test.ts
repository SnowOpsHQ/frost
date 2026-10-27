// Spec: specs/permissions.spec.ts (PERMISSION_PROMPT_ACTIONS) · Acceptance: specs/permissions.feature.md (Renderer)
import { describe, expect, test } from 'vitest';
import { PERMISSION_PROMPT_ACTIONS } from '@app/specs/permissions.spec';
import { promptView } from '../permission-prompt';

const ID = '0f8b2f63-3b7e-4b0e-9d43-7f1f0d6f2a11';

describe('permission prompt', () => {
  test('prompt-copy-per-permission', () => {
    const view = (
      permission: 'geolocation' | 'notifications' | 'media' | 'clipboard-read',
      mediaTypes?: ('video' | 'audio')[],
      origin = 'https://maps.example',
      topLevelOrigin: string | null = null,
    ) => promptView({ id: ID, origin, topLevelOrigin, permission, ...(mediaTypes ? { mediaTypes } : {}) });

    expect(view('geolocation')).toEqual({
      kind: 'geolocation',
      host: 'maps.example',
      origin: 'https://maps.example',
      embedderHost: null,
      embedderOrigin: null,
      action: 'use your location',
    });
    // An embedded requester names the top-level site too.
    expect(view('geolocation', undefined, 'https://widget.example', 'https://site.example:8443')).toMatchObject({
      host: 'widget.example',
      embedderHost: 'site.example:8443',
      embedderOrigin: 'https://site.example:8443',
    });
    expect(view('notifications').action).toBe(PERMISSION_PROMPT_ACTIONS.notifications);
    expect(view('clipboard-read').action).toBe(PERMISSION_PROMPT_ACTIONS['clipboard-read']);
    expect(view('media', ['video'])).toMatchObject({ kind: 'camera', action: 'use your camera' });
    expect(view('media', ['audio'])).toMatchObject({ kind: 'microphone', action: 'use your microphone' });
    expect(view('media', ['video', 'audio'])).toMatchObject({ kind: 'camera-microphone', action: 'use your camera and microphone' });
    expect(view('media', ['audio', 'video']).kind).toBe('camera-microphone');
    // The host keeps its port; the full origin is kept for the tooltip.
    expect(view('notifications', undefined, 'http://127.0.0.1:8080')).toMatchObject({ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' });
    // Something unparsable is shown as given rather than hidden.
    expect(view('notifications', undefined, 'weird').host).toBe('weird');
  });
});
