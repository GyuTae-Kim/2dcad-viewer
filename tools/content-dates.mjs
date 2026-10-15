import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Dates describe content, not the build. Ignore generated Angular attributes,
// component CSS, scripts, and dateModified itself so rebuilding is idempotent.
export function contentFingerprint(html, assetBytes, pageUrl = 'https://gyutae-kim.github.io/') {
  const dom = new JSDOM(html, { url: pageUrl });
  try {
    const doc = dom.window.document;
    const withoutDates = (value) => Array.isArray(value) ? value.map(withoutDates)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['dateModified', 'datePublished'].includes(key)).map(([key, item]) => [key, withoutDates(item)])) : value;
    const tree = (node) => node.nodeType === 3 ? node.textContent.replace(/\s+/g, ' ').trim()
      : node.nodeType !== 1 || ['SCRIPT', 'STYLE'].includes(node.tagName) ? null
        : [node.tagName.toLowerCase(), [...node.attributes].filter((a) => !/^_ng|^ng-/.test(a.name))
          .map(a => [a.name, a.value]).sort(([a], [b]) => a.localeCompare(b)), [...node.childNodes].map(tree).filter(Boolean)];
    const metadata = [...doc.querySelectorAll('meta[name="description"], meta[name="robots"], meta[name="author"], meta[property^="og:"], meta[name^="twitter:"]')]
      .map(el => [el.getAttribute('name') ?? el.getAttribute('property'), el.getAttribute('content')]).sort(([a], [b]) => a.localeCompare(b));
    const images = new Set([...doc.querySelectorAll('main img[src], main img[srcset], main source[srcset]')].flatMap(el => [
      ...(el.hasAttribute('src') ? [el.getAttribute('src')] : []),
      ...(el.getAttribute('srcset')?.split(',').map(item => item.trim().split(/\s+/)[0]) ?? []),
    ]));
    const cover = doc.querySelector('meta[property="og:image"]')?.content;
    if (cover) images.add(cover);
    const assets = [...images].map(src => new URL(src, doc.baseURI)).filter(url => url.origin === new URL(pageUrl).origin)
      .map(url => [url.pathname, digest(assetBytes(url.pathname))]).sort(([a], [b]) => a.localeCompare(b));
    return digest(JSON.stringify({ title: doc.title, canonical: doc.querySelector('link[rel="canonical"]')?.href,
      metadata, data: [...doc.querySelectorAll('script[type="application/ld+json"]')].map(el => withoutDates(JSON.parse(el.textContent))),
      body: tree(doc.querySelector('main')), assets }));
  } finally { dom.window.close(); }
}

export function validateDate(value, now = new Date()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace('.000Z', 'Z') !== value || Date.parse(value) > now.getTime()) {
    throw new Error(`Invalid or future content modification time: ${value}`);
  }
  return value;
}

export function assertContentDate(path, record, fingerprint) {
  validateDate(record?.lastmod);
  if (record?.fingerprint !== fingerprint) throw new Error(`${path}: content changed. Run npm run update:content-dates -- --at <actual-content-update-UTC>, then rebuild.`);
}

export function updatedHistory(history, fingerprints, at, now = new Date()) {
  validateDate(at, now);
  const next = {};
  for (const [path, fingerprint] of Object.entries(fingerprints)) {
    const old = history[path];
    if (old?.fingerprint === fingerprint) { validateDate(old.lastmod, now); next[path] = old; continue; }
    if (old && Date.parse(at) <= Date.parse(old.lastmod)) throw new Error(`${path}: changed content needs a later modification time.`);
    next[path] = { lastmod: at, fingerprint };
  }
  return next;
}
