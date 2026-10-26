import type { PermissionPrompt } from '@app/specs/browser.spec';
import { PERMISSION_PROMPT_ACTIONS, type PromptKind } from '@app/specs/permissions.spec';

// The prompt bar's copy (spec `permissions.feature.md`, Prompt bar): "<host> wants to <action>".

export interface PromptView {
  /** Which icon and sentence: the permission, with `media` named by its devices. */
  readonly kind: PromptKind;
  /** The requesting origin's host, with its port (the origin as given if it does not parse). */
  readonly host: string;
  /** The full requesting origin (the tooltip). */
  readonly origin: string;
  readonly action: string;
}

function kindOf(prompt: Pick<PermissionPrompt, 'permission' | 'mediaTypes'>): PromptKind {
  if (prompt.permission !== 'media') return prompt.permission;
  const types = prompt.mediaTypes ?? [];
  const camera = types.includes('video');
  const microphone = types.includes('audio');
  if (camera && !microphone) return 'camera';
  if (microphone && !camera) return 'microphone';
  return 'camera-microphone';
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export function promptView(prompt: PermissionPrompt): PromptView {
  const kind = kindOf(prompt);
  return { kind, host: hostOf(prompt.origin), origin: prompt.origin, action: PERMISSION_PROMPT_ACTIONS[kind] };
}
