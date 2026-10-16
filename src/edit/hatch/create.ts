/**
 * HATCH 객체 만들기와 연관(반응자) 도우미.
 */
import type { CadDocument, Entity, HatchEntity, HatchGradient, HatchPath, Vec2 } from '../../core/model';
import { entityDefaults } from '../../core/model';
import { pathLoop } from '../../render/hatch';
import { pathsFillPoint } from './boundary';
import { patternLines, userPatternLines } from './lines';
import { findPattern } from './patterns';
import { numArray } from '../../core/lwpoly';

export interface CreateHatchOptions {
  /** 무늬 이름('SOLID', 'ANSI31' …, 사용자 정의는 '_USER') */
  pattern: string;
  /** 무늬 축척(사용자 정의는 userSpacing이 없을 때 간격) */
  scale?: number;
  /** 무늬 각도(라디안) */
  angle?: number;
  /** 이중(사용자 정의 무늬에서 90° 교차) */
  double?: boolean;
  /** 사용자 정의 무늬 간격(주면 사용자 정의 무늬가 된다) */
  userSpacing?: number;
  /** 0 홀짝(normal), 1 가장 바깥(outer), 2 무시(ignore) */
  style?: 0 | 1 | 2;
  /** 연관(기본: 모든 경로에 원본 객체가 있으면 참) */
  associative?: boolean;
  layer?: string;
  gradient?: HatchGradient;
  /** 해치 원점(HPORIGIN) */
  origin?: Vec2;
  /** ISO 무늬의 펜 폭(mm). 주면 ISO 무늬 축척 = 펜 폭 */
  isoPenWidth?: number;
  /** 씨앗점(점 선택의 선택점). 없으면 바깥 경로 안쪽 점 */
  seedPoints?: Vec2[];
  /** 미터법 여부(없으면 도면 $MEASUREMENT) */
  metric?: boolean;
}

function clonePath(p: HatchPath, keepSources: boolean): HatchPath {
  const out: HatchPath = { flags: p.flags };
  if (p.polyline) out.polyline = { closed: p.polyline.closed, verts: numArray(p.polyline.verts) };
  if (p.edges) out.edges = p.edges.map((e) => structuredClone(e));
  if (keepSources && p.sources?.length) out.sources = [...p.sources];
  return out;
}

function defaultSeed(paths: readonly HatchPath[]): Vec2[] {
  const q = pathsFillPoint(paths);
  return q ? [q] : [];
}

/** HATCH 객체 만들기(handle은 ''). 모르는 무늬 이름이면 예외 */
export function createHatch(doc: CadDocument, paths: HatchPath[], opt: CreateHatchOptions): HatchEntity {
  const name = opt.pattern.trim();
  const upper = name.toUpperCase();
  const angle = opt.angle ?? 0;
  const metric = opt.metric ?? Number(doc.header.get('$MEASUREMENT') ?? 0) === 1;
  const assoc = (opt.associative ?? true) && paths.length > 0 && paths.every((p) => (p.sources?.length ?? 0) > 0);
  const layer = opt.layer ?? String(doc.header.get('$CLAYER') ?? '0');
  const h: HatchEntity = {
    type: 'HATCH',
    ...entityDefaults(),
    layer,
    patternName: 'SOLID',
    solid: true,
    associative: assoc,
    hatchStyle: opt.style ?? 0,
    patternType: 1,
    patternAngle: angle,
    patternScale: 1,
    patternDouble: false,
    elevation: 0,
    paths: paths.map((p) => clonePath(p, assoc)),
    patternLines: [],
    pixelSize: 0,
    seedPoints: opt.seedPoints?.map((s) => ({ x: s.x, y: s.y })) ?? defaultSeed(paths),
  };
  if (opt.gradient) {
    h.gradient = { ...opt.gradient, color1: { ...opt.gradient.color1 }, color2: { ...opt.gradient.color2 } };
    h.patternName = opt.gradient.name || 'LINEAR';
    return h;
  }
  if (upper === 'SOLID') return h;
  if (opt.userSpacing !== undefined || upper === '_USER' || upper === 'USER') {
    const spacing = opt.userSpacing ?? opt.scale ?? 1;
    h.solid = false;
    h.patternName = '_USER';
    h.patternType = 0;
    h.patternScale = spacing;
    h.patternDouble = !!opt.double;
    h.patternLines = userPatternLines(spacing, angle, !!opt.double, opt.origin);
    return h;
  }
  const def = findPattern(name);
  if (!def) throw new Error(`알 수 없는 해치 무늬: ${name}`);
  const scale = def.kind === 'iso' && opt.isoPenWidth ? opt.isoPenWidth : (opt.scale ?? 1);
  h.solid = !def.lines.length;
  h.patternName = def.name;
  h.patternScale = scale;
  h.patternDouble = !!opt.double;
  h.patternLines = patternLines(def, scale, angle, opt.double, { metric, origin: opt.origin });
  return h;
}

/** 무늬 선 수 어림(경계 범위 기준). 렌더러 상한(HATCH_LINE_LIMIT)을 넘으면 "무늬가 너무 촘촘함" */
export function estimatePatternLines(h: HatchEntity): number {
  if (h.solid || !h.patternLines.length) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of h.paths) {
    const f = pathLoop(p, 0);
    for (let i = 0; i + 1 < f.length; i += 2) {
      minX = Math.min(minX, f[i]!);
      maxX = Math.max(maxX, f[i]!);
      minY = Math.min(minY, f[i + 1]!);
      maxY = Math.max(maxY, f[i + 1]!);
    }
  }
  if (!Number.isFinite(minX)) return 0;
  let total = 0;
  for (const l of h.patternLines) {
    const nx = -Math.sin(l.angle);
    const ny = Math.cos(l.angle);
    const sp = Math.abs(l.offset.x * nx + l.offset.y * ny);
    if (sp < 1e-300) return Infinity;
    const ext = Math.abs((maxX - minX) * nx) + Math.abs((maxY - minY) * ny);
    total += ext / sp + 1;
  }
  return Math.ceil(total);
}

// ---------------------------------------------------------------------------
// 연관 해치(반응자)
// ---------------------------------------------------------------------------

/** 해치 경로의 원본 객체 핸들(중복 없이) */
export function hatchSources(h: HatchEntity): string[] {
  const out: string[] = [];
  for (const p of h.paths) for (const s of p.sources ?? []) if (!out.includes(s)) out.push(s);
  return out;
}

/** 해치의 경계 객체(문서에 남아 있는 것만) */
export function boundaryEntitiesOf(doc: CadDocument, h: HatchEntity): Entity[] {
  return hatchSources(h)
    .map((s) => doc.entityIndex.get(s))
    .filter((e): e is Entity => !!e);
}

/**
 * 연관 해치를 문서에 넣은 뒤(핸들이 붙은 뒤) 경계 객체의 reactors에 해치 핸들을 더한 복사본.
 * 편집 세션의 modify 작업(before → after)으로 넣으면 된다. 이미 있으면 건너뛴다.
 */
export function reactorLinks(doc: CadDocument, h: HatchEntity): { before: Entity; after: Entity }[] {
  const out: { before: Entity; after: Entity }[] = [];
  if (!h.handle || !h.associative) return out;
  for (const e of boundaryEntitiesOf(doc, h)) {
    const r = e.reactors ?? [];
    if (r.includes(h.handle)) continue;
    out.push({ before: e, after: { ...e, reactors: [...r, h.handle] } as Entity });
  }
  return out;
}

/** 해치를 지우거나 연관을 끊을 때: 경계 객체 reactors에서 해치 핸들을 뺀 복사본 */
export function reactorUnlinks(doc: CadDocument, h: HatchEntity): { before: Entity; after: Entity }[] {
  const out: { before: Entity; after: Entity }[] = [];
  if (!h.handle) return out;
  for (const e of boundaryEntitiesOf(doc, h)) {
    const r = e.reactors ?? [];
    if (!r.includes(h.handle)) continue;
    const next = r.filter((x) => x !== h.handle);
    const after = { ...e } as Entity;
    if (next.length) after.reactors = next;
    else delete after.reactors;
    out.push({ before: e, after });
  }
  return out;
}

/** 객체에 걸린 연관 해치들(객체 reactors → HATCH, 그 해치 경로가 이 객체를 원본으로 가질 때) */
export function associatedHatches(doc: CadDocument, e: Entity): HatchEntity[] {
  const out: HatchEntity[] = [];
  for (const r of e.reactors ?? []) {
    const h = doc.entityIndex.get(r);
    if (!h || h.type !== 'HATCH' || !h.associative) continue;
    if (h.paths.some((p) => p.sources?.includes(e.handle))) out.push(h);
  }
  return out;
}

/** 연관을 끊은 해치(경로 원본 비우기) */
export function dissociate(h: HatchEntity): HatchEntity {
  return { ...h, associative: false, paths: h.paths.map((p) => clonePath(p, false)) };
}
