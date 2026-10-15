/**
 * 3D 문서(탭 하나)의 상태와 형식별 도움 함수(순수, DOM 없음).
 * 뷰어 인스턴스는 하나를 돌려 쓰므로, 탭마다 카메라·숨긴 묶음·강조·재생 위치를 여기에 기억해 두었다가 되돌린다.
 */
import type { CameraState, MeasureResult, Pick3d, RenderMode, Scene3d } from '../../viewer3d/index';
import { NC_DIALECT_NAMES } from '../../formats/nc/model';
import type { MprPayload, NcOpenOptions, NcPayload, View3dFormat, View3dResult } from './protocol';
import { idRange } from './playback';

export interface Doc3d {
  readonly id: number;
  /** 파일 이름 */
  name: string;
  size: number;
  format: View3dFormat;
  scene: Scene3d;
  nc: NcPayload | null;
  mpr: MprPayload | null;
  ncOptions: NcOpenOptions;
  /** 해석 시간(ms) */
  ms: number;
  // ── 보기 상태(탭을 바꿨다 돌아오면 되돌린다) ──
  camera: CameraState | null;
  renderMode: RenderMode;
  hiddenGroups: Set<string>;
  hiddenItems: Set<string>;
  /** 뷰어 강조(항목 id) */
  highlight: string[];
  pick: Pick3d | null;
  measure: MeasureResult | null;
  /** 코드 보기에서 고른 줄(-1 없음)과 덧그림으로 강조할 이동 */
  selLine: number;
  selMoves: number[];
  /** MPR 가공·STEP 제품에서 고른 것(목록 강조) */
  selKey: string | null;
  /** NC 재생 시각(초, null = 전체 경로) */
  playSec: number | null;
  panelTab: string;
  codeScroll: number;
}

let serial = 0;

export function createDoc(name: string, size: number, res: View3dResult, ncOptions: NcOpenOptions = {}): Doc3d {
  return {
    id: ++serial,
    name,
    size,
    format: res.format,
    scene: res.scene,
    nc: res.nc ?? null,
    mpr: res.mpr ?? null,
    ncOptions,
    ms: res.ms,
    camera: null,
    renderMode: 'shadedEdges',
    hiddenGroups: new Set(),
    hiddenItems: new Set(),
    highlight: [],
    pick: null,
    measure: null,
    selLine: -1,
    selMoves: [],
    selKey: null,
    playSec: null,
    panelTab: '',
    codeScroll: 0,
  };
}

/** 장면 단위 → 글 */
export function unitLabel(u: Scene3d['units']): string {
  return u === 'mm' ? 'mm' : u === 'inch' ? 'in' : u === 'm' ? 'm' : '';
}

/** 형식 설명(상태 막대·정보) */
export function docLabel(d: Doc3d): string {
  const meta = (d.scene.meta ?? {}) as Record<string, unknown>;
  if (d.nc) return d.nc.kind === 'heidenhain' ? 'Heidenhain 평문' : `G-code · ${NC_DIALECT_NAMES[d.nc.dialect]}`;
  if (d.mpr) return `woodWOP MPR${typeof meta.version === 'string' && meta.version ? ` ${meta.version}` : ''}`;
  if (d.format === 'step') {
    const schema = Array.isArray(meta.schema) ? [...new Set((meta.schema as unknown[]).map((x) => stepSchemaLabel(String(x))))].join(', ') : '';
    return `STEP${schema ? ` ${schema}` : ''}`;
  }
  if (d.format === 'skp') return `SketchUp${typeof meta.version === 'string' ? ` ${meta.version}` : ''}`;
  return d.format.toUpperCase();
}

/** STEP 스키마 이름 → 짧은 이름(AP203·AP214·AP242), 모르면 { } 앞부분 */
export function stepSchemaLabel(schema: string): string {
  const s = schema.toUpperCase();
  if (s.startsWith('AUTOMOTIVE_DESIGN')) return 'AP214';
  if (s.startsWith('CONFIG_CONTROL_DESIGN')) return 'AP203';
  if (s.startsWith('AP203')) return 'AP203';
  if (s.startsWith('AP242')) return 'AP242';
  if (s.startsWith('AP214')) return 'AP214';
  return schema.replace(/\s*\{.*$/, '').trim();
}

/** 장면 크기 요약 */
export function sceneCounts(s: Scene3d): { triangles: number; segments: number; points: number } {
  let triangles = 0;
  let segments = 0;
  let points = 0;
  for (const m of s.meshes) triangles += (m.indices ? m.indices.length : m.positions.length / 3) / 3;
  for (const l of s.lines) segments += l.positions.length / 6;
  for (const p of s.points ?? []) points += p.positions.length / 3;
  return { triangles: Math.round(triangles), segments: Math.round(segments), points: Math.round(points) };
}

/** 줄 line이 만든 이동 번호들(cap개까지) */
export function lineMoveList(nc: NcPayload, line: number, cap = 5000): number[] {
  const { offsets, moves } = nc.lineMoves;
  if (line < 0 || line + 1 >= offsets.length) return [];
  const s = offsets[line]!;
  const e = Math.min(offsets[line + 1]!, s + cap);
  const out: number[] = [];
  for (let i = s; i < e; i++) out.push(moves[i]!);
  return out;
}

/** 이동 번호들을 장면의 선분 쌍으로(호는 나눈 선분). segmentIds가 오름차순인 NC 선분 묶음만 본다 */
export function moveSegments(scene: Scene3d, moveIds: readonly number[], maxSegs = 200_000): Float32Array {
  const parts: Float32Array[] = [];
  let n = 0;
  const want = [...new Set(moveIds)].sort((a, b) => a - b);
  for (const l of scene.lines) {
    const ids = l.segmentIds;
    if (!ids || !l.id.startsWith('nc-')) continue;
    for (const m of want) {
      const [a, b] = idRange(ids, m);
      if (b <= a) continue;
      parts.push(l.positions.subarray(a * 6, b * 6));
      n += b - a;
      if (n >= maxSegs) break;
    }
    if (n >= maxSegs) break;
  }
  const out = new Float32Array(n * 6);
  let o = 0;
  for (const p of parts) {
    const k = Math.min(p.length, out.length - o);
    out.set(p.subarray(0, k), o);
    o += k;
  }
  return out;
}

/** 이동의 직선 끝점(선분을 못 찾을 때) */
export function moveEndPoint(nc: NcPayload, i: number): [number, number, number] | null {
  if (i < 0 || i >= nc.moves.count) return null;
  const k = (i + 1) * 3;
  const p = nc.moves.points;
  return [p[k]!, p[k + 1]!, p[k + 2]!];
}

/** 공구 번호 → 장면 묶음 이름(선분 묶음 nc-cut-·nc-drill-에서 찾는다) */
export function toolGroup(scene: Scene3d, tool: number): string | null {
  const key = tool < 0 ? 'none' : String(tool);
  const l = scene.lines.find((x) => x.id === `nc-cut-${key}` || x.id === `nc-drill-${key}`);
  return l?.group ?? null;
}

/** 공구 번호 → 장면 항목 id들 */
export function toolItems(scene: Scene3d, tool: number): string[] {
  const key = tool < 0 ? 'none' : String(tool);
  return scene.lines.filter((x) => x.id === `nc-cut-${key}` || x.id === `nc-drill-${key}`).map((x) => x.id);
}

/** STEP 제품 나무 마디(meta.products) */
export interface ProductNode {
  name: string;
  productId: string;
  instance?: string;
  meshIds: string[];
  children: ProductNode[];
}

/** meta.products를 안전하게 읽는다 */
export function stepProducts(scene: Scene3d): ProductNode[] {
  const p = (scene.meta as { products?: unknown } | undefined)?.products;
  if (!Array.isArray(p)) return [];
  const read = (x: unknown, depth: number): ProductNode | null => {
    if (!x || typeof x !== 'object' || depth > 64) return null;
    const o = x as Record<string, unknown>;
    const node: ProductNode = {
      name: String(o.name ?? ''),
      productId: String(o.productId ?? ''),
      meshIds: Array.isArray(o.meshIds) ? (o.meshIds as unknown[]).map(String) : [],
      children: [],
    };
    if (typeof o.instance === 'string' && o.instance) node.instance = o.instance;
    if (Array.isArray(o.children)) for (const c of o.children) {
      const n = read(c, depth + 1);
      if (n) node.children.push(n);
    }
    return node;
  };
  return p.map((x) => read(x, 0)).filter((x): x is ProductNode => !!x);
}

/** 마디와 그 아래 모든 그물 id */
export function subtreeMeshIds(n: ProductNode, out: string[] = []): string[] {
  out.push(...n.meshIds);
  for (const c of n.children) subtreeMeshIds(c, out);
  return out;
}

/** 그물 id가 든 첫 마디의 경로 열쇠("0/2/1") */
export function productKeyOf(nodes: readonly ProductNode[], meshId: string, prefix = ''): string | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const key = prefix ? `${prefix}/${i}` : String(i);
    if (n.meshIds.includes(meshId)) return key;
    const k = productKeyOf(n.children, meshId, key);
    if (k) return k;
  }
  return null;
}

/** 경로 열쇠로 마디 찾기 */
export function productAt(nodes: readonly ProductNode[], key: string): ProductNode | null {
  let list = nodes;
  let node: ProductNode | null = null;
  for (const part of key.split('/')) {
    node = list[Number(part)] ?? null;
    if (!node) return null;
    list = node.children;
  }
  return node;
}

/** SKP: 그물 이름("재질 · 태그")에서 재질별 색·삼각형 수 */
export function skpMaterials(scene: Scene3d): { name: string; color: readonly number[]; triangles: number }[] {
  const map = new Map<string, { name: string; color: readonly number[]; triangles: number }>();
  for (const m of scene.meshes) {
    const name = (m.name ?? '').split(' · ')[0] || '(기본)';
    const tri = (m.indices ? m.indices.length : m.positions.length / 3) / 3;
    const e = map.get(name);
    if (e) e.triangles += tri;
    else map.set(name, { name, color: m.color, triangles: tri });
  }
  return [...map.values()].sort((a, b) => b.triangles - a.triangles);
}
