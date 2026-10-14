/**
 * SCALETEXT·JUSTIFYTEXT 계산: 문자(TEXT·ATTRIB·ATTDEF)와 여러 줄 문자(MTEXT)의 자리맞추기 점.
 * 자리맞추기 점은 그리기(src/text/layout.ts layoutText)와 같은 규칙으로 구한다:
 * 왼쪽 기준선 원점 O에서 글자 틀 F(u, v)(높이 단위)만큼 — 가운데 u = 폭/2, 오른쪽 u = 폭,
 * 맨 아래 v = −하강, 중간 v = 0.5, 맨 위 v = 1, 중간(M) = (폭/2, 0.5).
 * TEXT의 점은 OCS, MTEXT의 점은 WCS다.
 */
import type { AttribEntity, CadDocument, Entity, MTextEntity, TextEntity, Vec2, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { add3, cross3, mul3, norm3 } from './math';
import { cloneEntity } from './path';
import { planProj } from './ocs';
import { affApply } from './math';
import { metrics, mtextDir, mtextLocalBox } from './xtext';

export type TextLike = TextEntity | AttribEntity;

/** 자리맞추기 옵션 → TEXT 72(수평)·73(수직) */
export const TEXT_JUST: Record<string, { ha: number; va: number }> = {
  L: { ha: 0, va: 0 },
  C: { ha: 1, va: 0 },
  R: { ha: 2, va: 0 },
  A: { ha: 3, va: 0 },
  M: { ha: 4, va: 0 },
  F: { ha: 5, va: 0 },
  TL: { ha: 0, va: 3 },
  TC: { ha: 1, va: 3 },
  TR: { ha: 2, va: 3 },
  ML: { ha: 0, va: 2 },
  MC: { ha: 1, va: 2 },
  MR: { ha: 2, va: 2 },
  BL: { ha: 0, va: 1 },
  BC: { ha: 1, va: 1 },
  BR: { ha: 2, va: 1 },
};

/** 자리맞추기 옵션 → MTEXT 부착점(71). 왼쪽·중심·오른쪽·중간은 맨 위 줄·가운데로 본다 */
export const MTEXT_ATTACH: Record<string, number> = { TL: 1, TC: 2, TR: 3, ML: 4, MC: 5, MR: 6, BL: 7, BC: 8, BR: 9, L: 1, C: 2, R: 3, M: 5 };

export function isTextLike(e: Entity): e is TextLike {
  return e.type === 'TEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF';
}

interface TextFrame {
  /** 왼쪽 기준선 원점(OCS) */
  o: Vec2;
  rot: number;
  h: number;
  wf: number;
  sh: number;
  mx: number;
  my: number;
  /** 문자 폭(높이 단위) */
  W: number;
  /** 기준선 아래 깊이(높이 단위) */
  desc: number;
}

function frameApply(f: TextFrame, u: number, v: number): Vec2 {
  const sx = f.h * f.wf;
  const sy = f.h;
  const lx = f.mx * (sx * u + f.sh * sy * v);
  const ly = f.my * (sy * v);
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  return { x: c * lx - s * ly, y: s * lx + c * ly };
}

function justOffset(f: TextFrame, ha: number, va: number): { u: number; v: number } {
  const u = ha === 1 || ha === 4 ? f.W / 2 : ha === 2 ? f.W : 0;
  let v = 0;
  if (ha === 4) v = 0.5;
  else if (va === 1) v = -f.desc;
  else if (va === 2) v = 0.5;
  else if (va === 3) v = 1;
  return { u, v };
}

/** 문자의 글자 틀(자리맞추기와 상관없는 왼쪽 기준선 원점과 크기) */
export function textFrame(e: TextLike, doc: CadDocument): TextFrame {
  const style = doc.textStyles.get(tableKey(e.style));
  const unit = metrics().layoutText({
    text: e.text || ('tag' in e ? e.tag : ''),
    insert: { x: 0, y: 0 },
    height: 1,
    rotation: 0,
    widthFactor: 1,
    oblique: 0,
    generation: 0,
    halign: 0,
    valign: 0,
    style,
  });
  const W = Number.isFinite(unit.maxX) ? Math.max(0, unit.maxX) : 0;
  const desc = Number.isFinite(unit.minY) ? Math.max(0, -unit.minY) : 0;
  let h = e.height > 0 ? e.height : style?.height || style?.lastHeight || 2.5;
  let wf = e.widthFactor > 0 ? e.widthFactor : 1;
  let rot = e.rotation;
  const f: TextFrame = { o: { x: e.insert.x, y: e.insert.y }, rot, h, wf, sh: Math.tan(e.oblique || 0), mx: e.generation & 2 ? -1 : 1, my: e.generation & 4 ? -1 : 1, W, desc };
  const ap = e.alignPoint;
  if ((e.halign === 3 || e.halign === 5) && ap) {
    const L = Math.hypot(ap.x - e.insert.x, ap.y - e.insert.y);
    if (L > 1e-12) {
      rot = Math.atan2(ap.y - e.insert.y, ap.x - e.insert.x);
      if (W > 1e-12) {
        if (e.halign === 3) h = L / (W * wf);
        else wf = L / (W * h);
      }
    }
    Object.assign(f, { rot, h, wf });
    return f;
  }
  if ((e.halign !== 0 || e.valign !== 0) && ap) {
    const j = justOffset(f, e.halign, e.valign);
    const d = frameApply(f, j.u, j.v);
    f.o = { x: ap.x - d.x, y: ap.y - d.y };
  }
  return f;
}

/** TEXT의 자리맞추기 점(OCS). key = TEXT_JUST의 옵션, 'E' = 지금 자리맞추기 점 */
export function textPointOcs(e: TextLike, key: string, doc: CadDocument): Vec2 {
  if (key === 'E') {
    if ((e.halign === 3 || e.halign === 5) || (e.halign === 0 && e.valign === 0) || !e.alignPoint) return { x: e.insert.x, y: e.insert.y };
    return { x: e.alignPoint.x, y: e.alignPoint.y };
  }
  const j = TEXT_JUST[key] ?? TEXT_JUST.L!;
  const f = textFrame(e, doc);
  const o = justOffset(f, j.ha === 3 || j.ha === 5 ? 0 : j.ha, j.va);
  const d = frameApply(f, o.u, o.v);
  return { x: f.o.x + d.x, y: f.o.y + d.y };
}

/** MTEXT 지역 축(WCS) */
function mtextAxes(e: MTextEntity): { X: Vec3; Y: Vec3 } {
  const n = norm3(e.extrusion ?? { x: 0, y: 0, z: 1 });
  const X = mtextDir(e);
  return { X, Y: norm3(cross3(n, X)) };
}

/** MTEXT 부착점 k(1~9) 자리(WCS): 같은 글자 상자를 부착점 k로 놓을 때의 삽입점 */
export function mtextPoint(e: MTextEntity, k: number, doc: CadDocument): Vec3 {
  if (k === e.attachment) return { ...e.insert };
  const b1 = mtextLocalBox(e, doc);
  const b2 = mtextLocalBox({ ...e, attachment: k }, doc);
  const { X, Y } = mtextAxes(e);
  return add3(add3(e.insert, mul3(X, b1.minX - b2.minX)), mul3(Y, b1.minY - b2.minY));
}

/** SCALETEXT 기준점(WCS 평면도) */
export function scaleBasePoint(e: Entity, key: string, doc: CadDocument): Vec2 | null {
  if (isTextLike(e)) {
    const q = textPointOcs(e, key, doc);
    return affApply(planProj(e.extrusion, e.insert.z), q);
  }
  if (e.type === 'MTEXT') {
    if (key === 'E') return { x: e.insert.x, y: e.insert.y };
    const p = mtextPoint(e, MTEXT_ATTACH[key] ?? e.attachment, doc);
    return { x: p.x, y: p.y };
  }
  return null;
}

/** 문자 높이(그려지는 높이) */
export function textHeightOf(e: Entity, doc: CadDocument): number | null {
  if (isTextLike(e)) return textFrame(e, doc).h;
  if (e.type === 'MTEXT') return e.height > 0 ? e.height : 2.5;
  return null;
}

/**
 * 자리맞추기를 바꾼다(문자 자리는 그대로). 바뀌지 않으면 null.
 * TEXT: 정렬(A)·맞춤(F)으로 바꾸면 지금 폭의 두 점, 다른 것으로 바꾸면 지금 높이·폭 비율을 지닌다.
 */
export function justifyText(e: Entity, key: string, doc: CadDocument): Entity | null {
  if (isTextLike(e)) {
    const j = TEXT_JUST[key];
    if (!j) return null;
    if (e.halign === j.ha && e.valign === j.va) return null;
    const f = textFrame(e, doc);
    const out = cloneEntity(e);
    const z = e.insert.z;
    out.halign = j.ha as TextEntity['halign'];
    out.valign = j.va as TextEntity['valign'];
    out.rotation = f.rot;
    out.height = f.h;
    out.widthFactor = f.wf;
    out.insert = { x: f.o.x, y: f.o.y, z };
    if (j.ha === 3 || j.ha === 5) {
      const d = frameApply(f, Math.max(f.W, 1e-9), 0);
      out.alignPoint = { x: f.o.x + d.x, y: f.o.y + d.y, z };
    } else if (j.ha === 0 && j.va === 0) {
      delete out.alignPoint;
    } else {
      const o = justOffset(f, j.ha, j.va);
      const d = frameApply(f, o.u, o.v);
      out.alignPoint = { x: f.o.x + d.x, y: f.o.y + d.y, z };
    }
    return out;
  }
  if (e.type === 'MTEXT') {
    const k = MTEXT_ATTACH[key];
    if (!k || k === e.attachment) return null;
    const out = cloneEntity(e);
    out.insert = mtextPoint(e, k, doc);
    out.attachment = k;
    return out;
  }
  return null;
}
