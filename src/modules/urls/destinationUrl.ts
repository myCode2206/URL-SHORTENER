import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { AppError } from '../../utils/errors';

export const MAX_URL_LENGTH = 2048;

// Should users be able to shorten http://localhost, http://10.0.0.5 or
// http://169.254.169.254? No, even though this service never fetches the URL.
//
// 1. Attacks on the people who click. A trusted short link can hide
//    http://192.168.1.1/admin?action=... and point a victim's browser at their
//    own router or company intranet. No public website has a legitimate reason
//    to link to private addresses.
// 2. Server-side request forgery (SSRF) later on. Link previews, malware
//    scanning or QR thumbnails would all mean the server fetches the URL. A
//    stored http://169.254.169.254/... would then make the server read the AWS
//    instance metadata service, which hands out the server's IAM credentials.
//    Blocking these at creation means no such URL is ever in the database.
//
// What this check can't do: a public hostname can resolve to a private IP
// (e.g. 127.0.0.1.nip.io), and DNS can change after the check ("DNS
// rebinding"). Any future feature that fetches URLs must re-check the resolved
// IP at fetch time. This check is the first layer of defence, not the only one.
const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64: embeds an IPv4 address
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['fc00::', 7], // unique local, incl. AWS metadata fd00:ec2::254
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv6');
}

// Names that only mean something inside a private network.
const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|home\.arpa|lan)$/;

// Checks a URL submitted for shortening and returns it in canonical form.
// Throws a 400 AppError explaining what's wrong.
export function normalizeDestinationUrl(input: string, ownHostname: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid('Must be an absolute URL, e.g. https://example.com/page');
  }

  // Blocks javascript:, data:, file: and the like. A short link to
  // javascript:alert(document.cookie) would be an XSS link with a trusted face.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('Only http and https URLs can be shortened');
  }
  // https://paypal.com@evil.example goes to evil.example; "paypal.com" is a
  // username. That's a classic phishing disguise.
  if (url.username || url.password) {
    throw invalid('URLs containing a username or password are not allowed');
  }

  // The URL parser has already normalised tricky IP spellings: 2130706433,
  // 0x7f.1 and 127.1 all become 127.0.0.1 here. So the checks below can't be
  // bypassed by encoding an IP differently.
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  const isIpLiteral = isIPv4(hostname) || isIPv6(stripBrackets(hostname));
  const isInternalName = INTERNAL_NAME.test(hostname) || !hostname.includes('.');
  if (isPrivateAddress(hostname) || (!isIpLiteral && isInternalName)) {
    throw invalid('URLs pointing to private or internal networks are not allowed');
  }
  // A short link to another short link hides the final destination and can
  // create redirect loops.
  if (hostname === ownHostname) {
    throw invalid('URLs on this service cannot be shortened again');
  }

  // href is the canonical form: lowercase host, punycode for international
  // domains, percent-encoded path. Length is checked after encoding, which can
  // make a URL longer.
  if (url.href.length > MAX_URL_LENGTH) {
    throw invalid(`URL must be at most ${MAX_URL_LENGTH} characters`);
  }
  return url.href;
}

function isPrivateAddress(hostname: string): boolean {
  if (isIPv4(hostname)) return PRIVATE_RANGES.check(hostname, 'ipv4');

  const ipv6 = stripBrackets(hostname);
  if (!isIPv6(ipv6)) return false;
  // ::ffff:a.b.c.d is an IPv4 address in IPv6 form; the URL parser writes it
  // in hex, e.g. ::ffff:7f00:1 for 127.0.0.1.
  const mapped = ipv6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped?.[1] && mapped[2]) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    const ipv4 = [high >> 8, high & 255, low >> 8, low & 255].join('.');
    return PRIVATE_RANGES.check(ipv4, 'ipv4');
  }
  return PRIVATE_RANGES.check(ipv6, 'ipv6');
}

// The URL parser keeps IPv6 hosts in brackets: "[::1]".
function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

function invalid(message: string): AppError {
  return new AppError(400, 'INVALID_URL', message);
}
