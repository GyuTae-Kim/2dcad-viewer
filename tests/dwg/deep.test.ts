/**
 * 객체 단위 깊은 비교: DWG 리더 ↔ (엔진이 같은 핸들로 바꾼 DXF를 DXF 리더로 읽은 것).
 * 요약에 없는 필드(치수 정의점, 해치 경계, 뷰포트 보기, 다중 지시선 문맥 등)를 확인한다.
 * 기준 쪽이 AutoCAD DXF와 다른 것으로 확인한 필드만 SKIP에 둔다.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDwg } from '../../src/io/dwg';
import { readDxf } from '../../src/io/dxf/reader';
import { decodeCadEscapes } from '../../src/core/codepage';
import { FIXTURES, dwgFixtures, engineDxf, hasPython } from './oracle';

/**
 * 비교하지 않는 필드
 * - xdata·reactors·xdict·owner·plotStyle·graphics·raw: 표현 차이(확장 자료 정규화 등)
 * - generation(ATTRIB/ATTDEF): DXF 리더가 AcDbAttribute의 71을 넣는다
 * - direction·rotation(MTEXT): DXF 기준은 (1,0,0)일 때 11을 빼고, rotation은 50에서만 읽는다
 * - cells·tableStyle(ACAD_TABLE): 표현 차이
 * - color(MULTILEADER 지시선)·backgroundFill·backgroundColor: 기준 DXF·리더 차이(AutoCAD DXF는 DWG 쪽과 같다)
 * - hookline·horizontalDirection·blockOffset·annotationOffset(LEADER): 기준 DXF가 75·211·212·213을 쓰지 않는다
 * - name·shapeNumber·styleHandle(SHAPE): 이름은 SHX 파일이 있어야 안다
 * - imageDef(WIPEOUT): 빈 핸들 표기
 * - flags(PDFUNDERLAY): 기준 2, AutoCAD DXF·DWG 3
 */
const SKIP = new Set([
  'xdata',
  'reactors',
  'xdict',
  'owner',
  'plotStyle',
  'graphics',
  'raw',
  'generation',
  'direction',
  'rotation',
  'cells',
  'tableStyle',
  'backgroundFill',
  'backgroundColor',
  'hookline',
  'horizontalDirection',
  'blockOffset',
  'annotationOffset',
  'imageDef',
]);
const SKIP_BY_TYPE: Record<string, string[]> = {
  SHAPE: ['name', 'shapeNumber', 'styleHandle'],
  PDFUNDERLAY: ['flags'],
  MULTILEADER: ['color'],
  // 기준 SPLINE 플래그는 AutoCAD DXF와 다르다(normalize.ts 5번)
  SPLINE: ['flags'],
  // 그라데이션 색의 ACI: DWG는 색마다 ACI(BS)를 저장하고 기준은 다른 값을 낸다. RGB로 비교한다
  HATCH: ['gradient.color1.aci', 'gradient.color2.aci'],
  // R2004 기준은 MTEXT 배경을 잃는다(AutoCAD DXF는 DWG 쪽과 같다)
  // 단 높이: 기준은 DWG의 음수 값을 그대로 쓰고 AutoCAD DXF는 0을 쓴다(DWG 리더는 0)
  MTEXT: ['backgroundFlags', 'backgroundScale', 'columns.heights'],
  // 색상표 색: 기준은 RGB가 없다(normalize.ts 7번)
  CIRCLE: ['rgb'],
};

const norm = (v: string) => decodeCadEscapes(v).replace(/[\x00-\x1f]/g, (c) => '^' + String.fromCharCode(c.charCodeAt(0) + 64));

function diff(e: unknown, a: unknown, path: string, skip: Set<string>, out: string[]): void {
  if (out.length > 40) return;
  if (typeof e === 'number' && typeof a === 'number') {
    if (Math.abs(e - a) > 1e-6 * Math.max(1, Math.abs(e))) out.push(`${path}: ${e} → ${a}`);
    return;
  }
  if (e instanceof Map) e = Object.fromEntries(e);
  if (a instanceof Map) a = Object.fromEntries(a);
  if (Array.isArray(e)) {
    if (!Array.isArray(a) || a.length !== e.length) {
      out.push(`${path}: 길이 ${Array.isArray(e) ? e.length : '?'} → ${Array.isArray(a) ? a.length : typeof a}`);
      return;
    }
    e.forEach((x, i) => diff(x, a[i], `${path}[${i}]`, skip, out));
    return;
  }
  if (e && typeof e === 'object') {
    if (!a || typeof a !== 'object') {
      out.push(`${path}: 객체 → ${typeof a}`);
      return;
    }
    const eo = e as Record<string, unknown>;
    const ao = a as Record<string, unknown>;
    for (const k of new Set([...Object.keys(eo), ...Object.keys(ao)])) {
      const sub = `${path}.${k}`;
      if (skip.has(k) || [...skip].some((x) => x.includes('.') && sub.endsWith(x)) || eo[k] === undefined || ao[k] === undefined) continue;
      diff(eo[k], ao[k], sub, skip, out);
    }
    return;
  }
  if (typeof e === 'string' && typeof a === 'string' ? norm(e) !== norm(a) : e !== a) out.push(`${path}: ${JSON.stringify(e)} → ${JSON.stringify(a)}`);
}

describe.skipIf(!existsSync(join(FIXTURES, 'samples')) || !hasPython)('DWG 리더 ↔ DXF 리더(같은 핸들)', () => {
  for (const f of dwgFixtures()) {
    it(`${f.group}/${f.name}`, () => {
      const dxf = engineDxf(f.path);
      if (!dxf) return;
      const A = readDwg(new Uint8Array(readFileSync(f.path)));
      const E = readDxf(new Uint8Array(readFileSync(dxf)));
      const out: string[] = [];
      // 기준 도구가 새로 만든 블록(R14의 화살촉 블록 등)의 도형은 뺀다
      const extraBlocks = new Set([...E.blocks.keys()].filter((k) => !A.blocks.has(k)));
      const skipHandles = new Set<string>();
      for (const k of extraBlocks) for (const x of E.blocks.get(k)!.entities) skipHandles.add(x.handle);
      for (const [h, e] of E.entityIndex) {
        if (skipHandles.has(h)) continue;
        const a = A.entityIndex.get(h);
        if (!a) {
          out.push(`${e.type}:${h}: DWG 쪽에 없음`);
          continue;
        }
        // 기준이 프록시로 바꾼 MESH 등은 종류가 달라 건너뛴다
        if (a.type !== e.type) {
          if (e.type !== 'UNKNOWN') out.push(`${e.type}:${h}: 종류 → ${a.type}`);
          continue;
        }
        const skip = new Set([...SKIP, ...(SKIP_BY_TYPE[e.type] ?? [])]);
        diff(e, a, `${e.type}:${h}`, skip, out);
      }
      if (out.length) console.log(f.name, out.slice(0, 20).join('\n'));
      expect(out).toEqual([]);
    });
  }
});
