import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { metadata, history } from './site-metadata.mjs';
import { assertContentDate } from './content-dates.mjs';
import { appFingerprint } from './app-fingerprint.mjs';
assertContentDate(metadata.url, history, appFingerprint());
const raw = readFileSync('dist/index.html');
const dom = new JSDOM(raw.toString(), { url: metadata.url });
const doc = dom.window.document;
assert.equal(doc.title, metadata.title);
const tags = [
  ['meta[name="description"]', metadata.description], ['meta[name="author"]', metadata.author.name],
  ['meta[name="robots"]', 'index, follow, max-image-preview:large'],
  ['meta[property="og:type"]', 'website'], ['meta[property="og:site_name"]', metadata.siteName],
  ['meta[property="og:locale"]', metadata.locale], ['meta[property="og:title"]', metadata.title],
  ['meta[property="og:description"]', metadata.description], ['meta[property="og:url"]', metadata.url],
  ['meta[property="og:image"]', metadata.image.url], ['meta[property="og:image:secure_url"]', metadata.image.url],
  ['meta[property="og:image:type"]', metadata.image.type], ['meta[property="og:image:width"]', String(metadata.image.width)],
  ['meta[property="og:image:height"]', String(metadata.image.height)], ['meta[property="og:image:alt"]', metadata.image.alt],
  ['meta[name="twitter:card"]', 'summary_large_image'], ['meta[name="twitter:title"]', metadata.title],
  ['meta[name="twitter:description"]', metadata.description], ['meta[name="twitter:image"]', metadata.image.url],
  ['meta[name="twitter:image:alt"]', metadata.image.alt],
];
const prefix = new JSDOM(raw.subarray(0, 8192).toString());
for (const [selector, value] of tags) {
  assert.equal(doc.querySelectorAll(selector).length, 1, selector);
  assert.equal(doc.querySelector(selector).content, value, selector);
  assert.equal(prefix.window.document.querySelector(selector)?.content, value, 'Early ' + selector);
}
assert.equal(doc.querySelectorAll('link[rel=canonical]').length, 1);
assert.equal(doc.querySelector('link[rel=canonical]').href, metadata.url);
assert.equal(doc.querySelectorAll('script[type="application/ld+json"]').length, 1);
const app = JSON.parse(doc.querySelector('script[type="application/ld+json"]').textContent)['@graph'].find(node => node['@type'] === 'WebApplication');
assert.equal(app.dateModified, history.lastmod);
assert.equal(app.description, metadata.description);
assert.equal(app.url, metadata.url);
const xml = new JSDOM(readFileSync('dist/sitemap.xml', 'utf8'), { contentType: 'text/xml' });
assert.equal(xml.window.document.querySelectorAll('url').length, 1);
assert.equal(xml.window.document.querySelector('loc').textContent, metadata.url);
assert.equal(xml.window.document.querySelector('lastmod').textContent, history.lastmod);
dom.window.close(); prefix.window.close(); xml.window.close();
console.log('SEO check passed: unique common metadata, early sharing tags, structured date, sitemap date, and unchanged application fingerprint.');
