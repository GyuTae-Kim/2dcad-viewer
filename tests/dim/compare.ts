/**
 * 치수 블록 비교: 파일에 든 AutoCAD 치수 블록(*D…)과 generateDimensionGeometry 결과를 맞춘다.
 * 선·호·채움·블록 참조·문자·정의점을 종류별로 짝지어 좌표 차이를 잰다.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CadDocument, DimensionEntity, Entity } from '../../src/core/model';
import { generateDimensionGeometry } from '../../src/edit/dim';
import { readCadFile } from '../../src/io/index';
import { plainText } from '../../src/app/inquiry';

export const FIXTURES = process.env.CAD_FIXTURES ?? '/Users/sean/code/prisme-service/.runtime/cad2d-handoff/dwgref';

/**
 * 치수가 든 예제 파일 목록(없으면 빈 배열). AutoCAD 예제 도면(Annotation·Mechanical 등)과 서식에는
 * DIMENSION이 없어 기본으로는 sample_*만 쓴다. CAD_DIM_ALL=1이면 모든 파일을 훑는다.
 */
export function dimFixtures(): string[] {
  const out: string[] = [];
  const all = !!process.env.CAD_DIM_ALL;
  for (const sub of ['all-samples', 'samples-dxf', 'templates']) {
    const dir = join(FIXTURES, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) if (/\.(dwg|dxf)$/i.test(f) && (all || /^sample_/i.test(f))) out.push(join(dir, f));
  }
  return out;
}

export interface DimResult {
  file: string;
  handle: string;
  kind: string;
  ok: boolean;
  /** 맞지 않은 항목 */
  issues: string[];
  /** 가장 큰 좌표 차이 / 기준 길이 */
  rel: number;
}

const KIND = ['회전', '정렬', '각도2선', '지름', '반지름', '각도3점', '세로좌표'];

function kindName(d: DimensionEntity): string {
  if (d.subtype === 'ARC_DIMENSION') return '호길이';
  return KIND[d.dimType & 7] ?? '?';
}

type Pt = { x: number; y: number };

/** 비교용 꼭짓점 목록 */
function keyPoints(e: Entity): Pt[] {
  switch (e.type) {
    case 'LINE':
      return [e.start, e.end];
    case 'ARC': {
      const a0 = e.startAngle;
      const a1 = e.endAngle;
      const c = e.center;
      return [
        { x: c.x + e.radius * Math.cos(a0), y: c.y + e.radius * Math.sin(a0) },
        { x: c.x + e.radius * Math.cos(a1), y: c.y + e.radius * Math.sin(a1) },
        c,
      ];
    }
    case 'SOLID':
      return [...e.points];
    case 'INSERT':
      return [e.insert, { x: e.insert.x + e.scale.x * Math.cos(e.rotation), y: e.insert.y + e.scale.x * Math.sin(e.rotation) }];
    case 'MTEXT': {
      const d = e.direction ? Math.atan2(e.direction.y, e.direction.x) : e.rotation;
      return [e.insert, { x: e.insert.x + e.height * Math.cos(d), y: e.insert.y + e.height * Math.sin(d) }];
    }
    case 'POINT':
      return [e.position];
    default:
      return [];
  }
}

/** 점 집합 거리(순서 무시, 선은 방향 무시) */
function setDist(a: Pt[], b: Pt[], ordered: boolean): number {
  if (a.length !== b.length) return Infinity;
  const d = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
  if (ordered) return Math.max(0, ...a.map((p, i) => d(p, b[i]!)));
  if (a.length === 2) return Math.min(Math.max(d(a[0]!, b[0]!), d(a[1]!, b[1]!)), Math.max(d(a[0]!, b[1]!), d(a[1]!, b[0]!)));
  // 작은 집합: 탐욕 짝짓기
  const used = new Set<number>();
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    let bi = -1;
    b.forEach((q, i) => {
      if (used.has(i)) return;
      const x = d(p, q);
      if (x < best) {
        best = x;
        bi = i;
      }
    });
    used.add(bi);
    worst = Math.max(worst, best);
  }
  return worst;
}

const textNorm = (s: string) => plainText(s.replace(/\\A\d;/g, '')).replace(/⌀/g, '∅');

/** 기준 길이: 블록 크기 */
function extentOf(ents: Entity[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of ents)
    for (const q of keyPoints(e)) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    }
  return Math.hypot(maxX - minX, maxY - minY) || 1;
}

export function compareDimension(doc: CadDocument, d: DimensionEntity, file: string, tol = 1e-3): DimResult {
  const issues: string[] = [];
  const blk = doc.blocks.get(d.block.toUpperCase());
  // R12: 문자는 TEXT·*U 블록으로 풀려 있어 비교하지 않는다
  const r12 = !(blk?.entities ?? []).some((e) => e.type === 'MTEXT') && (blk?.entities ?? []).some((e) => e.type === 'TEXT' || (e.type === 'INSERT' && e.block.startsWith('*')));
  const keep = (e: Entity) => ['LINE', 'ARC', 'SOLID', 'INSERT', 'MTEXT', 'POINT'].includes(e.type) && !(r12 && (e.type === 'MTEXT' || (e.type === 'INSERT' && e.block.startsWith('*'))));
  const ref = (blk?.entities ?? []).filter(keep);
  const g = generateDimensionGeometry(doc, d);
  const got = g.entities.filter(keep);
  const size = extentOf(ref);
  let rel = 0;
  for (const type of ['LINE', 'ARC', 'SOLID', 'INSERT', 'MTEXT', 'POINT']) {
    const ra = ref.filter((e) => e.type === type);
    const ga = got.filter((e) => e.type === type);
    if (ra.length !== ga.length) {
      issues.push(`${type} 개수 ${ga.length}/${ra.length}`);
      continue;
    }
    const used = new Set<number>();
    for (const r of ra) {
      let best = Infinity;
      let bi = -1;
      ga.forEach((x, i) => {
        if (used.has(i)) return;
        if (type === 'INSERT' && (x as { block: string }).block.toUpperCase() !== (r as { block: string }).block.toUpperCase()) return;
        const dd = setDist(keyPoints(r), keyPoints(x), type === 'INSERT' || type === 'MTEXT');
        if (dd < best) {
          best = dd;
          bi = i;
        }
      });
      if (bi < 0) {
        issues.push(`${type} 짝 없음`);
        continue;
      }
      used.add(bi);
      const x = ga[bi]!;
      rel = Math.max(rel, best / size);
      if (best > tol * size) issues.push(`${type} 위치 ${(best / size).toExponential(2)}`);
      if (type === 'MTEXT') {
        const rt = textNorm((r as { text: string }).text);
        const gt = textNorm((x as { text: string }).text);
        if (rt !== gt) issues.push(`문자 ${JSON.stringify(gt)} ≠ ${JSON.stringify(rt)}`);
        const rh = (r as { height: number }).height;
        const gh = (x as { height: number }).height;
        if (Math.abs(rh - gh) > 1e-9 * Math.max(1, rh)) issues.push(`문자 높이 ${gh} ≠ ${rh}`);
      }
      if (r.color.aci !== x.color.aci) issues.push(`${type} 색 ${x.color.aci} ≠ ${r.color.aci}`);
      if (type === 'LINE' || type === 'ARC') {
        if (r.linetype.toUpperCase() !== x.linetype.toUpperCase()) issues.push(`${type} 선종류 ${x.linetype} ≠ ${r.linetype}`);
        if (doc.format === 'dwg' && doc.version >= 'AC1015' && r.lineweight !== x.lineweight) issues.push(`${type} 선가중치 ${x.lineweight} ≠ ${r.lineweight}`);
      }
    }
  }
  if (Number.isFinite(d.measurement) && !(doc.version < 'AC1015' && d.measurement === 0) && Math.abs(g.measurement - d.measurement) > 1e-6 * Math.max(1, Math.abs(d.measurement))) issues.push(`측정값 ${g.measurement} ≠ ${d.measurement}`);
  if (!(d.dimType & 128)) {
    const dt = Math.hypot(g.textMid.x - d.textMid.x, g.textMid.y - d.textMid.y);
    rel = Math.max(rel, dt / size);
    if (dt > tol * size) issues.push(`문자 중간점 ${(dt / size).toExponential(2)}`);
  }
  return { file, handle: d.handle, kind: kindName(d), ok: issues.length === 0, issues, rel };
}

/** 파일 하나의 치수 전부 비교 */
export function compareFile(path: string, tol = 1e-3): DimResult[] {
  const doc = readCadFile(new Uint8Array(readFileSync(path)), path);
  const out: DimResult[] = [];
  for (const b of doc.blocks.values())
    for (const e of b.entities) {
      if (e.type !== 'DIMENSION') continue;
      const blk = doc.blocks.get(e.block.toUpperCase());
      if (!blk || !blk.entities.length) continue;
      out.push(compareDimension(doc, e, path.split('/').pop()!, tol));
    }
  return out;
}

/** 종류별 일치율 표 */
export function summarize(rs: DimResult[]): string {
  const by = new Map<string, { ok: number; all: number }>();
  for (const r of rs) {
    const s = by.get(r.kind) ?? { ok: 0, all: 0 };
    s.all++;
    if (r.ok) s.ok++;
    by.set(r.kind, s);
  }
  const lines = [...by].map(([k, s]) => `${k}: ${s.ok}/${s.all}`);
  const ok = rs.filter((r) => r.ok).length;
  lines.push(`전체: ${ok}/${rs.length}`);
  return lines.join('\n');
}
