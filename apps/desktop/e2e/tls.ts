// A self-signed TLS certificate for loopback https servers in the e2e suites (the browse guard's
// certificate-error test, the Compliance panel's https pages). Test code only.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// A minimal DER encoder, enough for one self-signed X.509 v3 certificate (no new dependencies:
// node:crypto signs but cannot build certificates).
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length: number[] = [];
  for (let n = body.length; n > 0; n >>= 8) length.unshift(n & 0xff);
  const head = body.length < 0x80 ? [body.length] : [0x80 | length.length, ...length];
  return Buffer.concat([Buffer.from([tag, ...head]), body]);
}
const derSequence = (...parts: Buffer[]) => der(0x30, ...parts);
function derOid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
/**
 * A DER INTEGER of an unsigned big-endian value: minimal (leading zero bytes stripped, so a random
 * serial starting with 0x00 is not "illegal padding"), and a 0x00 prepended when the top bit is set.
 */
function derInteger(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const minimal = value.subarray(start);
  return der(0x02, (minimal[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal);
}
const derTime = (date: Date) => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

/** A fresh self-signed certificate for `CN=localhost` (P-256, ECDSA-SHA256), as PEM. */
export function selfSignedCertificate(): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = derSequence(derOid('1.2.840.10045.4.3.2'));
  const name = derSequence(der(0x31, derSequence(derOid('2.5.4.3'), der(0x0c, Buffer.from('localhost')))));
  const now = Date.now();
  const tbs = derSequence(
    der(0xa0, derInteger(Buffer.from([2]))),
    derInteger(randomBytes(8)),
    algorithm,
    name,
    derSequence(derTime(new Date(now - 86_400_000)), derTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const certificate = derSequence(tbs, algorithm, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const base64 = certificate.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
