/**
 * EXPLODE: 한 단계 분해.
 * - INSERT(MINSERT 격자 포함): 블록 내용을 참조 변환으로 옮긴다. 도면층 0·ByBlock 특성은 그대로 둔다(AutoCAD와 같다).
 *   속성은 현재 값을 담은 TEXT(여러 줄 속성은 MTEXT)가 된다. 상수가 아닌 ATTDEF는 버린다.
 * - LWPOLYLINE·2D POLYLINE → LINE·ARC(폭은 버리고 OCS는 그대로), 3D POLYLINE → LINE, 메시·폴리페이스·MESH → 3DFACE.
 * - DIMENSION·ACAD_TABLE → 블록 그림, LEADER·MULTILEADER → 선·화살촉·문자·블록, MTEXT → 줄마다 TEXT,
 *   무늬 HATCH → LINE, MLINE → LINE, TOLERANCE → 틀 선 + MTEXT.
 */
import type {
  AttribEntity,
  CadDocument,
  Entity,
  FaceEntity,
  HatchEntity,
  InsertEntity,
  LeaderEntity,
  MLeaderEntity,
  MLineEntity,
  MLineStyleObject,
  MTextEntity,
  PolylineEntity,
  TextEntity,
  ToleranceEntity,
  Vec2,
  Vec3,
} from '../../core/model';
import { tableKey } from '../../core/model';
import { bulgeArc, interpolateFitPoints } from '../../geom/curves';
import { dimVars, plainText } from '../../app/inquiry';
import { builtinArrow } from '../../render/arrows';
import { hatchLoops, patternSegments, userPattern } from '../../render/hatch';
import { strokeFace } from '../../text/fonts';
import { type Affine, affMul, affRotate, affScale, affTranslate, normAngle, norm3, cross3 } from './math';
import { cloneEntity, freshEntity, inherit, lwVerts, makeSpline, polyVerts } from './path';
import { isNaturalExt, isPlanarExt, ocsToWcs, planProj, planZ, wcsToOcs } from './ocs';
import { type EditResult, MSG, type TransformOptions } from './types';
import { mapBlockContents } from './xannot';
import { metrics, mtextDir } from './xtext';
import { normalizeNurbs } from './nurbs';

export function explodeEntity(e: Entity, doc: CadDocument): EditResult {
  const done = (add: Entity[], extra: Partial<EditResult> = {}): EditResult => (add.length ? { remove: e.handle ? [e.handle] : [], add, ...extra } : { message: MSG.cannotExplode });
  switch (e.type) {
    case 'INSERT':
      return explodeInsert(e, doc);
    case 'LWPOLYLINE':
      return done(explodeBulges(e, lwVerts(e), e.closed, e.elevation));
    case 'POLYLINE':
      return done(explodePolyline(e));
    case 'MESH': {
      const out: Entity[] = [];
      for (const f of e.faces) out.push(...faceEntities(e, f.map((i) => e.vertices[i]!).filter(Boolean), f.map(() => true)));
      return done(out);
    }
    case 'DIMENSION': {
      const b = e.block ? doc.blocks.get(tableKey(e.block)) : undefined;
      if (!b || !b.entities.length) return { message: MSG.cannotExplode };
      let A: Affine = planProj(e.extrusion, e.textMid.z);
      const ip = e.insertPoint;
      if (ip && (ip.x || ip.y)) A = affMul(affTranslate(ip.x, ip.y), A);
      const strip = !isNaturalExt(e.extrusion);
      const r = mapBlockContents(b.entities, A, doc, { mirrorText: true, exact: true, mirrorHatch: true, dz: planZ(e.extrusion, e.textMid.z) }, strip);
      return done(r.ents, r.blocks.length ? { blocks: r.blocks } : {});
    }
    case 'ACAD_TABLE': {
      const b = doc.blocks.get(tableKey(e.block));
      if (!b) return { message: MSG.cannotExplode };
      const ang = Math.atan2(e.direction.y, e.direction.x);
      const local = affMul(affTranslate(e.insert.x, e.insert.y), affMul(affRotate(ang), affMul(affScale(e.scale.x || 1, e.scale.y || 1), affTranslate(-b.basePoint.x, -b.basePoint.y))));
      const A = affMul(planProj(e.extrusion, 0), local);
      const r = mapBlockContents(b.entities, A, doc, { mirrorText: true, exact: true, mirrorHatch: true, dz: planZ(e.extrusion, e.insert.z) }, false);
      return done(r.ents, r.blocks.length ? { blocks: r.blocks } : {});
    }
    case 'LEADER':
      return done(explodeLeader(e, doc));
    case 'MULTILEADER':
      return done(explodeMLeader(e, doc));
    case 'MTEXT':
      return done(mtextToTexts(e, doc));
    case 'HATCH':
    case 'MPOLYGON':
      return explodeHatch(e);
    case 'MLINE':
      return done(explodeMLine(e, doc));
    case 'TOLERANCE':
      return done(explodeTolerance(e, doc));
    case 'REGION':
    case '3DSOLID':
    case 'BODY': {
      const out: Entity[] = [];
      for (const w of e.wires ?? []) for (let i = 1; i < w.length; i++) out.push(line3(e, w[i - 1]!, w[i]!));
      return done(out);
    }
    default:
      return { message: MSG.cannotExplode };
  }
}

function line3(src: Entity, a: Vec3, b: Vec3): Entity {
  return { type: 'LINE', ...inherit(src), start: { ...a }, end: { ...b } };
}

// ---------------------------------------------------------------------------
// 블록 참조
// ---------------------------------------------------------------------------

function explodeInsert(e: InsertEntity, doc: CadDocument): EditResult {
  const b = doc.blocks.get(tableKey(e.block));
  if (!b) return { message: '블록 정의를 찾을 수 없습니다.' };
  if (b.flags & 4) return { message: '외부 참조는 분해할 수 없습니다.' };
  const rec = doc.blockRecords.get(tableKey(e.block));
  if (rec && rec.explodable === false) return { message: '이 블록은 분해할 수 없도록 정의되어 있습니다.' };
  const P = planProj(e.extrusion, e.insert.z);
  const sx = e.scale.x || 1;
  const sy = e.scale.y || 1;
  const sz = e.scale.z || 1;
  const rows = Math.max(1, e.rowCount);
  const cols = Math.max(1, e.columnCount);
  const content = b.entities.filter((c) => !(c.type === 'ATTDEF' && !((c as AttribEntity).attFlags & 2)));
  const out: Entity[] = [];
  const blocks = [];
  let message: string | undefined;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const local = affMul(
        affTranslate(e.insert.x, e.insert.y),
        affMul(affRotate(e.rotation), affMul(affTranslate(c * e.columnSpacing, r * e.rowSpacing), affMul(affScale(sx, sy), affTranslate(-b.basePoint.x, -b.basePoint.y)))),
      );
      const A = affMul(P, local);
      const opt: TransformOptions = { mirrorText: true, exact: true, mirrorHatch: true, dz: planZ(e.extrusion, e.insert.z) - b.basePoint.z * sz };
      const res = mapBlockContents(
        content.map((x) => (x.type === 'ATTDEF' ? attdefAsText(x as AttribEntity) : x)),
        A,
        doc,
        opt,
        false,
      );
      out.push(...res.ents);
      blocks.push(...res.blocks);
      if (res.message && !message) message = res.message;
    }
  // 속성 → 현재 값의 문자
  for (const a of e.attribs) {
    if (a.attFlags & 1) continue;
    if (a.mtext) {
      out.push(freshEntity({ ...cloneEntity(a.mtext), ...inherit(a), type: 'MTEXT' } as MTextEntity));
      continue;
    }
    out.push(attribAsText(a));
  }
  const res: EditResult = { remove: e.handle ? [e.handle] : [], add: out };
  if (blocks.length) res.blocks = blocks;
  if (message) res.message = message;
  return res;
}

function attribAsText(a: AttribEntity): TextEntity {
  return {
    type: 'TEXT',
    ...inherit(a as unknown as Entity),
    insert: { ...a.insert },
    alignPoint: a.alignPoint ? { ...a.alignPoint } : undefined,
    height: a.height,
    text: a.text,
    rotation: a.rotation,
    widthFactor: a.widthFactor,
    oblique: a.oblique,
    style: a.style,
    generation: a.generation,
    halign: a.halign,
    valign: a.valign,
    extrusion: a.extrusion ? { ...a.extrusion } : undefined,
    thickness: a.thickness,
  };
}

function attdefAsText(a: AttribEntity): TextEntity {
  return attribAsText(a);
}

// ---------------------------------------------------------------------------
// 폴리선
// ---------------------------------------------------------------------------

/** 볼록도 정점 → LINE·ARC(원본 OCS 유지) */
function explodeBulges(src: Entity, vs: { x: number; y: number; bulge: number }[], closed: boolean, elev: number): Entity[] {
  const out: Entity[] = [];
  const ext = src.extrusion;
  const natural = !ext || isPlanarExt(ext) && ext.z > 0;
  const n = vs.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % n]!;
    const arc = Math.abs(a.bulge) > 1e-12 ? bulgeArc(a.x, a.y, b.x, b.y, a.bulge) : null;
    if (arc) {
      const lo = arc.sweep > 0 ? arc.a0 : arc.a0 + arc.sweep;
      out.push({
        type: 'ARC',
        ...inherit(src),
        center: { x: arc.cx, y: arc.cy, z: elev },
        radius: arc.r,
        startAngle: normAngle(lo),
        endAngle: normAngle(lo + Math.abs(arc.sweep)),
        extrusion: natural ? undefined : { ...ext! },
      });
    } else {
      if (Math.hypot(b.x - a.x, b.y - a.y) <= 0) continue;
      const pa = natural ? { x: a.x, y: a.y, z: elev } : ocsToWcs({ x: a.x, y: a.y, z: elev }, ext);
      const pb = natural ? { x: b.x, y: b.y, z: elev } : ocsToWcs({ x: b.x, y: b.y, z: elev }, ext);
      out.push({ type: 'LINE', ...inherit(src), start: pa, end: pb });
    }
  }
  return out;
}

function explodePolyline(e: PolylineEntity): Entity[] {
  const closed = (e.flags & 1) !== 0;
  if (e.kind === '2d') {
    const vs = polyVerts(e).map((v) => ({ x: v.location.x, y: v.location.y, bulge: v.bulge }));
    return explodeBulges(e, vs, closed, e.elevation);
  }
  if (e.kind === '3d') {
    const vs = polyVerts(e);
    const out: Entity[] = [];
    for (let i = 0; i < (closed ? vs.length : vs.length - 1); i++) out.push(line3(e, vs[i]!.location, vs[(i + 1) % vs.length]!.location));
    return out;
  }
  if (e.kind === 'mesh') {
    const M = e.mCount;
    const N = e.nCount;
    const v = e.vertices.map((q) => q.location);
    const out: Entity[] = [];
    if (M * N > v.length) return out;
    const cm = (e.flags & 1) !== 0;
    const cn = (e.flags & 32) !== 0;
    for (let i = 0; i < (cm ? M : M - 1); i++)
      for (let j = 0; j < (cn ? N : N - 1); j++) {
        const i1 = (i + 1) % M;
        const j1 = (j + 1) % N;
        out.push(...faceEntities(e, [v[i * N + j]!, v[i * N + j1]!, v[i1 * N + j1]!, v[i1 * N + j]!], [true, true, true, true]));
      }
    return out;
  }
  // 폴리페이스
  const coords = e.vertices.filter((v) => v.flags & 64 || !v.faceIndices).map((v) => v.location);
  const out: Entity[] = [];
  for (const f of e.vertices) {
    if (!f.faceIndices || f.flags & 64) continue;
    const idx = f.faceIndices.filter((k) => k !== 0);
    const pts = idx.map((k) => coords[Math.abs(k) - 1]).filter((p): p is Vec3 => !!p);
    out.push(...faceEntities(e, pts, idx.map((k) => k > 0)));
  }
  return out;
}

/** 점 3·4개 면 → 3DFACE(더 많으면 부채꼴로 나눈다). vis[i]: 변 i(i → i+1)가 보이는지 */
function faceEntities(src: Entity, pts: Vec3[], vis: boolean[]): FaceEntity[] {
  const mk = (p: Vec3[], v: boolean[]): FaceEntity => {
    const q = [...p];
    while (q.length < 4) q.push({ ...q[q.length - 1]! });
    let bits = 0;
    for (let i = 0; i < 4; i++) if (v[i] === false) bits |= 1 << i;
    return { type: '3DFACE', ...inherit(src), points: [q[0]!, q[1]!, q[2]!, q[3]!], invisibleEdges: bits };
  };
  if (pts.length < 3) return [];
  if (pts.length <= 4) return [mk(pts, vis)];
  const out: FaceEntity[] = [];
  for (let i = 1; i + 1 < pts.length; i++) out.push(mk([pts[0]!, pts[i]!, pts[i + 1]!], [i === 1 ? vis[0]! : false, vis[i]!, i + 1 === pts.length - 1 ? vis[pts.length - 1]! : false]));
  return out;
}

// ---------------------------------------------------------------------------
// 지시선
// ---------------------------------------------------------------------------

function arrowEntities(src: Entity, doc: CadDocument, name: string, tip: Vec2, dir: number, size: number, z: number): Entity[] {
  if (!(size > 0)) return [];
  const blk = name ? doc.blocks.get(tableKey(name)) : undefined;
  if (blk && blk.entities.length) {
    const ins: InsertEntity = {
      type: 'INSERT',
      ...inherit(src),
      block: blk.name,
      insert: { x: tip.x, y: tip.y, z },
      scale: { x: size, y: size, z: size },
      rotation: normAngle(dir),
      columnCount: 1,
      rowCount: 1,
      columnSpacing: 0,
      rowSpacing: 0,
      attribs: [],
    };
    return [ins];
  }
  const shape = builtinArrow(name) ?? builtinArrow('')!;
  const c = Math.cos(dir) * size;
  const s = Math.sin(dir) * size;
  const X = (x: number, y: number): Vec3 => ({ x: tip.x + c * x - s * y, y: tip.y + s * x + c * y, z });
  const out: Entity[] = [];
  for (const l of shape.lines) for (let i = 2; i + 1 < l.length; i += 2) out.push(line3(src, X(l[i - 2]!, l[i - 1]!), X(l[i]!, l[i + 1]!)));
  for (const f of shape.fills)
    for (let i = 0; i + 5 < f.length; i += 6) {
      const a = X(f[i]!, f[i + 1]!);
      const b = X(f[i + 2]!, f[i + 3]!);
      const d = X(f[i + 4]!, f[i + 5]!);
      out.push({ type: 'SOLID', ...inherit(src), points: [a, b, d, { ...d }], invisibleEdges: 0 });
    }
  return out;
}

function polyEntities(src: Entity, v: Vec3[], spline: boolean): Entity[] {
  if (v.length < 2) return [];
  if (spline && v.length > 2) {
    const s = interpolateFitPoints(v);
    return [makeSpline(src, normalizeNurbs({ degree: s.degree, knots: s.knots, ctrl: s.ctrl }))];
  }
  const out: Entity[] = [];
  for (let i = 1; i < v.length; i++) out.push(line3(src, v[i - 1]!, v[i]!));
  return out;
}

function explodeLeader(e: LeaderEntity, doc: CadDocument): Entity[] {
  const out = polyEntities(e, e.vertices, e.pathType === 1);
  if (e.arrowHead && e.vertices.length >= 2) {
    const v = dimVars(doc, e);
    const asz = (Number(v.DIMASZ) || 2.5) * (Number(v.DIMSCALE) || 1);
    const a = e.vertices[0]!;
    const b = e.vertices[1]!;
    out.push(...arrowEntities(e, doc, String(v.DIMLDRBLK || v.DIMBLK || ''), a, Math.atan2(a.y - b.y, a.x - b.x), asz, a.z));
  }
  return out;
}

function explodeMLeader(e: MLeaderEntity, doc: CadDocument): Entity[] {
  const out: Entity[] = [];
  const c = e.context;
  const byRecord = new Map<string, string>();
  for (const b of doc.blocks.values()) if (b.recordHandle) byRecord.set(b.recordHandle, b.name);
  for (const r of doc.blockRecords.values()) if (r.handle) byRecord.set(r.handle, r.name);
  const arrowName = e.arrowHeadHandle ? (byRecord.get(e.arrowHeadHandle) ?? '') : '';
  const size = c.arrowSize || e.arrowSize;
  if (e.leaderLineType !== 0)
    for (const ld of c.leaders) {
      for (const ln of ld.lines) {
        const v = [...ln.vertices];
        if (ld.lastLeaderPoint) v.push(ld.lastLeaderPoint);
        out.push(...polyEntities(e, v, e.leaderLineType === 2));
        if (v.length >= 2) out.push(...arrowEntities(e, doc, arrowName, v[0]!, Math.atan2(v[0]!.y - v[1]!.y, v[0]!.x - v[1]!.x), size, v[0]!.z));
      }
      if (e.dogleg && ld.lastLeaderPoint && ld.doglegVector && ld.doglegLength > 0) {
        const p = ld.lastLeaderPoint;
        const d = ld.doglegVector;
        out.push(line3(e, p, { x: p.x + d.x * ld.doglegLength, y: p.y + d.y * ld.doglegLength, z: p.z + d.z * ld.doglegLength }));
      }
    }
  if (c.text && (e.contentType === 2 || c.text.text)) {
    const t = c.text;
    const att = t.attachment >= 1 && t.attachment <= 3 ? t.attachment : 1;
    const mt: MTextEntity = {
      type: 'MTEXT',
      ...inherit(e),
      insert: { ...t.location },
      height: c.textHeight,
      width: t.width,
      attachment: att,
      drawingDirection: 1,
      text: t.text,
      style: 'Standard',
      direction: { ...t.direction },
      rotation: 0,
      lineSpacingStyle: t.lineSpacingStyle,
      lineSpacingFactor: t.lineSpacingFactor,
      backgroundFlags: 0,
      backgroundScale: 1.5,
    };
    const st = t.styleHandle || e.textStyleHandle;
    if (st) for (const s of doc.textStyles.values()) if (s.handle === st) mt.style = s.name;
    out.push(mt);
  }
  if (c.block && (e.contentType === 1 || c.block.blockHandle)) {
    const bd = c.block;
    const name = (bd.blockHandle && byRecord.get(bd.blockHandle)) || (e.blockHandle && byRecord.get(e.blockHandle)) || '';
    if (name)
      out.push({
        type: 'INSERT',
        ...inherit(e),
        block: name,
        insert: { ...bd.location },
        scale: { ...bd.scale },
        rotation: bd.rotation,
        columnCount: 1,
        rowCount: 1,
        columnSpacing: 0,
        rowSpacing: 0,
        attribs: [],
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 문자
// ---------------------------------------------------------------------------

function advance(s: string, h: number, wf: number): number {
  let w = 0;
  for (const ch of s) {
    const g = strokeFace.glyph(ch.codePointAt(0)!) ?? strokeFace.glyph(63);
    w += (g?.advance ?? 0.8) * h * wf;
  }
  return w;
}

/** MTEXT → 줄마다 TEXT(단순 단선 글꼴 폭으로 줄을 나눈다) */
export function mtextToTexts(e: MTextEntity, doc: CadDocument): TextEntity[] {
  const style = doc.textStyles.get(tableKey(e.style));
  const h = e.height > 0 ? e.height : style?.height || 2.5;
  const wf = style?.widthFactor && style.widthFactor > 0 ? style.widthFactor : 1;
  const paras = plainText(e.text).split('\n');
  const lines: string[] = [];
  for (const p of paras) {
    if (!(e.width > 0)) {
      lines.push(p);
      continue;
    }
    const words = p.split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      if (cur && advance((cur + w).trimEnd(), h, wf) > e.width) {
        lines.push(cur.trimEnd());
        cur = w.trimStart();
      } else cur += w;
    }
    lines.push(cur.trimEnd());
  }
  const att = e.attachment >= 1 && e.attachment <= 9 ? e.attachment : 1;
  const col = (att - 1) % 3;
  const row = Math.floor((att - 1) / 3);
  const factor = e.lineSpacingFactor > 0 ? e.lineSpacingFactor : 1;
  const widths = lines.map((l) => advance(l, h, wf));
  const boxW = e.width > 0 ? e.width : Math.max(0, ...widths);
  const base: number[] = [];
  for (let i = 0; i < lines.length; i++) base.push(i === 0 ? -h : base[i - 1]! - 1.667 * factor * h);
  const totalH = lines.length ? -base[base.length - 1]! : h;
  const offX = col === 0 ? 0 : col === 1 ? -boxW / 2 : -boxW;
  const offY = row === 0 ? 0 : row === 1 ? totalH / 2 : totalH;
  const n = norm3(e.extrusion ?? { x: 0, y: 0, z: 1 });
  const u = mtextDir(e);
  const v = cross3(n, u);
  const out: TextEntity[] = [];
  const natural = !e.extrusion || isPlanarExt(e.extrusion) && e.extrusion.z > 0;
  lines.forEach((s, i) => {
    if (!s.trim()) return;
    const x = col === 0 ? offX : col === 1 ? offX + boxW / 2 : offX + boxW;
    const y = base[i]! + offY;
    const w: Vec3 = { x: e.insert.x + u.x * x + v.x * y, y: e.insert.y + u.y * x + v.y * y, z: e.insert.z + u.z * x + v.z * y };
    const p = natural ? w : wcsToOcs(w, e.extrusion);
    const ud = natural ? u : wcsToOcs(u, e.extrusion);
    const rot = normAngle(Math.atan2(ud.y, ud.x));
    const t: TextEntity = {
      type: 'TEXT',
      ...inherit(e),
      insert: { ...p },
      height: h,
      text: s,
      rotation: rot,
      widthFactor: wf,
      oblique: style?.oblique ?? 0,
      style: e.style,
      generation: 0,
      halign: col === 0 ? 0 : col === 1 ? 1 : 2,
      valign: 0,
      extrusion: natural ? undefined : { ...n },
    };
    if (col !== 0) {
      t.alignPoint = { ...p };
      const wd = widths[i]!;
      const k = col === 1 ? wd / 2 : wd;
      t.insert = { x: p.x - Math.cos(rot) * k, y: p.y - Math.sin(rot) * k, z: p.z };
    }
    out.push(t);
  });
  return out;
}

function explodeTolerance(e: ToleranceEntity, doc: CadDocument): Entity[] {
  const dv = dimVars(doc, e);
  const h = (Number(dv.DIMTXT) || 2.5) * (Number(dv.DIMSCALE) || 1);
  const plain = e.text.replace(/\{\\F[^;]*;([^}]*)\}/g, '$1').replace(/%%v/gi, ' | ').replace(/\^J/g, '\\P');
  const lay = metrics().layoutMText({ text: plain, height: h, width: 0, attachment: 4, lineSpacingStyle: 1, lineSpacingFactor: 1 });
  const g = h * 0.5;
  const ang = Math.atan2(e.direction.y, e.direction.x);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const W = (x: number, y: number): Vec3 => ({ x: e.insert.x + c * x - s * y, y: e.insert.y + s * x + c * y, z: e.insert.z });
  const box = [W(lay.minX - g, lay.minY - g), W(lay.maxX + g, lay.minY - g), W(lay.maxX + g, lay.maxY + g), W(lay.minX - g, lay.maxY + g)];
  const out: Entity[] = [];
  for (let i = 0; i < 4; i++) out.push(line3(e, box[i]!, box[(i + 1) % 4]!));
  out.push({
    type: 'MTEXT',
    ...inherit(e),
    insert: { ...e.insert },
    height: h,
    width: 0,
    attachment: 4,
    drawingDirection: 1,
    text: plain,
    style: String(dv.DIMTXSTY || 'Standard'),
    direction: { x: c, y: s, z: 0 },
    rotation: ang,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    backgroundScale: 1.5,
  });
  return out;
}

// ---------------------------------------------------------------------------
// 해치·여러 줄
// ---------------------------------------------------------------------------

function explodeHatch(e: HatchEntity): EditResult {
  if (e.solid || e.gradient) return { message: '솔리드·그라데이션 해치는 분해할 수 없습니다.' };
  const tol = 1e-3;
  const loops = hatchLoops(e, tol);
  let lines = e.patternLines;
  if (!lines.length) lines = userPattern(e);
  const segs = patternSegments(lines, loops, 40000);
  if (!segs || !segs.length) return { message: MSG.cannotExplode };
  const out: Entity[] = [];
  for (let i = 0; i + 3 < segs.length; i += 4) {
    const a = ocsToWcs({ x: segs[i]!, y: segs[i + 1]!, z: e.elevation }, e.extrusion);
    const b = ocsToWcs({ x: segs[i + 2]!, y: segs[i + 3]!, z: e.elevation }, e.extrusion);
    out.push(line3(e, a, b));
  }
  return { remove: e.handle ? [e.handle] : [], add: out };
}

function explodeMLine(e: MLineEntity, doc: CadDocument): Entity[] {
  let st: MLineStyleObject | undefined;
  for (const o of doc.objects.values())
    if (o.type === 'MLINESTYLE') {
      const ms = o as MLineStyleObject;
      if ((e.styleHandle && ms.handle === e.styleHandle) || tableKey(ms.name) === tableKey(e.styleName)) st = ms;
    }
  const nEl = e.elementCount || e.vertices[0]?.elements.length || 0;
  const closed = (e.flags & 2) !== 0;
  const out: Entity[] = [];
  const elem: Vec3[][] = [];
  for (let k = 0; k < nEl; k++) {
    const pts = e.vertices.map((v) => {
      const d = v.elements[k]?.params[0] ?? 0;
      return { x: v.position.x + v.miter.x * d, y: v.position.y + v.miter.y * d, z: v.position.z + v.miter.z * d };
    });
    elem.push(pts);
    const se = st?.elements[k];
    const src: Entity = se
      ? ({ ...e, color: se.color.aci === 256 || se.color.aci === 0 ? e.color : se.color, linetype: se.linetype.toUpperCase() === 'BYLAYER' ? e.linetype : se.linetype } as Entity)
      : e;
    for (let i = 1; i < pts.length; i++) out.push(line3(src, pts[i - 1]!, pts[i]!));
    if (closed && pts.length > 2) out.push(line3(src, pts[pts.length - 1]!, pts[0]!));
  }
  if (st && !closed && elem.length >= 2) {
    const first = elem[0]!;
    const last = elem[elem.length - 1]!;
    if (st.flags & 16) out.push(line3(e, first[0]!, last[0]!));
    if (st.flags & 256) out.push(line3(e, first[first.length - 1]!, last[last.length - 1]!));
  }
  return out;
}

