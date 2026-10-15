/**
 * STEP → Scene3d.
 *
 * 제품 구조: PRODUCT_DEFINITION ← PRODUCT_DEFINITION_SHAPE ← SHAPE_DEFINITION_REPRESENTATION → 표현(SHAPE_REPRESENTATION…),
 * 표현끼리는 SHAPE_REPRESENTATION_RELATIONSHIP(같은 좌표)로 잇고, 조립은 NEXT_ASSEMBLY_USAGE_OCCURRENCE(부모→자식)와
 * CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION → ITEM_DEFINED_TRANSFORMATION)
 * 또는 MAPPED_ITEM(REPRESENTATION_MAP)으로 자식을 놓는다. 같은 형상 항목은 한 번만 삼각화하고 Mesh3d.matrix로 여러 번 놓는다.
 * 표현마다 맥락 단위가 다르면 장면 단위(뿌리 표현의 길이 단위)로 바꾼다.
 */
import type { Box3, Mesh3d, Rgba, Scene3d } from '../../viewer3d/types';
import { BrepMesher, isMeshableType, isTessellatedType, type ItemMesh } from './brep';
import { Geometry } from './geometry';
import { frameMatrix, identity, invert, isIdentity, makeFrame, type M4, mul, normalize, transformPoint, type V3 } from './math';
import { isA, num, partOf, refId, refList, StepFile, StepRef, text } from './part21';
import { readStyles } from './styles';
import { type ContextUnits, contextUnits, DEFAULT_UNITS, sceneUnitMm, sceneUnitOf } from './units';

export interface StepOptions {
  /** 장면 이름(기본: 파일 머리의 FILE_NAME 또는 'STEP') */
  name?: string;
  /** 부품 크기(꼭짓점 상자 대각선) 대비 현 높이. 기본 0.001 */
  tolerance?: number;
  /** 절대 현 높이(모형 단위). 주면 tolerance 대신 */
  chordTolerance?: number;
  /** 이웃 접선·법선 사이 최대 각(도). 기본 20 */
  angleTolerance?: number;
  /** 진행률(0~1)과 단계 이름 */
  onProgress?: (fraction: number, stage: string) => void;
  /** 면 경계 모서리 선(Mesh3d.edges)을 만들지. 기본 true */
  edges?: boolean;
}

/** 화면 패널용 제품 나무 마디 */
export interface StepProductNode {
  /** 제품 이름(PRODUCT.name, 없으면 id) */
  name: string;
  /** 제품 번호(PRODUCT.id) */
  productId: string;
  /** 이 자리(인스턴스)의 이름(NEXT_ASSEMBLY_USAGE_OCCURRENCE.name/id), 뿌리면 없음 */
  instance?: string;
  /** 이 자리에 바로 놓인 그물 id */
  meshIds: string[];
  children: StepProductNode[];
}

/** meta에 넣는 요약 */
export interface StepMeta {
  format: 'STEP';
  schema: string[];
  header: StepFile['header'];
  /** 제품 나무(뿌리들) */
  products: StepProductNode[];
  /** 제품별 인스턴스 수 */
  productCounts: { name: string; productId: string; instances: number }[];
  entityCount: number;
  stats: {
    solids: number;
    faces: number;
    failedFaces: number;
    triangles: number;
    instances: number;
    parseMs: number;
    meshMs: number;
    totalMs: number;
  };
  /** 길이 단위 이름(원래 파일) */
  lengthUnit: string;
}

interface RepInfo {
  id: number;
  type: string;
  items: number[];
  units: ContextUnits;
}

const DEFAULT_COLOR: Rgba = [0.75, 0.75, 0.78, 1];

/** STEP 바이트 → 장면 */
export function stepToScene(bytes: Uint8Array, opts: StepOptions = {}): Scene3d {
  const t0 = now();
  const progress = opts.onProgress ?? (() => {});
  progress(0, '읽기');
  const f = new StepFile(bytes);
  const tParse = now();
  progress(0.05, '구조');
  const warnings: string[] = [];
  if (f.skipped) warnings.push(`문법 오류로 건너뛴 문장 ${f.skipped}개`);
  const styles = readStyles(f);
  const geom = new Geometry(f);
  const mesher = new BrepMesher(f, geom, (id) => styles.colors.get(id), {
    relTol: opts.tolerance ?? 0.001,
    absTol: opts.chordTolerance,
    angle: ((opts.angleTolerance ?? 20) * Math.PI) / 180,
  });

  // ── 표현 ──
  const repCache = new Map<number, RepInfo | null>();
  const ctxCache = new Map<number, ContextUnits>();
  const rep = (id: number): RepInfo | null => {
    const hit = repCache.get(id);
    if (hit !== undefined) return hit;
    const e = f.get(id);
    let r: RepInfo | null = null;
    if (e) {
      const args = e.parts ? (e.parts.find((p) => p.type.endsWith('REPRESENTATION') && p.args.length >= 3)?.args ?? null) : e.args;
      if (args && Array.isArray(args[1]) && args[2] instanceof StepRef) {
        const ctx = refId(args[2]);
        let u = ctxCache.get(ctx);
        if (!u) ctxCache.set(ctx, (u = contextUnits(f, ctx)));
        r = { id, type: e.type, items: refList(args[1]), units: u };
      }
    }
    repCache.set(id, r);
    return r;
  };

  // ── 제품 구조 ──
  const pdReps = new Map<number, number[]>(); // PRODUCT_DEFINITION → 표현
  const repOwner = new Map<number, number>(); // 표현 → PRODUCT_DEFINITION
  for (const id of f.idsOfType('SHAPE_DEFINITION_REPRESENTATION')) {
    const e = f.get(id);
    if (!e) continue;
    const pds = f.get(refId(e.args[0]));
    const r = refId(e.args[1]);
    if (!pds || !r) continue;
    const def = refId(pds.args[2]);
    const dt = f.typeOf(def);
    if (!dt.startsWith('PRODUCT_DEFINITION') || dt.startsWith('PRODUCT_DEFINITION_SHAPE')) continue;
    let l = pdReps.get(def);
    if (!l) pdReps.set(def, (l = []));
    l.push(r);
    if (!repOwner.has(r)) repOwner.set(r, def);
  }
  const srrLinks = new Map<number, number[]>();
  for (const id of f.idsOfType('SHAPE_REPRESENTATION_RELATIONSHIP')) {
    const e = f.get(id);
    if (!e) continue;
    if (e.parts && partOf(e, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')) continue;
    const args = e.parts ? (partOf(e, 'REPRESENTATION_RELATIONSHIP')?.args ?? partOf(e, 'SHAPE_REPRESENTATION_RELATIONSHIP')?.args ?? []) : e.args;
    const r1 = refId(args[2]);
    const r2 = refId(args[3]);
    if (!r1 || !r2) continue;
    for (const [a, b] of [
      [r1, r2],
      [r2, r1],
    ] as const) {
      let l = srrLinks.get(a);
      if (!l) srrLinks.set(a, (l = []));
      l.push(b);
    }
  }
  /** 제품의 표현들(같은 좌표로 이어진 것 포함, 다른 제품의 표현은 넘지 않는다) */
  const repsOfPd = (pd: number): number[] => {
    const start = pdReps.get(pd) ?? [];
    const seen = new Set<number>(start);
    const queue = [...start];
    while (queue.length) {
      const r = queue.shift()!;
      for (const o of srrLinks.get(r) ?? []) {
        if (seen.has(o)) continue;
        const owner = repOwner.get(o);
        if (owner !== undefined && owner !== pd) continue;
        seen.add(o);
        queue.push(o);
      }
    }
    return [...seen];
  };

  interface Usage {
    nauo: number;
    child: number;
    name: string;
  }
  const children = new Map<number, Usage[]>();
  const isChild = new Set<number>();
  for (const id of f.idsOfType('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) {
    const e = f.get(id);
    if (!e) continue;
    const parent = refId(e.args[3]);
    const child = refId(e.args[4]);
    if (!parent || !child) continue;
    let l = children.get(parent);
    if (!l) children.set(parent, (l = []));
    l.push({ nauo: id, child, name: text(e.args[1]) || text(e.args[0]) || text(e.args[5]) });
    isChild.add(child);
  }
  // NAUO → 자리 변환 관계
  const nauoRel = new Map<number, number>();
  for (const id of f.idsOfType('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) {
    const e = f.get(id);
    if (!e) continue;
    const pds = f.get(refId(e.args[1]));
    if (!pds) continue;
    nauoRel.set(refId(pds.args[2]), refId(e.args[0]));
  }

  const productName = (pd: number): { name: string; id: string } => {
    const e = f.get(pd);
    const form = e ? f.get(refId(e.args[2])) : undefined;
    const prod = form ? f.get(refId(form.args[2])) : undefined;
    const id = prod ? text(prod.args[0]) : '';
    let name = prod ? text(prod.args[1]) : '';
    if (!name) name = id || (e ? text(e.args[1]) || text(e.args[0]) : '');
    // 이름이 비면 표현 이름, 그다음 파일 머리 이름
    if (!name) for (const r of pdReps.get(pd) ?? []) if (!name) name = text(f.get(r)?.args[0]);
    if (!name) name = baseName(f.header.name);
    return { name: name || `제품 #${pd}`, id };
  };

  // ── 단위 ──
  let sceneUnits: 'mm' | 'inch' | 'm' | 'unknown' = 'unknown';
  let sceneMm = 1;
  let lengthUnit = '';
  const pickUnits = (u: ContextUnits) => {
    if (sceneUnits !== 'unknown' || !u.known) return;
    if (u.lengthMm === 1 || u.lengthMm === 25.4 || u.lengthMm === 1000) sceneUnits = sceneUnitOf(u.lengthMm);
    else sceneUnits = u.lengthMm > 100 ? 'm' : u.lengthMm > 10 ? 'inch' : 'mm';
    sceneMm = sceneUnitMm(sceneUnits);
    lengthUnit = u.lengthName;
  };

  // ── 변환 ──
  /** 배치 행렬(표현 단위 → 장면 단위) */
  const placement = (id: number, repUnits: ContextUnits): M4 | null => {
    const e = f.get(id);
    if (!e) return null;
    const k = repUnits.lengthMm / sceneMm;
    if (e.type === 'AXIS2_PLACEMENT_3D' || e.type === 'AXIS2_PLACEMENT_2D' || e.type === 'AXIS1_PLACEMENT') {
      const fr = geom.frame(id);
      if (!fr) return null;
      return frameMatrix({ ...fr, o: [fr.o[0] * k, fr.o[1] * k, fr.o[2] * k] });
    }
    if (e.type.startsWith('CARTESIAN_TRANSFORMATION_OPERATOR')) {
      // 끝에서부터: (… axis1, axis2, local_origin, scale[, axis3])
      const a = e.args;
      const is3 = e.type.endsWith('_3D');
      const n = a.length;
      const ax3 = is3 ? geom.direction(refId(a[n - 1])) : null;
      const sc = num(a[is3 ? n - 2 : n - 1], 1) || 1;
      const org = geom.point(refId(a[is3 ? n - 3 : n - 2])) ?? [0, 0, 0];
      const ax2 = geom.direction(refId(a[is3 ? n - 4 : n - 3]));
      const ax1 = geom.direction(refId(a[is3 ? n - 5 : n - 4]));
      const z = ax3 ?? (ax1 && ax2 ? crossV(ax1, ax2) : null);
      const fr = makeFrame([org[0] * k, org[1] * k, org[2] * k], z, ax1);
      const m = frameMatrix(fr, sc);
      return m;
    }
    return null;
  };
  /** 배치가 어느 표현의 항목인지 */
  const itemOf = (repIds: number[], item: number) => repIds.some((r) => rep(r)?.items.includes(item));

  /** NAUO 자리의 자식→부모 변환 */
  const nauoTransform = (nauo: number, parentPd: number, childPd: number): M4 => {
    const relId = nauoRel.get(nauo);
    if (!relId) return identity();
    const rel = f.get(relId);
    if (!rel) return identity();
    const rr = rel.parts ? (partOf(rel, 'REPRESENTATION_RELATIONSHIP')?.args ?? []) : rel.args;
    const rwt = rel.parts ? partOf(rel, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION') : undefined;
    const r1 = refId(rr[2]);
    const r2 = refId(rr[3]);
    const opId = rwt ? refId(rwt.args[0]) : refId(rel.args[rel.args.length - 1]);
    const op = f.get(opId);
    if (!op) return identity();
    const childReps = repsOfPd(childPd);
    const parentReps = repsOfPd(parentPd);
    const u1 = rep(r1)?.units ?? DEFAULT_UNITS;
    const u2 = rep(r2)?.units ?? DEFAULT_UNITS;
    if (op.type === 'ITEM_DEFINED_TRANSFORMATION') {
      const i1 = refId(op.args[2]);
      const i2 = refId(op.args[3]);
      // 어느 배치가 자식 표현 것인지: 항목 소속 → 표현 순서 순으로 판단
      let childItem = i1;
      let parentItem = i2;
      let cu = u1;
      let pu = u2;
      const swap = () => {
        childItem = i2;
        parentItem = i1;
        cu = u2;
        pu = u1;
      };
      const i1Child = itemOf(childReps, i1);
      const i2Child = itemOf(childReps, i2);
      const i1Parent = itemOf(parentReps, i1);
      const i2Parent = itemOf(parentReps, i2);
      if (i2Child && !i1Child && (i1Parent || !i2Parent)) swap();
      else if (!(i1Child && !i2Child) && !childReps.includes(r1) && (childReps.includes(r2) || parentReps.includes(r1))) swap();
      const mc = placement(childItem, cu);
      const mp = placement(parentItem, pu);
      if (!mc || !mp) return identity();
      return mul(mp, invert(mc));
    }
    const m = placement(opId, childReps.includes(r1) ? u1 : u2);
    return m ?? identity();
  };

  // ── 그물 캐시와 인스턴스 ──
  const meshCache = new Map<number, ItemMesh | null>();
  const meshes: Mesh3d[] = [];
  const productCount = new Map<number, number>();
  let solids = 0;
  let faces = 0;
  let failedFaces = 0;
  let triangles = 0;
  const failReasons = new Map<string, number>();
  let totalFaceEstimate = 0;
  let facesDone = 0;
  const onFace = () => {
    facesDone++;
    if ((facesDone & 63) === 0 && totalFaceEstimate > 0) progress(0.1 + 0.85 * Math.min(1, facesDone / totalFaceEstimate), '삼각화');
  };
  const scaledMeshes = new Map<string, ItemMesh>();
  const getMesh = (item: number, units: ContextUnits): ItemMesh | null => {
    let m = meshCache.get(item);
    if (m === undefined) {
      geom.angleFactor = units.angleRad;
      m = mesher.meshItem(item, onFace);
      geom.trim();
      meshCache.set(item, m);
      if (m) {
        solids++;
        faces += m.faces;
        failedFaces += m.failedFaces;
        triangles += m.triangles;
        for (const [k, v] of m.failures) failReasons.set(k, (failReasons.get(k) ?? 0) + v);
      }
    }
    if (!m) return null;
    const k = units.lengthMm / sceneMm;
    if (k === 1) return m;
    const key = `${item}@${k}`;
    let sm = scaledMeshes.get(key);
    if (!sm) {
      const pos = m.positions.map((x) => x * k);
      const edges = m.edges.map((x) => x * k);
      sm = { ...m, positions: pos, edges, bbox: m.bbox ? [scaleV(m.bbox[0], k), scaleV(m.bbox[1], k)] : null };
      scaledMeshes.set(key, sm);
    }
    return sm;
  };
  let meshSeq = 0;
  const instance = (item: number, r: RepInfo, matrix: M4, node: StepProductNode, inheritedColor: Rgba | undefined) => {
    if (styles.hidden.has(item)) return;
    const m = getMesh(item, r.units);
    if (!m) return;
    const id = `step-${++meshSeq}`;
    const itemName = text(f.get(item)?.args[0]);
    const mesh: Mesh3d = {
      id,
      name: itemName && itemName !== node.name ? `${node.name} / ${itemName}` : node.name,
      positions: m.positions,
      normals: m.normals,
      indices: m.indices,
      color: m.color ?? styles.colors.get(item) ?? inheritedColor ?? DEFAULT_COLOR,
      group: node.name,
      doubleSided: !m.closed,
    };
    if (m.colors) mesh.colors = m.colors;
    if (opts.edges !== false && m.edges.length) mesh.edges = m.edges;
    if (!isIdentity(matrix)) mesh.matrix = matrix;
    meshes.push(mesh);
    node.meshIds.push(id);
  };

  const visitedReps = new Set<number>();
  const consumedNauo = new Set<number>();
  /** 표현 하나의 항목들 */
  const visitRep = (repId: number, matrix: M4, node: StepProductNode, pd: number, depth: number, color: Rgba | undefined) => {
    const r = rep(repId);
    if (!r || depth > 32) return;
    visitedReps.add(repId);
    const hasBrep = r.items.some((it) => {
      const t = f.typeOf(it);
      return isMeshableType(t) && !isTessellatedType(t);
    });
    for (const it of r.items) {
      const t = f.typeOf(it);
      if (isMeshableType(t)) {
        // B-rep과 같은 표현에 함께 있는 삼각형 근사(geometric_link 있음)는 겹치므로 건너뛴다
        if (hasBrep && isTessellatedType(t) && hasGeometricLink(f, it)) continue;
        pickUnits(r.units);
        instance(it, r, matrix, node, color);
      } else if (t === 'MAPPED_ITEM') {
        const mi = f.get(it);
        const src = mi ? f.get(refId(mi.args[1])) : undefined;
        if (!mi || !src) continue;
        const mappedRep = refId(src.args[1]);
        const mr = rep(mappedRep);
        if (!mr) continue;
        const mo = placement(refId(src.args[0]), mr.units);
        const mt = placement(refId(mi.args[2]), r.units);
        const T = mo && mt ? mul(mt, invert(mo)) : identity();
        const owner = repOwner.get(mappedRep);
        const use = owner !== undefined ? children.get(pd)?.find((u) => u.child === owner && !consumedNauo.has(u.nauo)) : undefined;
        const col = styles.colors.get(it) ?? color;
        if (use && owner !== undefined) {
          consumedNauo.add(use.nauo);
          const child = makeNode(owner, use.name);
          node.children.push(child);
          visitPd(owner, mul(matrix, T), child, depth + 1, col);
        } else visitRep(mappedRep, mul(matrix, T), node, pd, depth + 1, col);
      }
    }
  };
  const makeNode = (pd: number, instanceName?: string): StepProductNode => {
    const pn = productName(pd);
    productCount.set(pd, (productCount.get(pd) ?? 0) + 1);
    const n: StepProductNode = { name: pn.name, productId: pn.id, meshIds: [], children: [] };
    if (instanceName !== undefined) n.instance = instanceName;
    return n;
  };
  const path = new Set<number>();
  const visitPd = (pd: number, matrix: M4, node: StepProductNode, depth: number, color: Rgba | undefined) => {
    if (path.has(pd) || depth > 32) return;
    path.add(pd);
    for (const r of repsOfPd(pd)) visitRep(r, matrix, node, pd, depth, color);
    for (const use of children.get(pd) ?? []) {
      if (consumedNauo.has(use.nauo)) continue;
      const T = nauoTransform(use.nauo, pd, use.child);
      const child = makeNode(use.child, use.name);
      node.children.push(child);
      visitPd(use.child, mul(matrix, T), child, depth + 1, color);
    }
    path.delete(pd);
  };

  // 뿌리 단위 먼저 정한다(변환 행렬이 장면 단위를 쓴다)
  const pdIds = f.idsOfType('PRODUCT_DEFINITION').concat(
    f.idsOfType('PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS'),
    f.idsOfType('COMPOSITE_ASSEMBLY_DEFINITION'),
    f.idsOfType('COMPOSITE_ASSEMBLY_SEQUENCE_DEFINITION'),
  );
  const roots = pdIds.filter((pd) => !isChild.has(pd) && (pdReps.has(pd) || children.has(pd)));
  for (const pd of roots) {
    for (const r of repsOfPd(pd)) {
      const ri = rep(r);
      if (ri) pickUnits(ri.units);
    }
  }
  if (sceneUnits === 'unknown') for (const u of ctxCache.values()) pickUnits(u);
  if (sceneUnits === 'unknown') {
    // 첫 표현 맥락
    for (const id of f.idsOfType('GEOMETRIC_REPRESENTATION_CONTEXT')) {
      pickUnits(contextUnits(f, id));
      if (sceneUnits !== 'unknown') break;
    }
  }

  // 진행률용 면 수 추정
  totalFaceEstimate = f.idsOfType('ADVANCED_FACE').length + f.idsOfType('FACE_SURFACE').length + f.idsOfType('FACE').length + f.idsOfType('COMPLEX_TRIANGULATED_FACE').length + f.idsOfType('TRIANGULATED_FACE').length;
  progress(0.1, '삼각화');
  const tMesh0 = now();
  const products: StepProductNode[] = [];
  for (const pd of roots) {
    const node = makeNode(pd);
    products.push(node);
    visitPd(pd, identity(), node, 0, undefined);
  }
  // 제품 구조 밖의 형상(구조가 없거나 이어지지 않은 표현)
  if (!meshes.length) {
    const mappedReps = new Set<number>();
    for (const id of f.idsOfType('REPRESENTATION_MAP')) {
      const e = f.get(id);
      if (e) mappedReps.add(refId(e.args[1]));
    }
    const orphan: StepProductNode = { name: opts.name ?? 'STEP', productId: '', meshIds: [], children: [] };
    for (let q = 0; q < f.count; q++) {
      const id = f.allIds()[q]!;
      if (visitedReps.has(id) || mappedReps.has(id)) continue;
      const t = f.typeOf(id);
      if (!t.endsWith('REPRESENTATION') && t !== 'COMPLEX') continue;
      const r = rep(id);
      if (!r || !r.items.some((it) => isMeshableType(f.typeOf(it)) || f.typeOf(it) === 'MAPPED_ITEM')) continue;
      visitRep(id, identity(), orphan, 0, 0, undefined);
    }
    if (orphan.meshIds.length) products.push(orphan);
  }
  // 표현 밖에 홀로 있는 입체(표현이 없는 파일)
  if (!meshes.length) {
    const lone: StepProductNode = { name: opts.name ?? 'STEP', productId: '', meshIds: [], children: [] };
    const used = new Set<number>();
    for (const t of ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL', 'TESSELLATED_SOLID']) {
      for (const id of f.idsOfType(t)) {
        if (used.has(id)) continue;
        used.add(id);
        instance(id, { id: 0, type: '', items: [], units: DEFAULT_UNITS }, identity(), lone, undefined);
      }
    }
    if (lone.meshIds.length) products.push(lone);
  }
  const tMesh = now();

  // 경고
  const unsupported = new Map<string, number>();
  for (const m of [geom.unsupported, mesher.unsupported]) for (const [k, v] of m) unsupported.set(k, (unsupported.get(k) ?? 0) + v);
  for (const [k, v] of [...unsupported].sort((a, b) => b[1] - a[1])) warnings.push(`지원하지 않는 개체 ${k} ${v}개`);
  if (failedFaces) {
    const why = [...failReasons]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    warnings.push(`삼각화하지 못한 면 ${failedFaces}개 / ${faces}개 (${why})`);
  }
  if (!meshes.length) warnings.push('그릴 형상을 찾지 못했다(B-rep·삼각형 형식 없음)');

  // 경계 상자
  let bounds: Box3 | undefined;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const bb = boxOfPositions(m.positions);
    if (!bb) continue;
    const corners: V3[] = [];
    for (let c = 0; c < 8; c++) corners.push([c & 1 ? bb[1][0] : bb[0][0], c & 2 ? bb[1][1] : bb[0][1], c & 4 ? bb[1][2] : bb[0][2]]);
    for (const c of corners) {
      const p = m.matrix ? transformPoint(m.matrix, c) : c;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, p[k]!);
        hi[k] = Math.max(hi[k]!, p[k]!);
      }
    }
  }
  if (Number.isFinite(lo[0])) bounds = { min: lo, max: hi };

  const productCounts = [...productCount].map(([pd, n]) => {
    const pn = productName(pd);
    return { name: pn.name, productId: pn.id, instances: n };
  });
  const meta: StepMeta = {
    format: 'STEP',
    schema: f.header.schemas,
    header: f.header,
    products,
    productCounts,
    entityCount: f.count,
    stats: {
      solids,
      faces,
      failedFaces,
      triangles,
      instances: meshes.length,
      parseMs: Math.round(tParse - t0),
      meshMs: Math.round(tMesh - tMesh0),
      totalMs: Math.round(now() - t0),
    },
    lengthUnit: lengthUnit || (sceneUnits === 'unknown' ? '' : sceneUnits),
  };
  progress(1, '완료');
  const scene: Scene3d = {
    name: opts.name ?? (baseName(f.header.name) || 'STEP'),
    units: sceneUnits,
    meshes,
    lines: [],
    warnings,
    meta: meta as unknown as Record<string, unknown>,
  };
  if (bounds) scene.bounds = bounds;
  return scene;
}

function baseName(path: string): string {
  const b = path.split(/[\\/]/).pop() ?? '';
  return b.replace(/\.(stp|step|p21)$/i, '');
}

function hasGeometricLink(f: StepFile, id: number): boolean {
  const e = f.get(id);
  if (!e) return false;
  if (e.type === 'TESSELLATED_SOLID' || e.type === 'TESSELLATED_SHELL') return e.args[2] instanceof StepRef;
  return isA(e, 'TRIANGULATED_FACE') || isA(e, 'COMPLEX_TRIANGULATED_FACE') ? e.args[4] instanceof StepRef : false;
}

function boxOfPositions(p: Float32Array): [V3, V3] | null {
  if (!p.length) return null;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]!;
      if (v < lo[k]!) lo[k] = v;
      if (v > hi[k]!) hi[k] = v;
    }
  return [lo, hi];
}

function scaleV(a: V3, k: number): V3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function crossV(a: V3, b: V3): V3 {
  return normalize([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
