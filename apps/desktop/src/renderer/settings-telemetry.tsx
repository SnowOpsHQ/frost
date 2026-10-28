import { useState } from 'react';
import type { TelemetryChannel } from '@app/specs/telemetry-privacy.spec';
import { useTelemetryState } from './settings-hooks';
import { telemetrySection } from './settings-telemetry-view';

// The Settings view's Telemetry section (Phase 4 Task 9; acceptance `account-settings.feature.md`;
// review focus "Telemetry UI matches behaviour"): two switches showing main's consent. A click asks
// main (`telemetry.setConsent`); the switch shows what main answers, never the click's guess.

export function TelemetrySettings() {
  const [state, setConsent] = useTelemetryState();
  const [busy, setBusy] = useState<TelemetryChannel | null>(null);
  const section = telemetrySection(state);
  const toggle = (channel: TelemetryChannel, on: boolean) => {
    setBusy(channel);
    void setConsent(channel, on).finally(() => setBusy(null));
  };
  return (
    <div className="settings-telemetry" data-testid="telemetry-section">
      <p className="settings-text">{section.intro}</p>
      <ul className="settings-toggles">
        {section.toggles.map((item) => (
          <li key={item.channel} className="settings-toggle">
            <div className="settings-toggle-text">
              <span className="settings-toggle-label" id={`telemetry-${item.channel}-label`}>
                {item.label}
              </span>
              <span className="settings-muted" id={`telemetry-${item.channel}-description`}>
                {item.sends} {item.never}
              </span>
              {item.note ? <span className="settings-notice">{item.note}</span> : null}
            </div>
            <button
              type="button"
              role="switch"
              className="settings-switch"
              data-testid={`telemetry-toggle-${item.channel}`}
              aria-checked={item.on}
              aria-labelledby={`telemetry-${item.channel}-label`}
              aria-describedby={`telemetry-${item.channel}-description`}
              disabled={!section.ready || busy !== null}
              onClick={() => toggle(item.channel, !item.on)}
            >
              <span className="settings-switch-knob" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {section.runOnly ? (
        <p className="settings-notice" role="status" data-testid="telemetry-run-only">
          {section.runOnly}
        </p>
      ) : null}
    </div>
  );
}
