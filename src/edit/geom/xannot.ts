/**
 * 주석 객체 변환: 치수(정의점 + 익명 블록 내용), 지시선, 다중 지시선, 표.
 * 치수·표의 블록 내용은 새 익명 블록(*D…, *T…)으로 돌려준다(원래 블록은 복사한 쪽이 계속 쓸 수 있다).
 */
import type { BlockDef, CadDocument, DimensionEntity, Entity, LeaderEntity, MLeaderEntity, TableEntity, Vec2, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { dimDisplayText, dimVars as dimVarsOf } from '../../app/inquiry';
import { cloneEntity, freshEntity } from './path';
import {
  type Affine,
  add,
  affAngle,
  affApply,
  affApply3,
  affDet,
  affInv,
  affLin,
  affLin3,
  affMul,
  affScaleOf,
  affSimilarity,
  affTranslate,
  cross,
  dot,
  len,
  len3,
  mul,
  norm,
  normAngle,
  rot90,
  sub,
} from './math';
import { isNaturalExt, isPlanarExt, ocsToWcs, planProj, planZ, planeMap } from './ocs';
import { type EditResult, type TransformOptions, allocBlockName } from './types';
import { metrics } from './xtext';
import { transformEntity, decomposeBlock, xformNormal } from './transform';

function dir3(m: Affine, v: Vec3): Vec3 {
  const d = affLin3(m, v);
  const l = len3(d);
  return l > 0 ? { x: d.x / l, y: d.y / l, z: d.z / l } : { ...v };
}

/** 블록 내용을 아핀 A로 옮긴 새 객체 목록(핸들 비움) */
export function mapBlockContents(list: readonly Entity[], A: Affine, doc: CadDocument, opt: TransformOptions, stripOcs: boolean): { ents: Entity[]; blocks: BlockDef[]; message?: string } {
  const ents: Entity[] = [];
  const blocks: BlockDef[] = [];
  let message: string | undefined;
  for (const c of list) {
    const src = stripOcs && c.extrusion ? ({ ...c, extrusion: undefined } as Entity) : c;
    const r = transformEntity(src, A, doc, opt);
    for (const x of [...(r.replace ?? []), ...(r.add ?? [])]) {
      // 새 객체: 핸들·사전·반응자·DWG 원본 본문은 잇지 않는다
      ents.push(freshEntity(x));
    }
    if (r.blocks) blocks.push(...r.blocks);
    if (r.message && !message) message = r.message;
  }
  return { ents, blocks, message };
}

function newBlock(doc: CadDocument, prefix: string, base: BlockDef | undefined, ents: Entity[]): BlockDef {
  return {
    name: allocBlockName(doc, prefix),
    handle: '',
    recordHandle: '',
    basePoint: { x: 0, y: 0, z: 0 },
    flags: (base?.flags ?? 1) | 1,
    layer: base?.layer,
    description: base?.description,
    entities: ents,
  };
}

// ---------------------------------------------------------------------------
// 치수
// ---------------------------------------------------------------------------

export function dimMeasure(d: DimensionEntity): number {
  const k = d.dimType & 7;
  const p2 = d.defPoint2;
  const p3 = d.defPoint3;
  if (d.subtype === 'ARC_DIMENSION' && d.arc) {
    const r = Math.hypot(d.arc.start.x - d.arc.center.x, d.arc.start.y - d.arc.center.y);
    let sw = d.arc.endAngle - d.arc.startAngle;
    while (sw < 0) sw += Math.PI * 2;
    return r * sw;
  }
  if (k === 0) return Math.abs((p3.x - p2.x) * Math.cos(d.rotation) + (p3.y - p2.y) * Math.sin(d.rotation));
  if (k === 1) return Math.hypot(p3.x - p2.x, p3.y - p2.y);
  if (k === 3 || k === 4) return Math.hypot(d.defPoint4.x - d.defPoint.x, d.defPoint4.y - d.defPoint.y);
  return d.measurement;
}

/**
 * 치수 블록의 숫자 문자를 새 측정값으로 바꾼다(재지정 문자 없이 측정값을 보일 때만).
 * 먼저 치수 스타일로 서식한 값을 찾고, 없으면 블록 문자 안에서 옛 값과 같은 숫자(그 자릿수로 반올림)를 찾아 같은 자릿수로 바꾼다.
 */
export function updateDimNumber(doc: CadDocument, before: DimensionEntity, after: DimensionEntity, ents: Entity[]): void {
  if (!(before.text === '' || before.text.includes('<>'))) return;
  if (!Number.isFinite(before.measurement) || !Number.isFinite(after.measurement)) return;
  const da = dimDisplayText(doc, before);
  const db = dimDisplayText(doc, after);
  const a = da.formatted;
  const b = db.formatted;
  if (a === b) return;
  const num = /[-+]?\d[\d.,']*/;
  const na = num.exec(a)?.[0];
  const nb = num.exec(b)?.[0];
  const texts = ents.filter((e): e is Extract<Entity, { type: 'TEXT' | 'MTEXT' }> => e.type === 'MTEXT' || e.type === 'TEXT');
  if (na && nb && na !== nb && texts.some((e) => e.text.includes(na))) {
    for (const e of texts) if (e.text.includes(na)) e.text = e.text.replace(na, nb);
    return;
  }
  // 표시 단위의 값(각도는 도)
  const toDisplay = (d: DimensionEntity, info: { isAngle: boolean; value: number }) => (info.isAngle ? (info.value * 180) / Math.PI : info.value * (Number(dimVarsOf(doc, d).DIMLFAC ?? 1) || 1));
  const va = toDisplay(before, da);
  const vb = toDisplay(after, db);
  const tok = /(\\[A-Za-z][^;\\]*;)|([-+]?\d+(?:[.,]\d+)?)/g;
  for (const e of texts) {
    let done = false;
    e.text = e.text.replace(tok, (m: string, code: string | undefined, n: string | undefined) => {
      if (code || !n || done) return m;
      const sep = n.includes(',') ? ',' : '.';
      const dec = n.includes(sep) ? n.length - n.indexOf(sep) - 1 : 0;
      const val = Number(n.replace(',', '.'));
      if (Math.abs(val - va) > 0.5 * 10 ** -dec + 1e-9 * Math.max(1, Math.abs(va))) return m;
      done = true;
      return vb.toFixed(dec).replace('.', sep);
    });
  }
}

export function xformDimension(e: DimensionEntity, m: Affine, opt: TransformOptions, doc: CadDocument): EditResult {
  const r = cloneEntity(e);
  const dz = opt.dz ?? 0;
  const planar = isPlanarExt(e.extrusion);
  const W = (p: Vec3) => affApply3(m, p, dz);
  let contentMap: Affine;
  if (planar) {
    const P = planProj(e.extrusion, 0);
    let C = P;
    const ip = e.insertPoint;
    if (ip && (ip.x || ip.y)) C = affMul(affTranslate(ip.x, ip.y), C);
    contentMap = affMul(m, C);
    const ocsPt = (p: Vec3) => W(ocsToWcs(p, e.extrusion));
    r.textMid = ocsPt(e.textMid);
    r.textMid.z = planZ(e.extrusion, e.textMid.z) + dz;
    r.defPoint5 = ocsPt(e.defPoint5);
    r.insertPoint = undefined;
    const ang = (a: number) => normAngle(affAngle(m, affAngle(P, a)));
    r.rotation = ang(e.rotation);
    if (e.horizontalDirection) r.horizontalDirection = ang(e.horizontalDirection);
    if (e.obliqueAngle) r.obliqueAngle = ang(e.obliqueAngle);
    r.extrusion = undefined;
  } else {
    const pm = planeMap(e.extrusion, e.textMid.z, m, dz);
    contentMap = pm.A;
    const q = affApply(pm.A, e.textMid);
    r.textMid = { x: q.x, y: q.y, z: pm.z };
    const q5 = affApply(pm.A, e.defPoint5);
    r.defPoint5 = { x: q5.x, y: q5.y, z: e.defPoint5.z };
    r.rotation = normAngle(affAngle(pm.A, e.rotation));
    if (e.horizontalDirection) r.horizontalDirection = normAngle(affAngle(pm.A, e.horizontalDirection));
    if (e.obliqueAngle) r.obliqueAngle = normAngle(affAngle(pm.A, e.obliqueAngle));
    r.extrusion = pm.ext;
  }
  r.defPoint = W(e.defPoint);
  r.defPoint2 = W(e.defPoint2);
  r.defPoint3 = W(e.defPoint3);
  r.defPoint4 = W(e.defPoint4);
  if (e.arc) {
    const c = W(e.arc.center);
    const s = W(e.arc.start);
    const en = W(e.arc.end);
    const mir = affDet(m) < 0;
    const a0 = Math.atan2(s.y - c.y, s.x - c.x);
    const a1 = Math.atan2(en.y - c.y, en.x - c.x);
    r.arc = {
      ...e.arc,
      center: c,
      start: mir ? en : s,
      end: mir ? s : en,
      startAngle: normAngle(mir ? a1 : a0),
      endAngle: normAngle(mir ? a0 : a1),
      leader1: e.arc.leader1 ? W(e.arc.leader1) : undefined,
      leader2: e.arc.leader2 ? W(e.arc.leader2) : undefined,
    };
  }
  // 측정값
  const k = e.dimType & 7;
  if (Number.isFinite(e.measurement)) {
    if (e.subtype === 'ARC_DIMENSION' || k === 0 || k === 1 || k === 3 || k === 4) r.measurement = dimMeasure(r);
    else if (k === 6) r.measurement = e.measurement * affScaleOf(m);
  }
  const b = e.block ? doc.blocks.get(tableKey(e.block)) : undefined;
  if (!b || !b.entities.length) return { replace: [r] };
  const stripOcs = !isNaturalExt(e.extrusion);
  const mapped = mapBlockContents(b.entities, contentMap, doc, { mirrorText: false }, stripOcs);
  updateDimNumber(doc, e, r, mapped.ents);
  const nb = newBlock(doc, '*D', b, mapped.ents);
  r.block = nb.name;
  const res: EditResult = { replace: [r], blocks: [nb, ...mapped.blocks] };
  if (mapped.message) res.message = mapped.message;
  return res;
}

// ---------------------------------------------------------------------------
// 지시선
// ---------------------------------------------------------------------------

export function xformLeader(e: LeaderEntity, m: Affine, opt: TransformOptions): LeaderEntity {
  const r = cloneEntity(e);
  const dz = opt.dz ?? 0;
  const s = affScaleOf(m);
  r.vertices = e.vertices.map((p) => affApply3(m, p, dz));
  if (e.normal) r.normal = xformNormal(m, e.normal);
  if (e.extrusion) r.extrusion = xformNormal(m, e.extrusion);
  if (e.horizontalDirection) r.horizontalDirection = dir3(m, e.horizontalDirection);
  if (e.blockOffset) r.blockOffset = affLin3(m, e.blockOffset);
  if (e.annotationOffset) r.annotationOffset = affLin3(m, e.annotationOffset);
  r.textHeight = e.textHeight * s;
  r.textWidth = e.textWidth * s;
  return r;
}

export function xformMLeader(e: MLeaderEntity, m: Affine, opt: TransformOptions, doc: CadDocument): MLeaderEntity {
  const r = cloneEntity(e);
  const dz = opt.dz ?? 0;
  const W = (p: Vec3) => affApply3(m, p, dz);
  const sim = affSimilarity(m);
  const s = sim ? sim.s : affScaleOf(m);
  const c = r.context;
  const c0 = e.context;
  c.contentBase = W(c0.contentBase);
  c.basePoint = W(c0.basePoint);
  c.baseDirection = dir3(m, c0.baseDirection);
  c.baseVertical = dir3(m, c0.baseVertical);
  c.normal = xformNormal(m, c0.normal) ?? { x: 0, y: 0, z: 1 };
  c.textHeight = c0.textHeight * s;
  c.arrowSize = c0.arrowSize * s;
  c.landingGap = c0.landingGap * s;
  c.leaders = c0.leaders.map((ld) => ({
    ...ld,
    lastLeaderPoint: ld.lastLeaderPoint ? W(ld.lastLeaderPoint) : undefined,
    doglegVector: ld.doglegVector ? dir3(m, ld.doglegVector) : undefined,
    doglegLength: ld.doglegLength * s,
    lines: ld.lines.map((ln) => ({
      ...ln,
      vertices: ln.vertices.map(W),
      breaks: ln.breaks?.map((b) => ({ start: W(b.start), end: W(b.end) })),
    })),
  }));
  r.doglegLength = e.doglegLength * s;
  r.arrowSize = e.arrowSize * s;
  if (c0.text) {
    const t0 = c0.text;
    const t = c.text!;
    const d = norm({ x: t0.direction.x, y: t0.direction.y });
    const u = len(d) > 0 ? d : { x: 1, y: 0 };
    const v = rot90(u);
    let gx = affLin(m, u);
    let gy = affLin(m, v);
    let loc = affApply(m, t0.location);
    if (cross(gx, gy) < 0) {
      // 읽을 수 있게: 상자 중심을 거울상 자리에
      const c1 = { gx: mul(gx, -1), gy };
      const c2 = { gx, gy: mul(gy, -1) };
      const pick = dot(norm(c1.gx), u) >= dot(norm(c2.gx), u) ? c1 : c2;
      gx = pick.gx;
      gy = pick.gy;
      const att = t0.attachment >= 1 && t0.attachment <= 3 ? t0.attachment : 1;
      const lay = metrics().layoutMText({ text: t0.text, height: c0.textHeight, width: t0.width, attachment: att, lineSpacingStyle: t0.lineSpacingStyle, lineSpacingFactor: t0.lineSpacingFactor });
      const cq = Number.isFinite(lay.minX) ? { x: (lay.minX + lay.maxX) / 2, y: (lay.minY + lay.maxY) / 2 } : { x: 0, y: 0 };
      const cw = affApply(m, add(t0.location, add(mul(u, cq.x), mul(v, cq.y))));
      const du = norm(gx);
      loc = sub(cw, add(mul(du, cq.x * s), mul(rot90(du), cq.y * s)));
    }
    const du = norm(gx);
    t.location = { x: loc.x, y: loc.y, z: t0.location.z + dz };
    t.direction = { x: du.x, y: du.y, z: 0 };
    t.normal = xformNormal(m, t0.normal) ?? { x: 0, y: 0, z: 1 };
    t.width = t0.width * s;
    t.height = t0.height * s;
    t.rotation = normAngle(Math.atan2(du.y, du.x));
  }
  if (c0.block) {
    const b0 = c0.block;
    const b = c.block!;
    b.location = W(b0.location);
    b.normal = xformNormal(m, b0.normal) ?? { x: 0, y: 0, z: 1 };
    const dd = decomposeBlock(m, b0.rotation, b0.scale.x || 1, b0.scale.y || 1);
    b.rotation = dd.rot;
    b.scale = { x: dd.sx, y: dd.sy, z: b0.scale.z };
    if (b0.matrix && b0.matrix.length === 16) {
      const M4 = [m[0], m[2], 0, m[4], m[1], m[3], 0, m[5], 0, 0, 1, dz, 0, 0, 0, 1];
      const o = b0.matrix;
      const res: number[] = new Array(16).fill(0);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) res[i * 4 + j]! += M4[i * 4 + k]! * o[k * 4 + j]!;
      b.matrix = res;
    }
  }
  if (e.blockScale) r.blockScale = { x: e.blockScale.x * s, y: e.blockScale.y * s, z: e.blockScale.z };
  void doc;
  return r;
}

// ---------------------------------------------------------------------------
// 표
// ---------------------------------------------------------------------------

export function xformTable(e: TableEntity, m: Affine, opt: TransformOptions, doc: CadDocument): EditResult {
  const r = cloneEntity(e);
  const P = planProj(e.extrusion, e.insert.z);
  const MP = affMul(m, P);
  const rot = Math.atan2(e.direction.y, e.direction.x);
  const sx = e.scale.x || 1;
  const sy = e.scale.y || 1;
  const d = decomposeBlock(MP, rot, sx, sy);
  const ins = affApply(MP, e.insert);
  const z = planZ(e.extrusion, e.insert.z) + (opt.dz ?? 0);
  r.insert = { x: ins.x, y: ins.y, z };
  r.extrusion = undefined;
  const b = doc.blocks.get(tableKey(e.block));
  if ((d.sx > 0 && d.sy > 0 && !d.shear) || !b) {
    r.direction = { x: Math.cos(d.rot), y: Math.sin(d.rot), z: 0 };
    r.rotation = d.rot;
    r.scale = { x: d.sx, y: d.sy, z: e.scale.z };
    syncTableRaw(r);
    return { replace: [r] };
  }
  // 대칭·기울임: 읽을 수 있는 틀을 두고 내용을 다시 옮긴다
  const u = { x: Math.cos(rot), y: Math.sin(rot) };
  const ref = norm(affLin(P, u));
  const g = affLin(MP, u);
  const cand = [norm(g), norm(mul(g, -1))];
  const dir = dot(cand[0]!, ref) >= dot(cand[1]!, ref) ? cand[0]! : cand[1]!;
  const rr = Math.atan2(dir.y, dir.x);
  const ks = Math.sqrt(Math.abs(d.sx * d.sy));
  const base = b.basePoint;
  const frame = (o: Vec2, a: number, kx: number, ky: number): Affine => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return affMul([c * kx, s * kx, -s * ky, c * ky, o.x, o.y], affTranslate(-base.x, -base.y));
  };
  const Fold = affMul(P, frame(e.insert, rot, sx, sy));
  const Fnew = frame(ins, rr, ks, ks);
  const inv = affInv(Fnew);
  if (!inv) return { replace: [r] };
  const A = affMul(inv, affMul(m, Fold));
  const mapped = mapBlockContents(b.entities, A, doc, { mirrorText: false }, false);
  const nb = newBlock(doc, '*T', b, mapped.ents);
  nb.basePoint = { ...base };
  r.block = nb.name;
  r.direction = { x: dir.x, y: dir.y, z: 0 };
  r.rotation = normAngle(rr);
  r.scale = { x: ks, y: ks, z: e.scale.z };
  syncTableRaw(r);
  return { replace: [r], blocks: [nb, ...mapped.blocks] };
}

/** DXF 원본 태그(AcDbTable)의 방향 벡터(11·21·31)를 모델 값과 맞춘다 */
function syncTableRaw(r: TableEntity): void {
  if (!r.raw) return;
  const raw = r.raw.map((t) => ({ ...t }));
  const i = raw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbTable');
  if (i < 0) return;
  for (let k = i + 1; k < raw.length; k++) {
    const t = raw[k]!;
    if (t.code === 100) break;
    if (t.code === 11) t.value = r.direction.x;
    else if (t.code === 21) t.value = r.direction.y;
    else if (t.code === 31) {
      t.value = r.direction.z;
      break;
    }
  }
  r.raw = raw;
}
