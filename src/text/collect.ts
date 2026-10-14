/** 도면에 쓰인 문자(글꼴 조각을 미리 받기 위해)와 트루타입 글꼴 사용 여부 */
import type { CadDocument } from '../core/model';
import { collectCodePoints } from './mtext';
import { isShxFont } from './layout';
import { type LatinFamily, latinFamilyOf } from './fonts';

export interface TextUsage {
  codes: Set<number>;
  /** 윤곽 글꼴이 필요한지(트루타입 스타일 또는 단선 글꼴에 없는 문자) */
  needsOutline: boolean;
  /** 받아야 할 라틴 트루타입 계열 */
  latin: Set<LatinFamily>;
}

export function collectTextUsage(doc: CadDocument): TextUsage {
  const codes = new Set<number>();
  const latin = new Set<LatinFamily>();
  let ttf = false;
  for (const s of doc.textStyles.values()) {
    if (s.fontFamily || !isShxFont(s.font)) {
      ttf = true;
      const fam = latinFamilyOf(s.fontFamily || s.font);
      if (fam) latin.add(fam);
    }
  }
  for (const b of doc.blocks.values()) {
    for (const e of b.entities) {
      switch (e.type) {
        case 'TEXT':
        case 'ATTRIB':
        case 'ATTDEF':
          collectCodePoints(e.text, codes);
          if ('tag' in e) collectCodePoints(e.tag, codes);
          break;
        case 'MTEXT':
          collectCodePoints(e.text, codes);
          if (/\\f/i.test(e.text)) {
            ttf = true;
            for (const m of e.text.matchAll(/\\f([^|;]*)/gi)) {
              const fam = latinFamilyOf(m[1]!);
              if (fam) latin.add(fam);
            }
          }
          break;
        case 'INSERT':
          for (const a of e.attribs) collectCodePoints(a.text, codes);
          break;
        case 'MULTILEADER':
          if (e.context.text) collectCodePoints(e.context.text.text, codes);
          break;
        case 'TOLERANCE':
          collectCodePoints(e.text, codes);
          break;
        case 'DIMENSION':
          collectCodePoints(e.text, codes);
          break;
        default:
          break;
      }
    }
  }
  for (const lt of doc.linetypes.values()) for (const el of lt.elements) if (el.text) collectCodePoints(el.text, codes);
  // 단선 글꼴이 그리는 기호(°, ±, Ø)는 윤곽 글꼴이 필요 없다
  let outside = false;
  for (const c of codes) if (c > 126 && c !== 0xb0 && c !== 0xb1 && c !== 0xd8 && c !== 0x2205 && c !== 0x2300 && c !== 0xb2 && c !== 0xb3 && c !== 0xb5) outside = true;
  return { codes, needsOutline: ttf || outside, latin };
}
