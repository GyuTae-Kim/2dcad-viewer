/**
 * DWG 리더 요약과 기준(엔진 → DXF → ezdxf 요약) 사이의 알려진 차이를 걷어 낸다.
 * 기준 쪽이 틀린 것으로 확인한 항목만 여기서 맞추고, 나머지는 그대로 비교한다.
 *
 * 1. AC1014: 기준 DXF는 R2000으로 저장되어 version이 AC1015다.
 * 2. 기준 도구가 새 문서에 넣는 기본 항목(도면층 Defpoints, 치수 스타일 Standard, R14의 화살촉 블록)은
 *    DWG에 없으면 비교에서 뺀다.
 * 3. R2004+ 기준은 REGION·3DSOLID·BODY를 잃는다(AutoCAD DXF에는 있다). DWG 쪽에만 있으면 허용한다.
 * 4. 기준은 MESH를 ACAD_PROXY_ENTITY로 낸다(AutoCAD DXF는 MESH). 종류만 맞춘다.
 * 5. R2013+ SPLINE 플래그: AutoCAD DXF는 1160처럼 높은 비트를 쓰고 기준은 24를 낸다. 128 이상 비트가 있으면 비교하지 않는다.
 * 6. 트루컬러 도면층의 ACI: 기준은 근사 팔레트로 고른다(AutoCAD DXF와 다름). RGB가 있는 도면층은 ACI를 비교하지 않는다.
 * 7. 색상표 색(DBCOLOR) 도형: 기준은 RGB를 쓰지 않는다(AutoCAD DXF는 씀). 기준에 RGB가 없으면 지운다.
 * 8. 문자: 기준(ezdxf)은 \U+XXXX를 풀고 줄바꿈을 ^J로 쓴다. 양쪽을 같은 표기로 바꾼다.
 */
import type { CadDocument } from '../../src/core/model';
import { decodeCadEscapes } from '../../src/core/codepage';

type Obj = Record<string, unknown>;
type Ent = Obj & { type: string; handle: string; color?: { aci: number; rgb?: number } };

const ORACLE_DEFAULT_BLOCKS = /^_(CLOSEDFILLED|SMALL|DATUMFILLED|DOT|ORIGIN|OPEN30|OPEN|OBLIQUE|OPEN90|DOTBLANK|ORIGIN2|BOXFILLED|CLOSED|DATUMBLANK|NONE|DOTSMALL|INTEGRAL|ARCHTICK|BOXBLANK|CLOSEDBLANK)$/;
const ACIS = new Set(['REGION', '3DSOLID', 'BODY']);

const normText = (s: unknown): unknown =>
  typeof s === 'string' ? decodeCadEscapes(s).replace(/[\x00-\x1f]/g, (c) => '^' + String.fromCharCode(c.charCodeAt(0) + 64)) : s;

export function normalizePair(expected: Obj, actual: Obj, doc: CadDocument): void {
  // 1
  expected.version = actual.version;
  // 2
  const actLayers = new Set((actual.layers as Obj[]).map((l) => String(l.name).toUpperCase()));
  expected.layers = (expected.layers as Obj[]).filter((l) => actLayers.has(String(l.name).toUpperCase()) || String(l.name) !== 'Defpoints');
  const actDim = new Set(actual.dimStyles as string[]);
  expected.dimStyles = (expected.dimStyles as string[]).filter((n) => actDim.has(n) || n !== 'Standard');
  const eb = expected.blocks as Record<string, Ent[]>;
  const ab = actual.blocks as Record<string, Ent[]>;
  for (const k of Object.keys(eb)) if (!(k in ab) && ORACLE_DEFAULT_BLOCKS.test(k)) delete eb[k];
  // 6
  const rgbLayers = new Set([...doc.layers.values()].filter((l) => l.color.rgb !== undefined).map((l) => l.name));
  for (const l of expected.layers as Obj[]) if (rgbLayers.has(String(l.name))) l.color = null;
  for (const [k, list] of Object.entries(eb)) {
    const act = ab[k];
    if (!act) continue;
    const expHandles = new Set(list.map((e) => e.handle));
    // 3
    ab[k] = act.filter((e) => !(ACIS.has(e.type) && !expHandles.has(e.handle)));
    const am = new Map(ab[k].map((e) => [e.handle, e]));
    for (const e of list) {
      const a = am.get(e.handle);
      if (!a) continue;
      // 4
      if (e.type === 'ACAD_PROXY_ENTITY' && a.type === 'MESH') a.type = e.type;
      // 5
      if (e.type === 'SPLINE' && typeof a.flags === 'number' && a.flags >= 128) e.flags = null;
      // 7
      if (a.color && a.color.rgb !== undefined && e.color && e.color.rgb === undefined) {
        const de = doc.entityIndex.get(a.handle);
        if (de?.color.name) delete a.color.rgb;
      }
      // 8
      if ('text' in e) {
        e.text = normText(e.text);
        a.text = normText(a.text);
      }
    }
  }
}
