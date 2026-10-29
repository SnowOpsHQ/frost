// Outgoing email, abstracted so the auth flows never know how mail leaves (spec
// `account-backend.feature.md`, Decisions). `console` is the local-development transport: it prints
// the whole message, sign-in links included, which is why `env.ts` refuses it in production.
// Tests use the memory transport. No other code path logs a message body.

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string | undefined;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/** Transports selectable with `EMAIL_TRANSPORT`. A real one (SMTP, an email API) is added here later. */
export const EMAIL_TRANSPORTS = ['console'] as const;
export type EmailTransportKind = (typeof EMAIL_TRANSPORTS)[number];

/** Dev only: writes the message, links included, to `write` (stdout by default). */
export function createConsoleTransport(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): EmailTransport {
  return {
    send(message) {
      write(['--- email (console transport, development only) ---', `To: ${message.to}`, `Subject: ${message.subject}`, '', message.text, '---'].join('\n'));
      return Promise.resolve();
    },
  };
}

export interface MemoryTransport extends EmailTransport {
  /** Every message sent, oldest first. */
  readonly messages: EmailMessage[];
}

/** Keeps messages in memory (tests). */
export function createMemoryTransport(): MemoryTransport {
  const messages: EmailMessage[] = [];
  return {
    messages,
    send(message) {
      messages.push({ ...message });
      return Promise.resolve();
    },
  };
}

export function createEmailTransport(kind: EmailTransportKind): EmailTransport {
  switch (kind) {
    case 'console':
      return createConsoleTransport();
  }
}
