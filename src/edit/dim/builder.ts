/**
 * 치수 블록 내용 만들기 도우미: 특성(색·선종류·선가중치), 객체 생성, 문자 배치, 자르기.
 * 좌표는 치수의 OCS 2D(블록 좌표)다. 블록 안 객체의 투명도는 ByBlock이다.
 */
import {
  type ArcEntity,
  type CadColor,
  type CadDocument,
  type DimensionEntity,
  type Entity,
  type FaceEntity,
  type InsertEntity,
  type LineEntity,
  type MTextEntity,
  type PointEntity,
  type Vec3,
  TRANSPARENCY_BYBLOCK,
  entityDefaults,
  tableKey,
} from '../../core/model';
import { invert, ocsMatrix, apply as applyMat } from '../../geom/matrix';
import { dimensionText, dimKindName, type DimKindName } from './format';
import type { MeasureText, TextBox } from './textbox';
import { type InspectLayout, inspectGeometry, inspectLayout, readInspect } from './inspect';
import type { DimVars } from './vars';
import { type P, dir, dot, madd, mul, norm2pi, normPi, p, perp, sub } from './vec';

export interface Props {
  layer: string;
  color: CadColor;
  linetype: string;
  lineweight: number;
}

const colorOf = (aci: number): CadColor => ({ aci: Number.isFinite(aci) ? Math.round(aci) : 0 });

export interface TextInfo {
  mtext: string;
  box: TextBox;
}

/** 놓을 문자: 가운데 점·각도·상자 */
export interface TextPlace {
  center: P;
  angle: number;
}

export class Out {
  readonly entities: Entity[] = [];
  readonly warnings: string[] = [];
  /** 도면에 없어서 새로 만들어야 할 화살촉 블록(이름 → 내용) */
  readonly arrowBlocks = new Map<string, Entity[]>();
  readonly kind: DimKindName;
  /** UCS X축 방향(OCS 각도). DIMTIH·DIMTOH의 "수평" */
  readonly h0: number;
  private readonly toOcs: Float64Array | null;
  readonly z: number;
  measurement = NaN;
  textMid: P | null = null;
  text: TextInfo | null = null;
  /** 검사 치수(DIMINSPECT)면 프레임 배치 */
  inspect: InspectLayout | null = null;
  readonly defpointsLayer: string;

  constructor(
    readonly doc: CadDocument,
    readonly dim: DimensionEntity,
    readonly v: DimVars,
    readonly measure: MeasureText,
  ) {
    this.kind = dimKindName(dim);
    this.h0 = -(dim.horizontalDirection || 0);
    const m = ocsMatrix(dim.extrusion);
    this.toOcs = m ? invert(m) : null;
    this.z = dim.textMid?.z ?? 0;
    this.defpointsLayer = doc.layers.get('DEFPOINTS')?.name ?? 'Defpoints';
  }

  /** WCS 정의점 → OCS 2D */
  w(q: Vec3): P {
    if (!this.toOcs) return p(q.x, q.y);
    const r = applyMat(this.toOcs, q.x, q.y, q.z);
    return p(r.x, r.y);
  }

  /** OCS 정의점(11·16) → 2D */
  o(q: Vec3): P {
    return p(q.x, q.y);
  }

  get userText(): boolean {
    return (this.dim.dimType & 128) !== 0;
  }

  private ltName(name: string): string {
    const t = name.trim();
    if (!t) return 'ByLayer';
    const u = t.toUpperCase();
    if (u === 'BYLAYER') return 'ByLayer';
    if (u === 'BYBLOCK') return 'ByBlock';
    return this.doc.linetypes.get(tableKey(t))?.name ?? t;
  }

  get layer(): string {
    return this.dim.layer || '0';
  }

  dimLineProps(): Props {
    return { layer: this.layer, color: colorOf(this.v.clrd), linetype: this.ltName(this.v.ltype), lineweight: this.v.lwd };
  }
  extProps(i: 1 | 2): Props {
    return { layer: this.layer, color: colorOf(this.v.clre), linetype: this.ltName(i === 1 ? this.v.ltex1 : this.v.ltex2), lineweight: this.v.lwe };
  }
  /** 화살촉 블록 참조: 색 DIMCLRD, 선종류 ByLayer, 선가중치 DIMLWD */
  arrowProps(): Props {
    return { layer: this.layer, color: colorOf(this.v.clrd), linetype: 'ByLayer', lineweight: this.v.lwd };
  }
  /** 채운 화살촉(SOLID) */
  solidProps(): Props {
    return { layer: this.layer, color: colorOf(this.v.clrd), linetype: 'ByLayer', lineweight: this.v.lwd >= 0 ? this.v.lwd : -1 };
  }
  textProps(): Props {
    return { layer: this.layer, color: colorOf(this.v.clrt), linetype: 'ByLayer', lineweight: -1 };
  }

  private base(pr: Props) {
    return { ...entityDefaults(), layer: pr.layer, color: { ...pr.color }, linetype: pr.linetype, lineweight: pr.lineweight, transparency: TRANSPARENCY_BYBLOCK };
  }

  private v3(q: P): Vec3 {
    return { x: q.x, y: q.y, z: 0 };
  }

  line(a: P, b: P, pr: Props): void {
    if (!(Math.hypot(b.x - a.x, b.y - a.y) > 1e-12)) return;
    const e: LineEntity = { ...this.base(pr), type: 'LINE', start: this.v3(a), end: this.v3(b) };
    this.entities.push(e);
  }

  /** 반시계 호(각도 라디안) */
  arc(c: P, r: number, a0: number, a1: number, pr: Props): void {
    if (!(r > 0) || !(norm2pi(a1 - a0) > 1e-12)) return;
    const e: ArcEntity = { ...this.base(pr), type: 'ARC', center: this.v3(c), radius: r, startAngle: norm2pi(a0), endAngle: norm2pi(a1) };
    this.entities.push(e);
  }

  solid(pts: [P, P, P, P], pr: Props): void {
    const e: FaceEntity = { ...this.base(pr), type: 'SOLID', points: [this.v3(pts[0]), this.v3(pts[1]), this.v3(pts[2]), this.v3(pts[3])], invisibleEdges: 0 };
    this.entities.push(e);
  }

  insert(block: string, at: P, scale: number, rotation: number, pr: Props): void {
    const e: InsertEntity = {
      ...this.base(pr),
      type: 'INSERT',
      block,
      insert: this.v3(at),
      scale: { x: scale, y: scale, z: scale },
      rotation: norm2pi(rotation),
      columnCount: 1,
      rowCount: 1,
      columnSpacing: 0,
      rowSpacing: 0,
      attribs: [],
    };
    this.entities.push(e);
  }

  /** 정의점(Defpoints 도면층, ByBlock 색) */
  point(q: P): void {
    const e: PointEntity = { ...this.base({ layer: this.defpointsLayer, color: { aci: 0 }, linetype: 'ByLayer', lineweight: -1 }), type: 'POINT', position: this.v3(q), angle: 0 };
    this.entities.push(e);
  }

  /** 치수 문자를 만든다(없으면 null) */
  makeText(measurement: number): TextInfo | null {
    const t = dimensionText(this.v.raw, this.kind, measurement, this.dim.text ?? '');
    if (!t.mtext) return null;
    const mtext = (this.v.tad === 0 ? '\\A1;' : '') + t.mtext;
    const box = this.measure(mtext, this.v.txt, this.v.textStyle);
    // 검사 치수: 레이블·값·검사율 칸을 문자 자리에(치수선은 프레임에서 끊긴다)
    const ins = readInspect(this.dim);
    if (ins?.on) {
      const lay = inspectLayout(ins, mtext, box, this.v.txt, this.v.gap, (t) => this.measure(t, this.v.txt, this.v.textStyle));
      this.inspect = lay;
      this.text = { mtext, box: { w: lay.W, h: lay.H } };
      return this.text;
    }
    this.text = { mtext, box };
    return this.text;
  }

  mtext(t: TextInfo, at: TextPlace): void {
    if (this.inspect) {
      const g = inspectGeometry(this.inspect, at.center.x, at.center.y, at.angle);
      const lp = this.dimLineProps();
      for (const [x0, y0, x1, y1] of g.lines) this.line(p(x0, y0), p(x1, y1), lp);
      for (const a of g.arcs) this.arc(p(a.cx, a.cy), a.r, a.a0, a.a1, lp);
      const inspect = this.inspect;
      this.inspect = null;
      for (const c of g.texts) this.mtext({ mtext: c.text, box: t.box }, { center: p(c.x, c.y), angle: at.angle });
      this.inspect = inspect;
      return;
    }
    const pr = this.textProps();
    const e: MTextEntity = {
      ...this.base(pr),
      type: 'MTEXT',
      insert: this.v3(at.center),
      height: this.v.txt,
      width: 0,
      attachment: 5,
      drawingDirection: 1,
      text: t.mtext,
      style: this.v.txsty,
      direction: { x: Math.cos(at.angle), y: Math.sin(at.angle), z: 0 },
      rotation: norm2pi(at.angle),
      lineSpacingStyle: this.dim.lineSpacingStyle || 1,
      lineSpacingFactor: this.dim.lineSpacingFactor || 1,
      backgroundFlags: 0,
      backgroundScale: 1.5,
    };
    if (this.v.tfill === 1) {
      e.backgroundFlags = 3;
      e.backgroundScale = 1.25;
    } else if (this.v.tfill === 2) {
      e.backgroundFlags = 1;
      e.backgroundScale = 1.25;
      e.backgroundColor = colorOf(this.v.tfillclr);
    }
    this.entities.push(e);
  }

  /** 읽기 쉬운 문자 각도: UCS 기준 (-90°, 90°] */
  readable(a: number): number {
    let r = normPi(a - this.h0);
    if (r > Math.PI / 2 + 1e-9 || r <= -Math.PI / 2 + 1e-9) r = normPi(r + Math.PI);
    return this.h0 + r;
  }

  /** 문자 각도: 재지정(53) > 수평(h) > 선 방향 */
  textAngle(lineAngle: number, horizontal: boolean): number {
    if (this.dim.textRotation) return this.dim.textRotation;
    return horizontal ? this.h0 : this.readable(lineAngle);
  }

  warn(code: string): void {
    if (!this.warnings.includes(code)) this.warnings.push(code);
  }
}

// ---------------------------------------------------------------------------
// 문자 상자 기하
// ---------------------------------------------------------------------------

/** 문자가 선과 나란한지 */
export function parallel(textAngle: number, lineAngle: number): boolean {
  return Math.abs(Math.sin(textAngle - lineAngle)) < 1e-6;
}

/** 상자(w×h, 각도 a)의 방향 u에 대한 폭 */
export function extentAlong(box: TextBox, textAngle: number, lineAngle: number): number {
  const r = textAngle - lineAngle;
  return Math.abs(box.w * Math.cos(r)) + Math.abs(box.h * Math.sin(r));
}

/**
 * 문자 위·아래 위치(DIMTAD): 선 위의 기준점에서 문자 가운데까지의 벡터.
 * outward: DIMTAD=2(바깥쪽)일 때 바깥 방향.
 */
export function verticalOffset(o: Out, box: TextBox, textAngle: number, lineAngle: number, outward?: P): P {
  const v = o.v;
  if (!parallel(textAngle, lineAngle)) return p(0, 0);
  const up = dir(textAngle + Math.PI / 2);
  if (v.tad === 0) return v.tvp ? mul(up, v.tvp * v.txt) : p(0, 0);
  let s = 1;
  if (v.tad === 4) s = -1;
  else if (v.tad === 2 && outward) s = dot(up, outward) < 0 ? -1 : 1;
  return mul(up, s * (v.gap + box.h / 2));
}

/** 문자가 선을 끊는지(가운데 놓임) */
export function textOnLine(o: Out, textAngle: number, lineAngle: number): boolean {
  if (!parallel(textAngle, lineAngle)) return true;
  if (o.v.tad !== 0) return false;
  return Math.abs(o.v.tvp) < 0.7;
}

/** 회전 사각형 */
export interface Rect {
  c: P;
  ax: P;
  hw: number;
  hh: number;
}

export function textRect(at: TextPlace, box: TextBox, gap: number): Rect {
  return { c: at.center, ax: dir(at.angle), hw: box.w / 2 + gap, hh: box.h / 2 + gap };
}

function toLocal(r: Rect, q: P): P {
  const d = sub(q, r.c);
  return p(dot(d, r.ax), dot(d, perp(r.ax)));
}

export function inRect(r: Rect, q: P, eps = 1e-9): boolean {
  const l = toLocal(r, q);
  return Math.abs(l.x) <= r.hw + eps && Math.abs(l.y) <= r.hh + eps;
}

/** 선분 a→b에서 사각형 안 구간 [t0, t1](0..1), 없으면 null */
export function clipInterval(a: P, b: P, r: Rect): [number, number] | null {
  const la = toLocal(r, a);
  const lb = toLocal(r, b);
  const d = sub(lb, la);
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-d.x, la.x + r.hw],
    [d.x, r.hw - la.x],
    [-d.y, la.y + r.hh],
    [d.y, r.hh - la.y],
  ];
  for (const [pp, q] of edges) {
    if (Math.abs(pp) < 1e-15) {
      if (q < 0) return null;
      continue;
    }
    const t = q / pp;
    if (pp < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return t1 - t0 > 1e-12 ? [t0, t1] : null;
}

/** 선분에서 사각형 부분을 뺀 조각(시작 쪽 조각, 끝 쪽 조각은 끝점에서 시작) */
export function cutSegment(a: P, b: P, r: Rect | null): [P, P][] {
  if (!r) return [[a, b]];
  const iv = clipInterval(a, b, r);
  if (!iv) return [[a, b]];
  const d = sub(b, a);
  const out: [P, P][] = [];
  if (iv[0] > 1e-9) out.push([a, madd(a, d, iv[0])]);
  if (iv[1] < 1 - 1e-9) out.push([b, madd(a, d, iv[1])]);
  return out;
}

/** 호(반시계 a0→a0+sweep)에서 사각형 안 각도 구간 */
export function arcClip(c: P, rad: number, a0: number, sweep: number, r: Rect | null): [number, number] | null {
  if (!r || !(sweep > 0)) return null;
  const N = Math.max(64, Math.ceil((sweep * rad) / (Math.min(r.hw, r.hh) / 4 || 1)));
  const at = (t: number) => madd(c, dir(a0 + sweep * t), rad);
  let first = -1;
  let last = -1;
  for (let i = 0; i <= Math.min(N, 20000); i++) {
    const t = i / Math.min(N, 20000);
    if (inRect(r, at(t))) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  const n = Math.min(N, 20000);
  const refine = (lo: number, hi: number, insideAtHi: boolean) => {
    for (let k = 0; k < 50; k++) {
      const m = (lo + hi) / 2;
      if (inRect(r, at(m)) === insideAtHi) hi = m;
      else lo = m;
    }
    return insideAtHi ? hi : lo;
  };
  const t0 = first === 0 ? 0 : refine((first - 1) / n, first / n, true);
  const t1 = last === n ? 1 : refine(last / n, (last + 1) / n, false);
  return [a0 + sweep * t0, a0 + sweep * t1];
}

