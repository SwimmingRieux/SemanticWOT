/** Admission for untrusted receipt hints only; configured relays bypass this policy. */
export function isPublicRelayHint(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (host.startsWith('[')) return publicIpv6(host.slice(1, -1));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return publicIpv4(host.split('.').map(Number));
  return host.includes('.') && !['localhost', 'localdomain', 'local', 'internal', 'lan', 'home.arpa']
    .some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

function publicIpv6(host: string): boolean {
  // URL supplies canonical hex groups (including mapped IPv4), so no DNS or I/O
  // is needed to expand the one possible compression marker.
  const [left, right = ''] = host.split('::');
  const head = left ? left.split(':').map(word => Number.parseInt(word, 16)) : [];
  const tail = right ? right.split(':').map(word => Number.parseInt(word, 16)) : [];
  const words = [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return publicIpv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
  }
  if (words[0] === 0x2002) return publicIpv4([words[1] >> 8, words[1] & 255, words[2] >> 8, words[2] & 255]);
  // Admit global unicast, excluding documentation allocations. This also rejects
  // unspecified, loopback, ULA, link/site-local, multicast and compatible IPv4.
  return (words[0] & 0xe000) === 0x2000 &&
    !(words[0] === 0x2001 && (words[1] === 0xdb8 || words[1] === 2 && words[2] === 0 ||
      (words[1] & 0xfff0) === 0x10 || (words[1] & 0xfff0) === 0x20) ||
      words[0] === 0x3fff && (words[1] & 0xf000) === 0);
}

function publicIpv4([a, b, c]: number[]): boolean {
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
