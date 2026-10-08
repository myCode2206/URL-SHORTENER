import { MAX_URL_LENGTH, normalizeDestinationUrl } from '../../../src/modules/urls/destinationUrl';
import { AppError } from '../../../src/utils/errors';

const OWN_HOST = 'sho.rt';
const normalize = (url: string) => normalizeDestinationUrl(url, OWN_HOST);

function expectRejected(url: string, message: RegExp) {
  try {
    normalize(url);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 400, code: 'INVALID_URL' });
    expect((err as AppError).message).toMatch(message);
    return;
  }
  throw new Error(`expected ${url} to be rejected`);
}

describe('accepted URLs', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['HTTPS://Example.COM/Path?q=1#top', 'https://example.com/Path?q=1#top'],
    ['https://münchen.de/straße', 'https://xn--mnchen-3ya.de/stra%C3%9Fe'],
    ['http://example.com:8080/x', 'http://example.com:8080/x'],
    ['http://8.8.8.8/dns', 'http://8.8.8.8/dns'],
    ['http://[2606:4700:4700::1111]/', 'http://[2606:4700:4700::1111]/'],
    // Just outside the private ranges:
    ['http://172.32.0.1/', 'http://172.32.0.1/'],
    ['http://11.0.0.1/', 'http://11.0.0.1/'],
    ['http://192.169.0.1/', 'http://192.169.0.1/'],
  ])('%s → %s', (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });
});

describe('rejected URLs', () => {
  it.each(['not a url', 'example.com', '/relative/path', ''])('not absolute: %j', (url) => {
    expectRejected(url, /absolute URL/);
  });

  it.each([
    'javascript:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'mailto:someone@example.com',
  ])('dangerous scheme: %s', (url) => {
    expectRejected(url, /Only http and https/);
  });

  it.each(['https://user:pass@example.com', 'https://paypal.com@evil.example/login'])(
    'embedded credentials (phishing disguise): %s',
    (url) => {
      expectRejected(url, /username or password/);
    },
  );

  it.each([
    'http://localhost:3000',
    'http://LOCALHOST./admin',
    'http://app.localhost',
    'http://127.0.0.1',
    'http://127.1', // short form of 127.0.0.1
    'http://2130706433', // 127.0.0.1 as a single decimal number
    'http://0x7f000001', // ... as hex
    'http://0177.0.0.1', // ... as octal
    'http://0.0.0.0',
    'http://169.254.169.254/latest/meta-data/iam/', // AWS instance metadata
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.1/admin',
    'http://100.64.0.1',
    'http://224.0.0.1',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]', // IPv4 loopback written as IPv6
    'http://[::ffff:169.254.169.254]',
    'http://[fd00:ec2::254]', // AWS metadata over IPv6
    'http://[fe80::1]',
    'http://metadata.google.internal',
    'http://printer.local',
    'http://router.lan',
    'http://intranet', // single-label names only resolve inside a network
  ])('private or internal destination: %s', (url) => {
    expectRejected(url, /private or internal/);
  });

  it.each(['https://sho.rt/aB7xK2q', 'https://SHO.RT./x', 'http://sho.rt:8080/x'])(
    'links to this service: %s',
    (url) => {
      expectRejected(url, /cannot be shortened again/);
    },
  );

  it('URLs longer than the limit after normalisation', () => {
    const base = 'https://example.com/';
    expect(normalize(base + 'a'.repeat(MAX_URL_LENGTH - base.length))).toHaveLength(MAX_URL_LENGTH);
    // "é" becomes "%C3%A9" when normalised, so this grows past the limit.
    expectRejected(base + 'é'.repeat(400), /at most 2048/);
  });
});
