// Acceptance: specs/gsc.feature.md (Redaction) · plan Global Constraint "Logs never carry secrets"
import { describe, expect, test } from 'vitest';
import { createRedactingLog } from '../redact';

describe('Search Console log redaction', () => {
  test('redactor-keeps-long-lived-secrets', () => {
    const logs: string[] = [];
    const { log, remember, pin } = createRedactingLog((message) => logs.push(message));
    pin('test-client-secret', 'fake-refresh-token-0123');
    for (let i = 0; i < 500; i++) remember(`recent-value-${i}-abcdef`);
    log('a test-client-secret b fake-refresh-token-0123 c recent-value-499-abcdef d');
    expect(logs[0]).not.toContain('test-client-secret');
    expect(logs[0]).not.toContain('fake-refresh-token-0123');
    expect(logs[0]).not.toContain('recent-value-499-abcdef');
    // Google's token shapes are scrubbed without being remembered.
    log('x ya29.access-token-abc y 1//refresh-token-def z 4/code-ghi client_secret=shh');
    for (const secret of ['access-token-abc', 'refresh-token-def', 'code-ghi', 'shh']) expect(logs[1]).not.toContain(secret);
    // A sink that throws never fails the caller.
    expect(() => createRedactingLog(() => {
      throw new Error('sink');
    }).log('x')).not.toThrow();
  });
});
