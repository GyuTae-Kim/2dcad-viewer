/**
 * MKLTYPE(Express Tools 선종류 만들기) 계산(UI 없음).
 * 선종류 정의의 시작점·끝점(한 주기)과 그 위에 그린 객체로 선종류를 만든다:
 * - 선(LINE, 그리고 곧은 폴리선 조각): 정의 선 위(법선 거리 허용 오차 안)에 놓인 부분이 대시
 * - 점(POINT): 점(길이 0)
 * - 문자(TEXT): 문자 요소(스타일·높이·선에 대한 회전·위치)
 * - 쉐이프(SHAPE): 쉐이프 요소(쉐이프 번호·글꼴 파일)
 * 선은 겹치면 합치고, 처음이 틈이면 무늬를 돌려 대시로 시작한다(같은 무늬의 위상만 다르다).
 * 복합 요소(문자·쉐이프)는 그 자리에서 시작하는 요소에 붙는다(이 앱의 렌더러·DXF와 같은 방식):
 * .lin 파일에서는 그 요소 앞에 적는다.
 */
import type { CadDocument, Entity, Linetype, LinetypeElement, Vec2 } from '../../core/model';
import { tableKey } from '../../core/model';
import { entityPath } from '../geom/path';

export interface MkltypeInput {
  start: Vec2;
  end: Vec2;
  /** 정의 선에서 벗어나도 되는 거리(기본 = 길이의 1e-6) */
  tol?: number;
}

interface Mark {
  t: number;
  kind: 'text' | 'shape';
  el: Omit<LinetypeElement, 'length'>;
  /** .lin 표기 */
  lin: string;
}

const fmt = (v: number): string => {
  const r = Math.round(v * 1e8) / 1e8;
  return (Object.is(r, -0) ? 0 : r).toString();
};

/** 선종류 요소들(길이 + 문자·쉐이프)과 .lin 무늬 줄. 만들 수 없으면 안내 문구 */
export function linetypeFromObjects(inp: MkltypeInput, ents: readonly Entity[], doc: CadDocument): { elements: LinetypeElement[]; pattern: string; patternLength: number } | string {
  const dx = inp.end.x - inp.start.x;
  const dy = inp.end.y - inp.start.y;
  const L = Math.hypot(dx, dy);
  if (!(L > 1e-12)) return '선종류 정의의 시작점과 끝점이 같습니다.';
  const u = { x: dx / L, y: dy / L };
  const n = { x: -u.y, y: u.x };
  const tol = inp.tol ?? L * 1e-6;
  const along = (p: { x: number; y: number }) => (p.x - inp.start.x) * u.x + (p.y - inp.start.y) * u.y;
  const off = (p: { x: number; y: number }) => (p.x - inp.start.x) * n.x + (p.y - inp.start.y) * n.y;
  const dashes: [number, number][] = [];
  const dots: number[] = [];
  const marks: Mark[] = [];
  const addSeg = (a: Vec2, b: Vec2) => {
    if (Math.abs(off(a)) > tol || Math.abs(off(b)) > tol) return;
    let t0 = along(a);
    let t1 = along(b);
    if (t0 > t1) [t0, t1] = [t1, t0];
    t0 = Math.max(0, t0);
    t1 = Math.min(L, t1);
    if (t1 - t0 > tol) dashes.push([t0, t1]);
    else if (t1 >= -tol && t0 <= L + tol) dots.push(Math.min(L, Math.max(0, (t0 + t1) / 2)));
  };
  for (const e of ents) {
    if (e.type === 'LINE') addSeg(e.start, e.end);
    else if (e.type === 'POINT') {
      if (Math.abs(off(e.position)) <= tol) {
        const t = along(e.position);
        if (t >= -tol && t <= L + tol) dots.push(Math.min(L, Math.max(0, t)));
      }
    } else if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
      const path = entityPath(e);
      for (const pc of path?.pieces ?? []) if (pc.k === 'line') addSeg(pc.a, pc.b);
    } else if (e.type === 'TEXT') {
      const t = along(e.insert);
      if (t < -tol || t > L + tol) continue;
      const style = doc.textStyles.get(tableKey(e.style));
      const rot = e.rotation - Math.atan2(u.y, u.x);
      const deg = ((((rot * 180) / Math.PI) % 360) + 360) % 360;
      marks.push({
        t: Math.min(L, Math.max(0, t)),
        kind: 'text',
        el: { flags: 2, text: e.text, styleHandle: style?.handle, scale: e.height, rotation: rot, offset: { x: 0, y: off(e.insert) } },
        lin: `["${e.text.replace(/"/g, "'")}",${style?.name ?? e.style},S=${fmt(e.height)},R=${fmt(deg)},X=0,Y=${fmt(off(e.insert))}]`,
      });
    } else if (e.type === 'SHAPE') {
      const t = along(e.insert);
      if (t < -tol || t > L + tol) continue;
      const style = e.styleHandle ? [...doc.textStyles.values()].find((s) => s.handle === e.styleHandle) : undefined;
      const rot = e.rotation - Math.atan2(u.y, u.x);
      const deg = ((((rot * 180) / Math.PI) % 360) + 360) % 360;
      marks.push({
        t: Math.min(L, Math.max(0, t)),
        kind: 'shape',
        el: { flags: 4, shapeNumber: e.shapeNumber, styleHandle: e.styleHandle, scale: e.size, rotation: rot, offset: { x: 0, y: off(e.insert) } },
        lin: `[${e.name},${style?.font || 'ltypeshp.shx'},S=${fmt(e.size)},R=${fmt(deg)},X=0,Y=${fmt(off(e.insert))}]`,
      });
    }
  }
  if (!dashes.length && !dots.length) return '정의 선 위에 선이나 점이 없습니다. 시작점과 끝점 사이에 선·점을 그리고 고르십시오.';
  // 대시 합치기
  dashes.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const d of dashes) {
    const last = merged[merged.length - 1];
    if (last && d[0] <= last[1] + tol) last[1] = Math.max(last[1], d[1]);
    else merged.push([d[0], d[1]]);
  }
  // 대시 안의 점은 대시에 묻힌다
  const freeDots = [...new Set(dots.map((t) => Math.round(t / tol) * tol))].filter((t) => !merged.some(([a, b]) => t >= a - tol && t <= b + tol)).sort((a, b) => a - b);
  // 그리는 것들(t 순서): 대시 [a, b] 또는 점 t
  type Piece = { a: number; b: number };
  const pieces: Piece[] = [...merged.map(([a, b]) => ({ a, b })), ...freeDots.map((t) => ({ a: t, b: t }))].sort((p, q) => p.a - q.a);
  // 첫 그리는 것에서 시작하도록 돌린다(앞 틈은 끝 틈에 더한다)
  const shift = pieces[0]!.a;
  const rel = (t: number) => {
    let r = t - shift;
    if (r < -tol) r += L;
    return Math.max(0, Math.min(L, r));
  };
  // 경계(요소가 시작하는 자리): 그리는 것의 시작·끝, 복합 요소 자리
  const segs: { a: number; b: number; dash: boolean }[] = [];
  let cur = 0;
  for (const p of pieces) {
    const a = p.a - shift;
    const b = p.b - shift;
    if (a - cur > tol) segs.push({ a: cur, b: a, dash: false });
    segs.push({ a, b, dash: true });
    cur = Math.max(cur, b);
  }
  if (L - cur > tol) segs.push({ a: cur, b: L, dash: false });
  // 복합 요소 자리에서 조각을 나눈다
  const cuts = marks.map((m) => ({ ...m, r: rel(m.t) })).sort((a, b) => a.r - b.r);
  const split: { a: number; b: number; dash: boolean; mark?: Mark }[] = [];
  for (const s of segs) {
    let a = s.a;
    for (const c of cuts) {
      if (c.r > a + tol && c.r < s.b - tol) {
        split.push({ a, b: c.r, dash: s.dash });
        a = c.r;
      }
    }
    split.push({ a, b: s.b, dash: s.dash });
  }
  for (const c of cuts) {
    const at = split.find((s) => Math.abs(s.a - c.r) <= tol && !s.mark) ?? split.find((s) => c.r >= s.a - tol && c.r <= s.b + tol && !s.mark);
    if (at) at.mark = c;
  }
  const elements: LinetypeElement[] = [];
  const lin: string[] = [];
  for (const s of split) {
    const len = Number((s.b - s.a).toPrecision(12));
    const value = s.dash ? (len > tol ? len : 0) : -len;
    if (s.mark) {
      elements.push({ ...s.mark.el, length: value } as LinetypeElement);
      lin.push(s.mark.lin);
    } else elements.push({ length: value, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } });
    lin.push(fmt(value));
  }
  return { elements, pattern: `A,${lin.join(',')}`, patternLength: L };
}

/** 선종류 표 레코드 */
export function makeLinetypeRecord(name: string, description: string, elements: LinetypeElement[], patternLength: number, handle: string): Linetype {
  return { name, handle, flags: 0, description, patternLength, elements };
}

/** .lin 파일 내용(한 선종류) */
export function linFileText(name: string, description: string, pattern: string): string {
  return `;; OpenCAD 2D 뷰어 MKLTYPE로 만든 선종류\n*${name},${description}\n${pattern}\n`;
}

/** 선종류 이름이 쓸 수 있는지(아니면 안내 문구) */
export function linetypeNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return '선종류 이름을 입력하십시오.';
  if (n.length > 255) return '이름이 너무 깁니다.';
  if (/[<>/\\":;?*|,=`]/.test(n)) return '선종류 이름에 < > / \\ " : ; ? * | , = ` 은 쓸 수 없습니다.';
  if (/^(bylayer|byblock|continuous)$/i.test(n)) return `"${n}"은(는) 예약된 선종류 이름입니다.`;
  return null;
}
