/**
 * 해치 경계·원점 편집(화면·DOM 없음): HATCHGENERATEBOUNDARY·HATCHSETBOUNDARY·HATCHSETORIGIN의 계산.
 * - 경계 만들기: 해치 경로 → 닫힌 폴리선(선·호), 타원·스플라인 모서리가 있으면 닫힌 스플라인(BOUNDARY와 같은 변환).
 * - 경계 다시 정하기: 고른 객체로 경로를 새로 만들고 무늬·축척·각도·이중·섬 검출·원점을 그대로 둔 해치.
 * - 원점: 무늬 줄의 원점(base)을 옮긴다. 지금 원점은 무늬 정의와 첫 줄에서 되짚는다(DXF 53·43·44 규약:
 *   원점 = 해치 원점 + R(해치 각도)·(x, y)·k, 이동 = R(선 각도)·(dx, dy)·k).
 */
import type { CadDocument, Entity, EntityBase, HatchEdge, HatchEntity, HatchPath, HatchPatternLine, Vec2 } from '../../core/model';
import { boundaryFromEntities, createHatch, estimatePatternLines, findPattern, pathsFillPoint } from '../hatch';
import { boundaryObjects } from '../geom/bpoly';

const DEG = Math.PI / 180;

function rot(x: number, y: number, a: number): Vec2 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** 각도 차(0~π) */
function angleGap(a: number, b: number): number {
  const t = Math.PI * 2;
  let d = Math.abs(a - b) % t;
  if (d > Math.PI) d = t - d;
  return d;
}

/** 원점을 옮길 수 있는 해치인지(단색·그라데이션·무늬 줄 없음은 원점이 없다) */
export function hasPatternOrigin(h: HatchEntity): boolean {
  return !h.solid && !h.gradient && h.patternLines.length > 0;
}

/**
 * 해치 무늬의 지금 원점(HPORIGIN 기준점). 무늬 줄이 없으면 null.
 * 사용자 정의 무늬는 첫 줄의 원점, 사전 무늬는 정의 첫 줄의 (x, y)·k를 빼서 되짚는다.
 * 정의와 줄 수·각도가 맞지 않는 무늬(파일에서 온 사용자 무늬)는 첫 줄의 원점을 원점으로 본다.
 */
export function hatchOrigin(h: HatchEntity): Vec2 | null {
  const l0 = h.patternLines[0];
  if (!l0) return null;
  const user = h.patternType === 0 || h.patternName.toUpperCase() === '_USER';
  if (user) return { x: l0.base.x, y: l0.base.y };
  const def = findPattern(h.patternName);
  const d0 = def?.lines[0];
  if (!def || !d0) return { x: l0.base.x, y: l0.base.y };
  const n = def.lines.length;
  if (h.patternLines.length !== n && h.patternLines.length !== n * 2) return { x: l0.base.x, y: l0.base.y };
  for (let i = 0; i < n; i++) if (angleGap(def.lines[i]!.angle * DEG + h.patternAngle, h.patternLines[i]!.angle) > 1e-6) return { x: l0.base.x, y: l0.base.y };
  // 축척 k = 저장된 이동 길이 / 정의 이동 길이(미터법·ISO 펜 폭을 따로 알 필요가 없다)
  const dl = Math.hypot(d0.dx, d0.dy);
  const sl = Math.hypot(l0.offset.x, l0.offset.y);
  const k = dl > 1e-12 && sl > 0 ? sl / dl : h.patternScale || 1;
  const b = rot(d0.x * k, d0.y * k, h.patternAngle);
  return { x: l0.base.x - b.x, y: l0.base.y - b.y };
}

/** 무늬 줄을 (dx, dy)만큼 옮긴 사본 */
export function shiftPatternLines(lines: readonly HatchPatternLine[], dx: number, dy: number): HatchPatternLine[] {
  return lines.map((l) => ({ angle: l.angle, base: { x: l.base.x + dx, y: l.base.y + dy }, offset: { ...l.offset }, dashes: [...l.dashes] }));
}

/** 무늬 원점을 origin으로 바꾼 해치(원점이 없는 해치면 null) */
export function withHatchOrigin(h: HatchEntity, origin: Vec2): HatchEntity | null {
  if (!hasPatternOrigin(h)) return null;
  const o = hatchOrigin(h);
  if (!o) return null;
  return { ...h, patternLines: shiftPatternLines(h.patternLines, origin.x - o.x, origin.y - o.y) };
}

const TAU = Math.PI * 2;
const isFull = (a0: number, a1: number) => Math.abs(Math.abs(a1 - a0) - TAU) < 1e-9;

/**
 * 한 바퀴 원·타원 모서리를 반 바퀴 둘로 나눈 경로(원 경계를 폴리선으로 바꾸면 볼록도가 무한대가 되는 것을 막는다).
 * 원에서 바로 만든 해치 경로(객체 선택 경계)가 이렇게 한 바퀴 모서리 하나로 들어 있다.
 */
export function splitFullEdges(paths: readonly HatchPath[]): HatchPath[] {
  return paths.map((p) => {
    if (!p.edges?.some((e) => (e.type === 'arc' || e.type === 'ellipse') && isFull(e.startAngle, e.endAngle))) return p;
    const edges: HatchEdge[] = [];
    for (const e of p.edges) {
      if ((e.type === 'arc' || e.type === 'ellipse') && isFull(e.startAngle, e.endAngle)) {
        const s = Math.min(e.startAngle, e.endAngle);
        const halves: [number, number][] = [
          [s, s + Math.PI],
          [s + Math.PI, s + TAU],
        ];
        // 시계 방향 모서리는 지나는 차례가 반대(end → start)다
        for (const [a, b] of e.ccw ? halves : halves.reverse()) edges.push({ ...e, startAngle: a, endAngle: b } as HatchEdge);
      } else edges.push(e);
    }
    return { ...p, edges };
  });
}

/**
 * 해치 둘레의 경계 객체(연관 없음). 특성은 base(현재 도면층·색 …), 고도는 해치 고도, OCS는 해치 OCS를 따른다.
 * 선·호 경로는 닫힌 LWPOLYLINE, 타원·스플라인 모서리가 섞인 경로는 닫힌 SPLINE.
 */
export function hatchBoundaryEntities(h: HatchEntity, base: Omit<EntityBase, 'type'>): Entity[] {
  const out = boundaryObjects(splitFullEdges(h.paths), { ...base, handle: '' }, h.elevation || 0);
  if (h.extrusion && (Math.abs(h.extrusion.x) > 1e-12 || Math.abs(h.extrusion.y) > 1e-12 || h.extrusion.z < 0))
    for (const e of out) if (e.type === 'LWPOLYLINE') e.extrusion = { ...h.extrusion };
  return out;
}

/** 해치 무늬 설정(경계를 바꿔 다시 만들 때 그대로 둔다) */
interface Settings {
  pattern: string;
  scale: number;
  angle: number;
  double: boolean;
  userSpacing?: number;
  style: 0 | 1 | 2;
}

function settingsOf(h: HatchEntity): Settings {
  const user = h.patternType === 0 || h.patternName.toUpperCase() === '_USER';
  const style = (h.hatchStyle === 1 || h.hatchStyle === 2 ? h.hatchStyle : 0) as 0 | 1 | 2;
  if (h.solid && !h.gradient) return { pattern: 'SOLID', scale: 1, angle: h.patternAngle, double: false, style };
  if (user) return { pattern: '_USER', scale: 1, angle: h.patternAngle, double: h.patternDouble, userSpacing: h.patternScale || 1, style };
  return { pattern: h.patternName, scale: h.patternScale || 1, angle: h.patternAngle, double: h.patternDouble, style };
}

/**
 * 해치 경계를 고른 객체로 다시 정한 해치(핸들·특성·무늬·원점은 그대로). 만들 수 없으면 까닭(글).
 * associative가 참이면 새 경계 객체에 연관한다(경로 원본 = 고른 객체).
 */
export function hatchWithBoundary(doc: CadDocument, h: HatchEntity, boundary: Entity[], associative: boolean, lineLimit = Infinity): HatchEntity | string {
  const paths = boundaryFromEntities(doc, boundary);
  if (!paths.length) return '고른 객체로 닫힌 경계를 만들 수 없습니다.';
  const seed = pathsFillPoint(paths);
  const seedPoints = seed ? [seed] : [];
  let n: HatchEntity;
  const s = settingsOf(h);
  const known = s.pattern === 'SOLID' || s.pattern === '_USER' || !!findPattern(s.pattern);
  if (h.gradient || !known) {
    // 그라데이션과 사전에 없는 무늬는 무늬 줄을 그대로 쓴다(무늬 줄은 원점 기준이라 경계와 무관하다)
    n = { ...h, paths: paths.map((p) => ({ ...p })), seedPoints };
  } else {
    const made = createHatch(doc, paths, {
      pattern: s.pattern,
      scale: s.scale,
      angle: s.angle,
      double: s.double,
      userSpacing: s.userSpacing,
      style: s.style,
      associative,
      layer: h.layer,
      seedPoints,
      origin: hatchOrigin(h) ?? undefined,
    });
    n = { ...h, patternName: made.patternName, solid: made.solid, patternType: made.patternType, patternAngle: made.patternAngle, patternScale: made.patternScale, patternDouble: made.patternDouble, patternLines: made.patternLines, hatchStyle: made.hatchStyle, paths: made.paths, seedPoints: made.seedPoints };
    // 파일에서 읽은 무늬 줄이 사전 정의와 달랐으면(줄 수가 다르면) 원래 줄을 지킨다
    if (h.patternLines.length && made.patternLines.length !== h.patternLines.length) n.patternLines = h.patternLines.map((l) => ({ ...l, base: { ...l.base }, offset: { ...l.offset }, dashes: [...l.dashes] }));
  }
  const assoc = associative && n.paths.every((p) => (p.sources?.length ?? 0) > 0);
  n.associative = assoc;
  if (!assoc)
    n.paths = n.paths.map((p) => {
      const q = { ...p };
      delete q.sources;
      return q;
    });
  if (estimatePatternLines(n) > lineLimit) return '해치 무늬 축척이 너무 작거나 영역이 너무 큽니다. 축척을 키우십시오.';
  return n;
}

/**
 * 경계를 바꾼 뒤 경계 객체의 반응자(reactors) 맞추기: 옛 경계에서 해치 핸들을 빼고 새 경계에 더한 사본들.
 * 같은 객체가 옛·새 경계에 모두 있으면 그대로 둔다.
 */
export function relinkReactors(doc: CadDocument, before: HatchEntity, after: HatchEntity): { before: Entity; after: Entity }[] {
  const id = after.handle || before.handle;
  if (!id) return [];
  const sources = (h: HatchEntity) => (h.associative ? h.paths.flatMap((p) => p.sources ?? []) : []);
  const oldS = new Set(sources(before));
  const newS = new Set(sources(after));
  const out: { before: Entity; after: Entity }[] = [];
  for (const s of new Set([...oldS, ...newS])) {
    const e = doc.entityIndex.get(s);
    if (!e) continue;
    const r = e.reactors ?? [];
    const has = r.includes(id);
    const want = newS.has(s);
    if (has === want) continue;
    const next = want ? [...r, id] : r.filter((x) => x !== id);
    const a = { ...e } as Entity;
    if (next.length) a.reactors = next;
    else delete a.reactors;
    out.push({ before: e, after: a });
  }
  return out;
}
