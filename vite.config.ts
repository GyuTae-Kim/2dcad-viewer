import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { renderMetadata, sitemapXml } from './tools/site-metadata.mjs';

function siteMetadata(): Plugin {
  return {
    name: 'opencad-site-metadata',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('<!-- site-metadata -->', renderMetadata()) },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/^\/(?:2dcad-viewer\/)?sitemap\.xml(?:\?|$)/.test(req.url ?? '')) return next();
        res.setHeader('Content-Type', 'application/xml'); res.end(sitemapXml());
      });
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml() }); },
  };
}

/**
 * pdf.js가 필요할 때 받아 가는 자료(표준 글꼴, CMap, 그림 해독 wasm, ICC)를 `pdfjs/` 아래로 낸다.
 * 개발 서버는 node_modules에서 바로 주고, 빌드는 같은 경로로 복사한다(PDF 언더레이를 쓸 때만 받는다).
 */
function pdfjsAssets(): Plugin {
  const root = join(process.cwd(), 'node_modules/pdfjs-dist');
  const dirs = ['standard_fonts', 'cmaps', 'wasm', 'iccs'];
  const skip = /^quickjs/;
  return {
    name: 'opencad-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/pdfjs\/([a-z_]+)\/([\w.-]+)$/.exec((req.url ?? '').split('?')[0]!);
        if (!m || !dirs.includes(m[1]!) || skip.test(m[2]!)) return next();
        try {
          const data = readFileSync(join(root, m[1]!, m[2]!));
          res.setHeader('Content-Type', m[2]!.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
          res.end(data);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const d of dirs)
        for (const f of readdirSync(join(root, d))) {
          const p = join(root, d, f);
          if (skip.test(f) || !statSync(p).isFile()) continue;
          this.emitFile({ type: 'asset', fileName: `pdfjs/${d}/${f}`, source: readFileSync(p) });
        }
    },
  };
}

export default defineConfig({
  // GitHub Pages 프로젝트 사이트 경로(https://gyutae-kim.github.io/2dcad-viewer/)
  base: './',
  plugins: [siteMetadata(), pdfjsAssets()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
