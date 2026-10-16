/**
 * SketchUp 2021 이후 꾸러미의 materials/<이름>/material.xml에서 재질 색을 읽는다.
 * 관찰한 꼴: <mat:material name="…" type="0|1|2" colorRed=".." colorGreen=".." colorBlue=".." trans=".." useTrans="0|1" hasTexture="0|1" …>
 * 무늬(텍스처) 재질도 colorRed/Green/Blue를 갖고 있어(무늬 평균색으로 보임) 그 색을 쓴다.
 * 워커에서도 돌게 DOMParser 없이 첫 시작 꼬리표의 속성만 정규식으로 읽는다.
 */

import type { Rgba } from '../../viewer3d/types';

export interface SkpMaterialInfo {
  name: string;
  color: Rgba;
  textured: boolean;
}

const XML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENT[e] ?? m;
  });
}

/** material.xml 글 → 재질 정보(없으면 null) */
export function parseMaterialXml(xml: string): SkpMaterialInfo | null {
  const m = /<(?:[\w-]+:)?material\b([^>]*)>/.exec(xml);
  if (!m) return null;
  const attrs = new Map<string, string>();
  for (const a of m[1]!.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs.set(a[1]!, unescapeXml(a[2]!));
  const name = attrs.get('name');
  if (name === undefined) return null;
  const ch = (k: string): number => {
    const v = Number(attrs.get(k));
    return Number.isFinite(v) ? Math.min(255, Math.max(0, v)) / 255 : 0.8;
  };
  // 불투명도: useTrans=1이고 0<trans<1일 때만 trans를 알파로 쓴다.
  // (trans=0·useTrans=1인 재질이 미리보기 그림에서 불투명하게 보여, 0은 불투명으로 둔다 — 확실하지 않음)
  let alpha = 1;
  const trans = Number(attrs.get('trans'));
  if (attrs.get('useTrans') === '1' && Number.isFinite(trans) && trans > 0 && trans < 1) alpha = Math.max(0.15, trans);
  return { name, color: [ch('colorRed'), ch('colorGreen'), ch('colorBlue'), alpha], textured: attrs.get('hasTexture') === '1' };
}
