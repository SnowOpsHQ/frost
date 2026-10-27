import { useState } from 'react';
import type { PermissionPrompt } from '@app/specs/browser.spec';
import { PERMISSION_PROMPT_EMBEDDED_IN, PERMISSION_PROMPT_LABELS, type PermissionDecision, type PromptKind } from '@app/specs/permissions.spec';
import { usePromptArmed } from '../hooks/usePromptArmed';
import { BellIcon, CameraIcon, CameraMicrophoneIcon, ClipboardIcon, CloseIcon, LocationIcon, MicrophoneIcon } from '../icons';
import { actions } from '../ipc';
import { promptView } from '../permission-prompt';

// The permission prompt bar of the browser chrome (spec `permissions.feature.md`, Prompt bar).
// Styling is the bundled styles.css only (strict CSP).

const PROMPT_ICONS: Record<PromptKind, typeof BellIcon> = {
  geolocation: LocationIcon,
  notifications: BellIcon,
  camera: CameraIcon,
  microphone: MicrophoneIcon,
  'camera-microphone': CameraMicrophoneIcon,
  'clipboard-read': ClipboardIcon,
};

/**
 * The active tab's permission prompt (`permissions.feature.md`, Prompt bar): a non-modal dialog
 * under the toolbar. It never takes focus from the page; Tab reaches its buttons, Esc inside it
 * dismisses. The page area below shrinks to make room, so the tab's view moves down with it.
 * Allow and Block stay disabled until armed (`PROMPT_ARMING_DELAY_MS`); dismissing only denies,
 * so the × is always live.
 */
export function PromptBar({ prompt, covered }: { readonly prompt: PermissionPrompt; readonly covered: boolean }) {
  const view = promptView(prompt);
  const Icon = PROMPT_ICONS[view.kind];
  const armed = usePromptArmed(covered);
  const [answered, setAnswered] = useState(false);
  const answer = (decision: PermissionDecision) => {
    if (answered || (decision !== 'dismiss' && !armed)) return;
    setAnswered(true);
    void actions.answerPermission(prompt.id, decision).then(() => setAnswered(false));
  };
  return (
    <section
      className="prompt-bar"
      role="dialog"
      aria-modal="false"
      aria-labelledby="permission-prompt-text"
      data-testid="permission-prompt"
      data-permission={view.kind}
      data-origin={view.origin}
      data-top-level-origin={view.embedderOrigin ?? undefined}
      data-armed={armed}
      data-covered={covered}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          answer('dismiss');
        }
      }}
    >
      <span className="prompt-icon" aria-hidden="true">
        <Icon />
      </span>
      <p
        className="prompt-text"
        id="permission-prompt-text"
        data-testid="permission-prompt-text"
        title={view.embedderOrigin === null ? view.origin : `${view.origin} ${PERMISSION_PROMPT_EMBEDDED_IN} ${view.embedderOrigin}`}
      >
        <strong className="prompt-origin" data-testid="permission-prompt-origin">
          {view.host}
        </strong>
        {view.embedderHost !== null ? (
          <span className="prompt-embedder" data-testid="permission-prompt-embedder">
            {' '}
            ({PERMISSION_PROMPT_EMBEDDED_IN} <strong className="prompt-origin">{view.embedderHost}</strong>)
          </span>
        ) : null}{' '}
        wants to {view.action}
      </p>
      <div className="prompt-actions">
        <button type="button" className="prompt-button" data-testid="permission-allow" disabled={answered || !armed} onClick={() => answer('allow')}>
          {PERMISSION_PROMPT_LABELS.allow}
        </button>
        <button type="button" className="prompt-button" data-testid="permission-block" disabled={answered || !armed} onClick={() => answer('block')}>
          {PERMISSION_PROMPT_LABELS.block}
        </button>
      </div>
      <button
        type="button"
        className="prompt-dismiss"
        data-testid="permission-dismiss"
        aria-label={PERMISSION_PROMPT_LABELS.dismiss}
        title={PERMISSION_PROMPT_LABELS.dismiss}
        disabled={answered}
        onClick={() => answer('dismiss')}
      >
        <CloseIcon />
      </button>
    </section>
  );
}
