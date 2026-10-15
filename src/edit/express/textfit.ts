/**
 * TEXTFIT(Express Tools 문자 맞추기) 계산(UI 없음).
 * 한 줄 문자의 폭 비율을 바꿔 시작점(기본은 지금 왼쪽 기준선 시작)에서 고른 끝점까지 늘이거나 줄인다.
 * 높이·회전·자리맞추기는 그대로 두고 자리맞추기 점만 새 폭에 맞춰 옮긴다. 정렬(A) 문자는 높이를 지키도록 맞춤(F)으로 바꾼다.
 * 글자 폭(문자 높이 단위)은 화면 글꼴로 잰 값을 받을 수 있다(없으면 단선 글꼴로 잰다).
 */
import type { CadDocument, Vec2 } from '../../core/model';
import { tableKey } from '../../core/model';
import { type TextLike, textFrame } from '../geom/textjust';
import { affApply, affInv, affLin, dot, len } from '../geom/math';
import { planProj } from '../geom/ocs';
import { cloneEntity } from '../geom/path';
import { metrics } from '../geom/xtext';

interface Frame {
  /** 왼쪽 기준선 시작(OCS) */
  o: Vec2;
  rot: number;
  h: number;
  wf: number;
  sh: number;
  mx: number;
  my: number;
  /** 글자 폭(문자 높이 단위) */
  W: number;
  desc: number;
}

function apply(f: Frame, u: number, v: number): Vec2 {
  const lx = f.mx * (f.h * f.wf * u + f.sh * f.h * v);
  const ly = f.my * (f.h * v);
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  return { x: c * lx - s * ly, y: s * lx + c * ly };
}

function offset(f: Frame, ha: number, va: number): { u: number; v: number } {
  const u = ha === 1 || ha === 4 ? f.W / 2 : ha === 2 ? f.W : 0;
  let v = 0;
  if (ha === 4) v = 0.5;
  else if (va === 1) v = -f.desc;
  else if (va === 2) v = 0.5;
  else if (va === 3) v = 1;
  return { u, v };
}

/** 글자 틀(textjust.textFrame과 같은 규칙, 글자 폭·하강은 받은 값) */
function frameOf(e: TextLike, doc: CadDocument, W?: number, desc?: number): Frame {
  const base = textFrame(e, doc);
  const ww = W ?? base.W;
  const dd = desc ?? base.desc;
  const style = doc.textStyles.get(tableKey(e.style));
  let h = e.height > 0 ? e.height : style?.height || style?.lastHeight || 2.5;
  let wf = e.widthFactor > 0 ? e.widthFactor : 1;
  let rot = e.rotation;
  const f: Frame = { o: { x: e.insert.x, y: e.insert.y }, rot, h, wf, sh: Math.tan(e.oblique || 0), mx: e.generation & 2 ? -1 : 1, my: e.generation & 4 ? -1 : 1, W: ww, desc: dd };
  const ap = e.alignPoint;
  if ((e.halign === 3 || e.halign === 5) && ap) {
    const L = Math.hypot(ap.x - e.insert.x, ap.y - e.insert.y);
    if (L > 1e-12) {
      rot = Math.atan2(ap.y - e.insert.y, ap.x - e.insert.x);
      if (ww > 1e-12) {
        if (e.halign === 3) h = L / (ww * wf);
        else wf = L / (ww * h);
      }
    }
    return { ...f, rot, h, wf };
  }
  if ((e.halign !== 0 || e.valign !== 0) && ap) {
    const j = offset(f, e.halign, e.valign);
    const d = apply(f, j.u, j.v);
    f.o = { x: ap.x - d.x, y: ap.y - d.y };
  }
  return f;
}

export interface FitMeasure {
  /** 글자 폭(문자 높이 단위) — 화면 글꼴로 잰 값 */
  unitWidth?: number;
  /** 기준선 아래 깊이(문자 높이 단위) */
  descent?: number;
}

/** 단선 글꼴로 잰 글자 폭(문자 높이 단위) */
export function strokeUnitWidth(e: TextLike, doc: CadDocument): number {
  const lay = metrics().layoutText({
    text: e.text,
    insert: { x: 0, y: 0 },
    height: 1,
    rotation: 0,
    widthFactor: 1,
    oblique: 0,
    generation: 0,
    halign: 0,
    valign: 0,
    style: doc.textStyles.get(tableKey(e.style)),
  });
  return Number.isFinite(lay.maxX) ? Math.max(0, lay.maxX) : 0;
}

/** 지금 문자의 기준선(WCS 평면도): 시작점, 단위 방향, 길이 */
export function fitBaseline(e: TextLike, doc: CadDocument, m: FitMeasure = {}): { start: Vec2; dir: Vec2; length: number } {
  const f = frameOf(e, doc, m.unitWidth, m.descent);
  const P = planProj(e.extrusion, e.insert.z);
  const d = affLin(P, { x: Math.cos(f.rot), y: Math.sin(f.rot) });
  const l = len(d) || 1;
  return { start: affApply(P, f.o), dir: { x: d.x / l, y: d.y / l }, length: f.W * f.h * f.wf };
}

/**
 * 끝점(WCS)까지 맞춘 문자. start(WCS)를 주면 기준선 위로 내린 그 점이 새 시작점이다.
 * 맞출 수 없으면 안내 문구.
 */
export function fitText<T extends TextLike>(e: T, end: Vec2, doc: CadDocument, opt: FitMeasure & { start?: Vec2 } = {}): T | string {
  const f = frameOf(e, doc, opt.unitWidth, opt.descent);
  if (!(f.W > 1e-12)) return '빈 문자는 맞출 수 없습니다.';
  const P = planProj(e.extrusion, e.insert.z);
  const Pi = affInv(P);
  if (!Pi) return '이 문자의 좌표계를 쓸 수 없습니다.';
  const u = { x: Math.cos(f.rot), y: Math.sin(f.rot) };
  const along = (q: Vec2) => dot({ x: q.x - f.o.x, y: q.y - f.o.y }, u);
  const s0 = opt.start ? along(affApply(Pi, opt.start)) : 0;
  const s = { x: f.o.x + u.x * s0, y: f.o.y + u.y * s0 };
  const L = dot({ x: affApply(Pi, end).x - s.x, y: affApply(Pi, end).y - s.y }, u) * f.mx;
  if (!(L > 1e-9 * Math.max(1, f.h))) return '끝점은 문자 시작점보다 문자 방향으로 앞에 있어야 합니다.';
  const out = cloneEntity(e);
  const z = e.insert.z;
  if (e.halign === 3 || e.halign === 5) {
    out.halign = 5;
    out.valign = 0;
    out.height = f.h;
    out.insert = { x: s.x, y: s.y, z };
    out.alignPoint = { x: s.x + u.x * L * f.mx, y: s.y + u.y * L * f.mx, z };
    return out;
  }
  const wf = L / (f.W * f.h);
  out.widthFactor = wf;
  out.rotation = f.rot;
  out.height = f.h;
  out.insert = { x: s.x, y: s.y, z };
  if (e.halign === 0 && e.valign === 0) {
    delete out.alignPoint;
    return out;
  }
  const nf: Frame = { ...f, wf, o: s };
  const j = offset(nf, e.halign, e.valign);
  const d = apply(nf, j.u, j.v);
  out.alignPoint = { x: s.x + d.x, y: s.y + d.y, z };
  return out;
}
