/**
 * 원호 정렬 문자(ARCALIGNEDTEXT) 글자 배치. 화면·PDF·SVG 그리기, 분해, 저장(익명 블록의 한 줄 문자)이 모두 이 배치를 쓴다.
 *
 * - 기준선 반지름: 볼록·바깥쪽 R + 간격, 볼록·안쪽 R + 간격 + 높이, 오목·바깥쪽 R − 간격 − 높이, 오목·안쪽 R − 간격(0 이하이면 거절).
 * - 읽는 방향: 바깥쪽(글자 머리가 바깥)은 끝 각도에서 시계 방향, 안쪽(머리가 중심 쪽)은 시작 각도에서 반시계 방향.
 *   거리는 기준선 원 위에서 잰다. 왼쪽 = 왼쪽 간격띄우기에서 시작, 오른쪽 = 오른쪽 간격띄우기에서 끝,
 *   중심 = 두 간격띄우기 사이 가운데, 맞춤 = 그 구간에 글자를 고르게 펼친다(문자 간격 대신 자기 간격, 글자 하나면 중심).
 * - 글자 폭(높이 × 폭 비율 단위): 단선 글꼴의 전진 폭, 한글·한자 등은 1.0, 단선 글꼴에 없는 글자는 0.85.
 *   설치 글꼴과 무관해서 화면과 저장이 같은 자리를 낸다. 글자마다 자기 자리의 가운데에 놓으므로(가운데 맞춤 TEXT)
 *   실제 글꼴 폭과 조금 달라도 간격만 달라진다.
 * - 밑줄: 기준선에서 높이 × 0.2 아래(바깥쪽이면 안쪽 반지름, 안쪽이면 바깥 반지름), 첫 글자 자리 왼쪽 끝부터 마지막 글자 자리 오른쪽 끝까지.
 */
import type { ArcEntity, ArcTextEntity, Entity, EntityBase, TextEntity, Vec3 } from '../core/model';
import { BYBLOCK, LW_BYBLOCK, TRANSPARENCY_BYBLOCK } from '../core/model';
import { strokeFace } from './fonts';

const TAU = Math.PI * 2;

/** 맞춤·왼쪽·오른쪽·중심 */
export const ARC_ALIGN = { fit: 1, left: 2, right: 3, center: 4 } as const;
/** 볼록(호 바깥)·오목(안) */
export const ARC_POSITION = { convex: 1, concave: 2 } as const;
/** 바깥쪽(글자 머리가 바깥)·안쪽(중심 쪽) */
export const ARC_DIRECTION = { outward: 1, inward: 2 } as const;

/** 기울임꼴을 한 줄 문자로 그릴 때의 기울기 각도 */
export const ITALIC_OBLIQUE = (15 * Math.PI) / 180;

export type ArcTextDef = Pick<
  ArcTextEntity,
  'text' | 'center' | 'radius' | 'startAngle' | 'endAngle' | 'height' | 'widthFactor' | 'charSpacing' | 'offset' | 'leftOffset' | 'rightOffset' | 'alignment' | 'position' | 'direction' | 'reversed' | 'underline'
>;

export interface ArcGlyph {
  /** 글자 하나(코드 포인트) */
  ch: string;
  /** 기준선 가운데 점(OCS) */
  x: number;
  y: number;
  /** 글자 X축 각도(라디안) */
  rotation: number;
  /** 자리 폭(도면 단위) */
  width: number;
  /** 자리 가운데의 원호 각도 */
  angle: number;
}

export interface ArcTextLayout {
  glyphs: ArcGlyph[];
  /** 기준선 반지름 */
  baseRadius: number;
  /** 글자 자리가 차지하는 각도(반시계 from에서 sweep만큼) */
  span: { from: number; sweep: number };
  /** 밑줄 호(OCS, 반시계) */
  underline?: { radius: number; startAngle: number; endAngle: number };
}

const advCache = new Map<number, number>();

/** 글자 폭(문자 높이 단위, 폭 비율 1) */
export function charAdvance(code: number): number {
  let a = advCache.get(code);
  if (a !== undefined) return a;
  if (code === 0x3000) a = 1;
  else if (code >= 0x1100 && !(code >= 0x2000 && code <= 0x206f)) a = 1;
  else {
    const g = strokeFace.glyph(code === 0xa0 || code === 9 ? 32 : code);
    a = g ? g.advance : 0.85;
  }
  advCache.set(code, a);
  return a;
}

/** 글자 목록(반전 반영) */
export function arcTextChars(def: Pick<ArcTextDef, 'text' | 'reversed'>): string[] {
  const chars = Array.from(def.text.replace(/[\r\n\t]/g, ' '));
  return def.reversed ? chars.reverse() : chars;
}

/** 기준선 반지름 */
export function baseRadius(def: Pick<ArcTextDef, 'radius' | 'offset' | 'height' | 'position' | 'direction'>): number {
  const R = def.radius;
  const off = def.offset || 0;
  const h = def.height;
  const convex = def.position !== ARC_POSITION.concave;
  const outward = def.direction !== ARC_DIRECTION.inward;
  if (convex) return outward ? R + off : R + off + h;
  return outward ? R - off - h : R - off;
}

/** 반시계 시작 → 끝 각도(0이면 한 바퀴) */
export function arcSweep(a0: number, a1: number): number {
  let s = (((a1 - a0) % TAU) + TAU) % TAU;
  if (s <= 1e-12) s = TAU;
  return s;
}

/** 정의를 쓸 수 없으면 그 까닭(한국어), 쓸 수 있으면 null */
export function arcTextError(def: ArcTextDef): string | null {
  if (!def.text || !def.text.trim()) return '문자를 입력하십시오.';
  if (Array.from(def.text).length > 256) return '문자는 256자까지 쓸 수 있습니다.';
  if (/[\u0000-\u001f]/.test(def.text)) return '문자에 제어 문자를 쓸 수 없습니다.';
  if (!(def.radius > 0) || !Number.isFinite(def.radius)) return '호의 반지름이 올바르지 않습니다.';
  if (!(def.height > 0) || !Number.isFinite(def.height)) return '문자 높이는 0보다 커야 합니다.';
  if (!(def.widthFactor > 0) || def.widthFactor > 100) return '폭 비율은 0보다 크고 100 이하여야 합니다.';
  if (!Number.isFinite(def.charSpacing)) return '문자 간격이 올바르지 않습니다.';
  if (!Number.isFinite(def.offset)) return '호에서의 간격띄우기가 올바르지 않습니다.';
  if (!(def.leftOffset >= 0) || !(def.rightOffset >= 0)) return '왼쪽·오른쪽 간격띄우기는 0 이상이어야 합니다.';
  const rb = baseRadius(def);
  if (!(rb > 1e-9)) return '문자가 호 안쪽에 들어가지 않습니다(호에서의 간격띄우기나 문자 높이를 줄이십시오).';
  const L = rb * arcSweep(def.startAngle, def.endAngle);
  if (L - def.leftOffset - def.rightOffset <= 1e-9) return '왼쪽·오른쪽 간격띄우기가 호를 다 차지합니다.';
  const lay = layoutArcText(def);
  if (!lay) return '문자를 호에 놓을 수 없습니다.';
  if (lay.span.sweep > TAU + 1e-9) return '문자가 원 한 바퀴보다 깁니다.';
  return null;
}

/** 글자 배치. 정의를 쓸 수 없으면 null */
export function layoutArcText(def: ArcTextDef): ArcTextLayout | null {
  const chars = arcTextChars(def);
  const n = chars.length;
  const h = def.height;
  const wf = def.widthFactor > 0 ? def.widthFactor : 1;
  const rb = baseRadius(def);
  if (!n || !(h > 0) || !(rb > 1e-9) || !(def.radius > 0)) return null;
  const sweep = arcSweep(def.startAngle, def.endAngle);
  const L = rb * sweep;
  const from = def.leftOffset || 0;
  const to = L - (def.rightOffset || 0);
  const avail = to - from;
  if (!(avail > 1e-9)) return null;
  const adv = chars.map((c) => charAdvance(c.codePointAt(0)!) * h * wf);
  const sumAdv = adv.reduce((a, b) => a + b, 0);
  const cs = def.charSpacing || 0;
  let gap = cs;
  let s0: number;
  switch (def.alignment) {
    case ARC_ALIGN.fit:
      if (n === 1) s0 = (from + to) / 2 - sumAdv / 2;
      else {
        gap = (avail - sumAdv) / (n - 1);
        s0 = from;
      }
      break;
    case ARC_ALIGN.right:
      s0 = to - (sumAdv + cs * (n - 1));
      break;
    case ARC_ALIGN.center:
      s0 = (from + to) / 2 - (sumAdv + cs * (n - 1)) / 2;
      break;
    default:
      s0 = from;
  }
  const outward = def.direction !== ARC_DIRECTION.inward;
  const angleAt = (s: number) => (outward ? def.endAngle - s / rb : def.startAngle + s / rb);
  const cx = def.center.x;
  const cy = def.center.y;
  const glyphs: ArcGlyph[] = [];
  let s = s0;
  for (let i = 0; i < n; i++) {
    const c = s + adv[i]! / 2;
    const th = angleAt(c);
    glyphs.push({ ch: chars[i]!, x: cx + rb * Math.cos(th), y: cy + rb * Math.sin(th), rotation: outward ? th - Math.PI / 2 : th + Math.PI / 2, width: adv[i]!, angle: th });
    s += adv[i]! + (i < n - 1 ? gap : 0);
  }
  const sStart = s0;
  const sEnd = s;
  const spanSweep = Math.max(0, (sEnd - sStart) / rb);
  const spanFrom = outward ? angleAt(sEnd) : angleAt(sStart);
  const out: ArcTextLayout = { glyphs, baseRadius: rb, span: { from: spanFrom, sweep: spanSweep } };
  if (def.underline && spanSweep > 0) {
    const ur = outward ? rb - 0.2 * h : rb + 0.2 * h;
    if (ur > 0) out.underline = { radius: ur, startAngle: spanFrom, endAngle: spanFrom + Math.min(spanSweep, TAU) };
  }
  return out;
}

/** 문자 하나로 그리면 안 되는 글자(빈칸) */
function blank(ch: string): boolean {
  return /^\s$/u.test(ch) || ch === '　';
}

export interface PartsOptions {
  /** 블록 좌표(중심 0,0, 도면층 0, ByBlock 특성) — 저장용 익명 블록 */
  local?: boolean;
}

/** 원호 정렬 문자를 한 줄 문자(가운데 맞춤 TEXT) 글자들과 밑줄 호로. 배치할 수 없으면 빈 배열 */
export function arcTextParts(e: ArcTextEntity, opt: PartsOptions = {}): Entity[] {
  const def = opt.local ? { ...e, center: { x: 0, y: 0, z: 0 } } : e;
  const lay = layoutArcText(def);
  if (!lay) return [];
  const props: Omit<EntityBase, 'type'> = opt.local
    ? { handle: '', layer: '0', linetype: 'ByBlock', color: { aci: BYBLOCK }, lineweight: LW_BYBLOCK, ltscale: 1, transparency: TRANSPARENCY_BYBLOCK }
    : { handle: '', layer: e.layer, linetype: e.linetype, color: { ...e.color }, lineweight: e.lineweight, ltscale: e.ltscale, transparency: e.transparency };
  if (!opt.local && e.paperSpace) props.paperSpace = true;
  if (e.extrusion && !opt.local) props.extrusion = { ...e.extrusion };
  const z = opt.local ? 0 : e.center.z;
  const wf = e.widthFactor > 0 ? e.widthFactor : 1;
  const out: Entity[] = [];
  for (const g of lay.glyphs) {
    if (blank(g.ch)) continue;
    const c = Math.cos(g.rotation);
    const s = Math.sin(g.rotation);
    const t: TextEntity = {
      ...props,
      type: 'TEXT',
      insert: { x: g.x - (c * g.width) / 2, y: g.y - (s * g.width) / 2, z },
      alignPoint: { x: g.x, y: g.y, z },
      height: e.height,
      text: g.ch === '%' ? '%%%' : g.ch,
      rotation: g.rotation,
      widthFactor: wf,
      oblique: e.italic ? ITALIC_OBLIQUE : 0,
      style: e.style || 'Standard',
      generation: 0,
      halign: 1,
      valign: 0,
    };
    out.push(t);
  }
  if (lay.underline) {
    const u = lay.underline;
    const a: ArcEntity = { ...props, type: 'ARC', center: { x: def.center.x, y: def.center.y, z }, radius: u.radius, startAngle: u.startAngle, endAngle: u.endAngle };
    out.push(a);
  }
  return out;
}

/** 원호 정렬 문자가 차지하는 평면도 상자(OCS = WCS로 본다, 글자 자리 + 높이) */
export function arcTextBox(e: ArcTextEntity): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const lay = layoutArcText(e);
  if (!lay) return null;
  const outward = e.direction !== ARC_DIRECTION.inward;
  const r0 = outward ? lay.baseRadius - 0.25 * e.height : lay.baseRadius - e.height;
  const r1 = outward ? lay.baseRadius + e.height : lay.baseRadius + 0.25 * e.height;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (r: number, a: number) => {
    const x = e.center.x + r * Math.cos(a);
    const y = e.center.y + r * Math.sin(a);
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  };
  const { from, sweep } = lay.span;
  const steps = Math.max(2, Math.ceil(sweep / (Math.PI / 16)));
  for (let i = 0; i <= steps; i++) {
    const a = from + (sweep * i) / steps;
    grow(Math.max(0, r0), a);
    grow(r1, a);
  }
  return Number.isFinite(b.minX) ? b : null;
}

/** 정의 지문(원본 태그를 그대로 쓸 수 있는지 보려고 읽을 때와 비교한다) */
export function arcTextSig(e: ArcTextEntity): string {
  const r = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e9) / 1e9 : 0);
  const p = (v: Vec3) => [r(v.x), r(v.y), r(v.z)];
  return JSON.stringify([
    e.text,
    p(e.center),
    r(e.radius),
    r(e.startAngle),
    r(e.endAngle),
    e.arc ?? '',
    e.style,
    e.font,
    e.bigFont,
    r(e.height),
    r(e.widthFactor),
    r(e.charSpacing),
    r(e.offset),
    r(e.leftOffset),
    r(e.rightOffset),
    e.alignment,
    e.position,
    e.direction,
    e.reversed,
    e.bold,
    e.italic,
    e.underline,
    e.extrusion ? p(e.extrusion) : null,
  ]);
}

/** 원호 정렬 문자를 처음 만들 때의 기본값(AutoCAD 작업장 기본: 맞춤·볼록·바깥쪽) */
export function arcTextDefaults(): Omit<ArcTextEntity, keyof EntityBase | 'text' | 'center' | 'radius' | 'startAngle' | 'endAngle' | 'style' | 'height'> & { type: 'ARCALIGNEDTEXT' } {
  return {
    type: 'ARCALIGNEDTEXT',
    font: '',
    bigFont: '',
    widthFactor: 1,
    charSpacing: 0,
    offset: 0,
    leftOffset: 0,
    rightOffset: 0,
    alignment: ARC_ALIGN.fit,
    position: ARC_POSITION.convex,
    direction: ARC_DIRECTION.outward,
    reversed: false,
    bold: false,
    italic: false,
    underline: false,
  };
}
