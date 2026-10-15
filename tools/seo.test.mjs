import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMetadata, metadata, history, sitemapXml } from './site-metadata.mjs';
import { updatedHistory, validateDate } from './content-dates.mjs';
test('one configuration supplies search, sharing and application descriptions and date', () => {
  const dom = new JSDOM(`<head>${renderMetadata()}</head>`);
  const doc = dom.window.document;
  for (const selector of ['meta[name=description]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) assert.equal(doc.querySelector(selector).content, metadata.description);
  const app = JSON.parse(doc.querySelector('script').textContent)['@graph'][0];
  assert.equal(app.description, metadata.description); assert.equal(app.dateModified, history.lastmod);
  assert.ok(sitemapXml().includes(`<lastmod>${history.lastmod}</lastmod>`));
  dom.window.close();
});
test('unchanged rebuilds preserve dates; changed app assets require an explicit later date', () => {
  const old = { '/': { lastmod: '2026-01-01T00:00:00Z', fingerprint: 'a' } };
  assert.deepEqual(updatedHistory(old, { '/': 'a' }, '2026-02-01T00:00:00Z'), old);
  assert.equal(updatedHistory(old, { '/': 'b' }, '2026-02-01T00:00:00Z')['/'].lastmod, '2026-02-01T00:00:00Z');
  assert.throws(() => validateDate('2999-01-01T00:00:00Z'));
});
