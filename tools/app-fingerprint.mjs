import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { contentFingerprint, digest } from './content-dates.mjs';
import { metadata } from './site-metadata.mjs';
export function appFingerprint() {
  const base = new URL(metadata.url).pathname;
  const document = contentFingerprint(readFileSync('dist/index.html', 'utf8'), path => {
    if (!path.startsWith(base)) throw new Error('Unexpected application asset: ' + path);
    return readFileSync(join('dist', path.slice(base.length)));
  }, metadata.url);
  // Include executable assets: changing a CAD command changes this application
  // even when its static introduction is unchanged. Source maps are not content.
  const assets = readdirSync('dist/assets').filter(file => /\.(?:js|mjs|css)$/.test(file)).sort()
    .map(file => [file, digest(readFileSync(join('dist/assets', file)))]);
  return digest(JSON.stringify({ document, assets }));
}
