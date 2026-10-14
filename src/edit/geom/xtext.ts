/**
 * 문자 변환(TEXT·ATTRIB·ATTDEF·MTEXT·SHAPE·TOLERANCE).
 * 대칭(행렬식 < 0)이고 MIRRTEXT가 꺼져 있으면 AutoCAD처럼 읽을 수 있게 둔다:
 * 문자 상자는 거울상 자리에 두고, 글자 방향은 원래 기준선과 가까운 쪽으로 뒤집지 않는다.
 */
import type { AttribEntity, CadDocument, MTextEntity, ShapeEntity, TextEntity, ToleranceEntity, Vec2, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { TextEngine } from '../../text/layout';
import { dimVars } from '../../app/inquiry';
import { cloneEntity } from './path';
import { type Affine, add, affApply, affApply3, affDet, affLin, affLin3, affMul, cross, cross3, dot, len, len3, mul, norm, norm3, normAngle, rot90, sub } from './math';
import { frameOf, isNaturalExt, isPlanarExt, planProj, planZ, planeMap } from './ocs';
import type { TransformOptions } from './types';

let engine: TextEngine | null = null;

/** 문자 크기 계산용 엔진(단선 글꼴) */
export function metrics(): TextEngine {
  engine ??= new TextEngine(null);
  return engine;
}

interface Frame2 {
  gx: Vec2;
  gy: Vec2;
}

function glyphFrame(rot: number, h: number, wf: number, ob: number, mx: number, my: number): Frame2 {
  const u = { x: Math.cos(rot), y: Math.sin(rot) };
  const v = rot90(u);
  const sh = Math.tan(ob || 0);
  return { gx: mul(u, mx * h * wf), gy: add(mul(u, mx * sh * h), mul(v, my * h)) };
}

function decompose(f: Frame2, mx: number, my: number): { rot: number; h: number; wf: number; ob: number } | null {
  const lx = len(f.gx);
  if (!(lx > 0)) return null;
  const u = mul(f.gx, mx / lx);
  const v = rot90(u);
  const h = my * dot(f.gy, v);
  if (!(h > 0)) return null;
  const sh = dot(f.gy, u) / (h * mx);
  return { rot: Math.atan2(u.y, u.x), h, wf: lx / h, ob: Math.atan(sh) };
}

/** 프레임 부호가 바뀌었을 때 한쪽 플래그를 뒤집는다(기준선이 ref와 가까운 쪽) */
function chooseFlags(f: Frame2, mx: number, my: number, ref: Vec2): [number, number] {
  const sgn = cross(f.gx, f.gy) >= 0 ? 1 : -1;
  if (sgn === mx * my) return [mx, my];
  const lx = len(f.gx) || 1;
  const a = dot(mul(f.gx, -mx / lx), ref); // 좌우 반전 뒤집기
  const b = dot(mul(f.gx, mx / lx), ref); // 상하 반전 뒤집기
  return a >= b - 1e-12 ? [-mx, my] : [mx, -my];
}

/** 읽을 수 있는 프레임: 거울상 프레임의 X나 Y를 되돌린다 */
function readableFrame(f: Frame2, mx: number, ref: Vec2): Frame2 {
  const c1 = { gx: mul(f.gx, -1), gy: f.gy };
  const c2 = { gx: f.gx, gy: mul(f.gy, -1) };
  const d1 = dot(norm(mul(c1.gx, mx)), ref);
  const d2 = dot(norm(mul(c2.gx, mx)), ref);
  return d1 >= d2 - 1e-12 ? c1 : c2;
}

const R = (a: number, p: Vec2): Vec2 => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });

export function xformText<T extends TextEntity | AttribEntity>(e: T, m: Affine, opt: TransformOptions, doc: CadDocument): T {
  const out = cloneEntity(e);
  const planar = isPlanarExt(e.extrusion);
  const z = e.insert.z;
  let W: Affine;
  let P: Affine = [1, 0, 0, 1, 0, 0];
  let newExt: Vec3 | undefined;
  let newZ: number;
  if (planar) {
    P = planProj(e.extrusion, z);
    W = affMul(m, P);
    newExt = undefined;
    newZ = planZ(e.extrusion, z) + (opt.dz ?? 0);
  } else {
    const pm = planeMap(e.extrusion, z, m, opt.dz ?? 0);
    W = pm.A;
    newExt = pm.ext;
    newZ = pm.z;
  }
  const aligned = (e.halign === 3 || e.halign === 5) && !!e.alignPoint;
  const ap = e.alignPoint;
  const rot0 = aligned ? Math.atan2(ap!.y - e.insert.y, ap!.x - e.insert.x) : e.rotation;
  const mx = e.generation & 2 ? -1 : 1;
  const my = e.generation & 4 ? -1 : 1;
  const style = doc.textStyles.get(tableKey(e.style));
  const h0 = e.height > 0 ? e.height : style?.height || style?.lastHeight || 2.5;
  const wf0 = e.widthFactor > 0 ? e.widthFactor : 1;
  const F = glyphFrame(rot0, h0, wf0, e.oblique, mx, my);
  let Fx: Frame2 = { gx: affLin(W, F.gx), gy: affLin(W, F.gy) };
  const ref = norm(affLin(P, { x: Math.cos(rot0), y: Math.sin(rot0) }));
  const readable = planar && affDet(m) < 0 && !opt.mirrorText;
  let flags: [number, number];
  if (readable) {
    Fx = readableFrame(Fx, mx, ref);
    flags = [mx, my];
  } else flags = chooseFlags(Fx, mx, my, ref);
  const d = decompose(Fx, flags[0], flags[1]) ?? { rot: rot0, h: h0, wf: wf0, ob: e.oblique };
  const anchorIsAlign = !aligned && (e.halign !== 0 || e.valign !== 0) && !!ap;
  const anchor0: Vec2 = anchorIsAlign ? ap! : e.insert;
  const other0: Vec2 | undefined = anchorIsAlign ? e.insert : aligned ? ap : undefined;
  let anchor: Vec2;
  let other: Vec2 | undefined;
  if (!readable) {
    anchor = affApply(W, anchor0);
    other = other0 ? affApply(W, other0) : undefined;
  } else {
    // 상자 중심을 거울상 자리에
    const L = aligned ? Math.hypot(ap!.x - e.insert.x, ap!.y - e.insert.y) : 0;
    const lay = metrics().layoutText({
      text: e.text || ('tag' in e ? e.tag : ''),
      insert: { x: 0, y: 0 },
      alignPoint: aligned ? { x: L, y: 0 } : ap ? { x: 0, y: 0 } : undefined,
      height: e.height,
      rotation: 0,
      widthFactor: e.widthFactor,
      oblique: 0,
      generation: 0,
      halign: e.halign,
      valign: e.valign,
      style,
    });
    const cq = Number.isFinite(lay.minX) ? { x: (lay.minX + lay.maxX) / 2, y: (lay.minY + lay.maxY) / 2 } : { x: 0, y: 0 };
    const flagged = (p: Vec2): Vec2 => ({ x: p.x * mx, y: p.y * my });
    const cw = affApply(W, add(anchor0, R(rot0, flagged(cq))));
    const kx = (d.h * d.wf) / (h0 * wf0);
    const ky = d.h / h0;
    const place = (q: Vec2): Vec2 => R(d.rot, flagged({ x: q.x * kx, y: q.y * ky }));
    anchor = sub(cw, place(cq));
    if (other0) {
      const loc = flagged(R(-rot0, sub(other0, anchor0)));
      other = add(anchor, place(loc));
    }
  }
  if (anchorIsAlign) {
    out.alignPoint = { x: anchor.x, y: anchor.y, z: newZ };
    out.insert = { x: other!.x, y: other!.y, z: newZ };
  } else {
    out.insert = { x: anchor.x, y: anchor.y, z: newZ };
    if (aligned) out.alignPoint = { x: other!.x, y: other!.y, z: newZ };
    else if (ap) {
      const q = affApply(W, ap);
      out.alignPoint = { x: q.x, y: q.y, z: newZ };
    }
  }
  out.rotation = normAngle(d.rot);
  if (e.height > 0) out.height = d.h;
  else if (Math.abs(d.h - h0) > 1e-9 * h0) out.height = d.h;
  out.widthFactor = Math.abs(d.wf - wf0) < 1e-12 ? e.widthFactor : d.wf;
  out.oblique = Math.abs(d.ob) < 1e-12 ? 0 : d.ob;
  out.generation = (e.generation & ~6) | (flags[0] < 0 ? 2 : 0) | (flags[1] < 0 ? 4 : 0);
  out.extrusion = newExt;
  const mt = (e as AttribEntity).mtext;
  if (mt) (out as AttribEntity).mtext = xformMText(mt, m, opt, doc);
  return out;
}

/** MTEXT의 X축 방향(WCS) */
export function mtextDir(e: MTextEntity): Vec3 {
  if (e.direction && len3(e.direction) > 0) return norm3(e.direction);
  const f = frameOf(e.extrusion);
  const c = Math.cos(e.rotation);
  const s = Math.sin(e.rotation);
  return norm3({ x: f.ax.x * c + f.ay.x * s, y: f.ax.y * c + f.ay.y * s, z: f.ax.z * c + f.ay.z * s });
}

export function mtextLocalBox(e: MTextEntity, doc: CadDocument): { minX: number; minY: number; maxX: number; maxY: number } {
  const lay = metrics().layoutMText({
    text: e.text,
    height: e.height,
    width: e.width,
    attachment: e.attachment,
    lineSpacingStyle: e.lineSpacingStyle,
    lineSpacingFactor: e.lineSpacingFactor,
    style: doc.textStyles.get(tableKey(e.style)),
    columns: e.columns && e.columns.count > 1 ? e.columns : undefined,
    rectHeight: e.rectHeight,
  });
  if (!Number.isFinite(lay.minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return lay;
}

export function xformMText(e: MTextEntity, m: Affine, opt: TransformOptions, doc: CadDocument): MTextEntity {
  const out = cloneEntity(e);
  const n = norm3(e.extrusion ?? { x: 0, y: 0, z: 1 });
  const u3 = mtextDir(e);
  const v3 = cross3(n, u3);
  const h0 = e.height > 0 ? e.height : 2.5;
  const dz = opt.dz ?? 0;
  const ins = affApply3(m, e.insert, dz);
  let kx: number;
  let ky: number;
  if (!isPlanarExt(e.extrusion)) {
    const U = affLin3(m, mul3v(u3, h0));
    const V = affLin3(m, mul3v(v3, h0));
    const nn = norm3(cross3(U, V));
    const dir = norm3(U);
    kx = len3(U) / h0;
    ky = len3(cross3(U, V)) / (len3(U) * h0);
    out.insert = ins;
    out.direction = dir;
    out.extrusion = isNaturalExt(nn) ? undefined : nn;
    out.rotation = 0;
  } else {
    const u = { x: u3.x, y: u3.y };
    const v = { x: v3.x, y: v3.y };
    let Fx: Frame2 = { gx: affLin(m, mul(u, h0)), gy: affLin(m, mul(v, h0)) };
    const mirroredOut = cross(Fx.gx, Fx.gy) < 0;
    const readable = mirroredOut && affDet(m) < 0 && !opt.exact;
    let pos = { x: ins.x, y: ins.y };
    if (readable) {
      Fx = readableFrame(Fx, 1, norm(u));
      const lx = len(Fx.gx);
      kx = lx / h0;
      ky = Math.abs(cross(Fx.gx, Fx.gy)) / (lx * h0);
      const b = mtextLocalBox(e, doc);
      const cq = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      const cw = affApply(m, add({ x: e.insert.x, y: e.insert.y }, add(mul(u, cq.x), mul(v, cq.y))));
      const du = norm(Fx.gx);
      const dv = rot90(du);
      pos = sub(cw, add(mul(du, cq.x * kx), mul(dv, cq.y * ky)));
      out.direction = { x: du.x, y: du.y, z: 0 };
      out.extrusion = undefined;
      out.rotation = normAngle(Math.atan2(du.y, du.x));
    } else {
      const lx = len(Fx.gx);
      kx = lx / h0;
      ky = Math.abs(cross(Fx.gx, Fx.gy)) / (lx * h0);
      const du = norm(Fx.gx);
      out.direction = { x: du.x, y: du.y, z: 0 };
      if (mirroredOut) {
        out.extrusion = { x: 0, y: 0, z: -1 };
        out.rotation = normAngle(Math.atan2(du.y, -du.x));
      } else {
        out.extrusion = undefined;
        out.rotation = normAngle(Math.atan2(du.y, du.x));
      }
    }
    out.insert = { x: pos.x, y: pos.y, z: ins.z };
  }
  if (e.height > 0) out.height = e.height * ky;
  out.width = e.width * kx;
  if (e.rectHeight !== undefined) out.rectHeight = e.rectHeight * ky;
  if (e.columns) out.columns = { ...e.columns, width: e.columns.width * kx, gutter: e.columns.gutter * kx, heights: e.columns.heights.map((x) => x * ky) };
  return out;
}

function mul3v(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/** SHAPE: 글자 프레임과 같은 방법(대칭은 OCS −Z로 정확히) */
export function xformShape(e: ShapeEntity, m: Affine, opt: TransformOptions): ShapeEntity {
  const out = cloneEntity(e);
  const P = planProj(e.extrusion, e.insert.z);
  const W = affMul(m, P);
  const h0 = e.size || 1;
  const F = glyphFrame(e.rotation, h0, e.widthFactor || 1, e.oblique, 1, 1);
  let gx = affLin(W, F.gx);
  let gy = affLin(W, F.gy);
  let ins = affApply(W, e.insert);
  const z = planZ(e.extrusion, e.insert.z) + (opt.dz ?? 0);
  if (cross(gx, gy) < 0) {
    // OCS −Z: x → −x
    gx = { x: -gx.x, y: gx.y };
    gy = { x: -gy.x, y: gy.y };
    ins = { x: -ins.x, y: ins.y };
    out.extrusion = { x: 0, y: 0, z: -1 };
    out.insert = { x: ins.x, y: ins.y, z: -z };
  } else {
    out.extrusion = undefined;
    out.insert = { x: ins.x, y: ins.y, z };
  }
  const d = decompose({ gx, gy }, 1, 1);
  if (d) {
    out.rotation = normAngle(d.rot);
    out.size = d.h;
    out.widthFactor = d.wf;
    out.oblique = d.ob;
  }
  return out;
}

/** TOLERANCE: 삽입점·방향. 대칭이면 읽을 수 있게(상자 거울상 자리) */
export function xformTolerance(e: ToleranceEntity, m: Affine, opt: TransformOptions, doc: CadDocument): ToleranceEntity {
  const out = cloneEntity(e);
  const dir = norm({ x: e.direction.x, y: e.direction.y });
  const u = Math.hypot(dir.x, dir.y) > 0 ? dir : { x: 1, y: 0 };
  const v = rot90(u);
  let Fx: Frame2 = { gx: affLin(m, u), gy: affLin(m, v) };
  const ins = affApply3(m, e.insert, opt.dz ?? 0);
  if (cross(Fx.gx, Fx.gy) < 0) {
    Fx = readableFrame(Fx, 1, u);
    const dv = dimVars(doc, { dimStyle: e.dimStyle });
    const h = (Number(dv.DIMTXT) || 2.5) * (Number(dv.DIMSCALE) || 1);
    const plain = e.text.replace(/\{\\F[^;]*;([^}]*)\}/g, '$1').replace(/%%v/gi, ' | ').replace(/\^J/g, '\\P');
    const lay = metrics().layoutMText({ text: plain, height: h, width: 0, attachment: 4, lineSpacingStyle: 1, lineSpacingFactor: 1, style: doc.textStyles.get(tableKey(String(dv.DIMTXSTY || 'Standard'))) });
    const cq = Number.isFinite(lay.minX) ? { x: (lay.minX + lay.maxX) / 2, y: (lay.minY + lay.maxY) / 2 } : { x: 0, y: 0 };
    const cw = affApply(m, add({ x: e.insert.x, y: e.insert.y }, add(mul(u, cq.x), mul(v, cq.y))));
    const s = len(Fx.gx);
    const du = norm(Fx.gx);
    const pos = sub(cw, add(mul(du, cq.x * s), mul(rot90(du), cq.y * s)));
    out.insert = { x: pos.x, y: pos.y, z: ins.z };
    out.direction = { x: du.x, y: du.y, z: 0 };
  } else {
    const du = norm(Fx.gx);
    out.insert = ins;
    out.direction = { x: du.x, y: du.y, z: 0 };
  }
  out.extrusion = undefined;
  return out;
}

