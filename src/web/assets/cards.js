const abbreviated = key => `${key.slice(0, 8)}…${key.slice(-6)}`;
function webUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return;
  try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Render invalid values as plain text. */ }
}
function link(label, href) {
  const anchor = document.createElement('a'); anchor.textContent = label; anchor.href = href;
  anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; return anchor;
}
// NIP-19 note encoding keeps the external client action unambiguous without a browser SDK.
function noteReference(hex) {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', words = [];
  let bits = 0, value = 0;
  for (const byte of hex.match(/../g) ?? []) { value = (value << 8) | parseInt(byte, 16); bits += 8; while (bits >= 5) { bits -= 5; words.push((value >>> bits) & 31); } }
  if (bits) words.push((value << (5 - bits)) & 31);
  const prefix = [...'note'].map(char => char.charCodeAt(0));
  const expanded = [...prefix.map(code => code >>> 5), 0, ...prefix.map(code => code & 31)];
  let checksum = 1;
  for (const word of [...expanded, ...words, 0, 0, 0, 0, 0, 0]) {
    const top = checksum >>> 25; checksum = ((checksum & 0x1ffffff) << 5) ^ word;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) checksum ^= [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3][i];
  }
  checksum ^= 1;
  return `note1${words.map(word => alphabet[word]).join('')}${Array.from({ length: 6 }, (_, i) => alphabet[(checksum >>> (5 * (5 - i))) & 31]).join('')}`;
}
function richText(content) {
  const paragraph = document.createElement('p'); paragraph.className = 'post-content';
  const images = new Set(); let offset = 0;
  const tokens = /https?:\/\/[^\s<>"']+|(?:nostr:)?(?:npub1|note1|nevent1|nprofile1|naddr1)[023456789acdefghjklmnpqrstuvwxyz]{20,}/g;
  for (const match of content.matchAll(tokens)) {
    paragraph.append(document.createTextNode(content.slice(offset, match.index)));
    const token = match[0], trimmed = token.replace(/[.,!?;:)]+$/, '');
    const url = webUrl(trimmed);
    if (url) {
      paragraph.append(link(trimmed, url), document.createTextNode(token.slice(trimmed.length)));
      if (/\.(?:png|jpe?g|gif|webp|avif)$/i.test(new URL(url).pathname) && images.size < 4) images.add(url);
    } else if (/^(?:nostr:)?(?:npub1|note1|nevent1|nprofile1|naddr1)/.test(token)) {
      paragraph.append(link(token, `https://njump.me/${token.replace(/^nostr:/, '')}`));
    } else paragraph.append(document.createTextNode(token));
    offset = match.index + token.length;
  }
  paragraph.append(document.createTextNode(content.slice(offset)));
  return { paragraph, images };
}
function enrichAuthor(header, profile) {
  const author = header.querySelector('.author-name');
  if (typeof profile.name === 'string' && profile.name.trim()) { author.textContent = profile.name.slice(0, 100); header.querySelector('.author-key').hidden = false; }
  const picture = webUrl(profile.picture); if (!picture) return;
  const avatar = header.querySelector('.avatar'), image = document.createElement('img');
  image.className = 'avatar-image'; image.alt = ''; image.referrerPolicy = 'no-referrer'; image.loading = 'lazy';
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = picture; avatar.append(image);
}
export function renderCards(container, items) {
  const signature = JSON.stringify(items.map(item => [item.id, item.pubkey, item.content, item.createdAt]));
  if (container.dataset.cards === signature && container.childElementCount === items.length) return;
  container.dataset.cards = signature;
  const headers = new Map();
  container.replaceChildren(...items.map(item => {
    const article = document.createElement('article'); article.className = 'post'; article.dataset.noteId = item.id;
    const header = document.createElement('header');
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = item.pubkey.slice(0, 2); avatar.setAttribute('aria-hidden', 'true');
    const identity = document.createElement('div'); identity.className = 'author-identity';
    const author = document.createElement('strong'); author.className = 'author-name'; author.textContent = abbreviated(item.pubkey);
    const key = document.createElement('span'); key.className = 'author-key'; key.hidden = true; key.textContent = abbreviated(item.pubkey);
    identity.append(author, key);
    const time = document.createElement('time'); time.dateTime = new Date(item.createdAt * 1000).toISOString(); time.textContent = new Date(item.createdAt * 1000).toLocaleString();
    header.append(avatar, identity, time);
    if (!headers.has(item.pubkey)) headers.set(item.pubkey, []); headers.get(item.pubkey).push(header);
    const { paragraph, images } = richText(item.content); paragraph.id = `note-content-${item.id}`;
    article.append(header, paragraph);
    if (item.content.length > 700 || item.content.split('\n').length > 12) {
      paragraph.classList.add('collapsed');
      const expand = document.createElement('button'); expand.className = 'expand-note'; expand.textContent = 'Read full note'; expand.setAttribute('aria-expanded', 'false'); expand.setAttribute('aria-controls', paragraph.id);
      expand.addEventListener('click', () => { const collapsed = paragraph.classList.toggle('collapsed'); expand.textContent = collapsed ? 'Read full note' : 'Show less'; expand.setAttribute('aria-expanded', String(!collapsed)); });
      article.append(expand);
    }
    if (images.size) {
      const media = document.createElement('div'); media.className = 'post-media';
      for (const url of images) {
        const preview = link('', url); preview.className = 'image-link'; preview.setAttribute('aria-label', 'Open image');
        const image = document.createElement('img'); image.className = 'post-image'; image.alt = 'Image attached to this note'; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => { image.remove(); preview.textContent = 'Image unavailable'; preview.classList.add('image-unavailable'); }, { once: true });
        image.src = url; preview.append(image); media.append(preview);
      }
      article.append(media);
    }
    const action = link('Open in Nostr client', `https://njump.me/${noteReference(item.id)}`); action.className = 'open-note'; article.append(action);
    return article;
  }));
  const authors = [...headers.keys()];
  for (let offset = 0; offset < authors.length; offset += 50) {
    void fetch(`/api/profiles?authors=${authors.slice(offset, offset + 50).join(',')}`).then(response => response.ok ? response.json() : { profiles: [] }).then(({ profiles }) => {
      if (!Array.isArray(profiles)) return;
      for (const profile of profiles) for (const header of headers.get(profile.pubkey) ?? []) if (header.isConnected) enrichAuthor(header, profile);
    }).catch(() => {}); // Profiles never gate completed notes or replace their order.
  }
}
