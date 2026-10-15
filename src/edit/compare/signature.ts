/**
 * 도면 비교의 객체 서명: 정확히 같아야 하는 값(종류·이름·문자·플래그)은 열쇠 글로, 허용 오차 안에서 같으면 되는
 * 값(좌표·길이)은 숫자 목록으로, 각도는 따로(도 단위, 원 위에서 360 = 0) 모은다.
 *
 * 같은 모양이면 읽은 형식(DXF·DWG)과 상관없이 같은 서명이 나오도록 다음을 맞춘다.
 * - 없는 돌출 방향은 (0, 0, 1), 없는 두께는 0, 이름은 대문자.
 * - 선(LINE)은 두 끝점의 순서를 정렬한다(거꾸로 그린 선도 같은 선).
 * - 핸들·소유자·반응자·확장 사전·원본 바이트처럼 파일마다 다른 값은 넣지 않는다.
 */
import type { CadDocument, Entity, HatchEdge, HatchPath, Vec2, Vec3 } from '../../core/model';
import { lwVertices } from '../../core/lwpoly';

/** COMPAREPROPS 비트 */
export const PROP_COLOR = 1;
export const PROP_LAYER = 2;
export const PROP_LINETYPE = 4;
export const PROP_LTSCALE = 8;
export const PROP_LINEWEIGHT = 16;
export const PROP_THICKNESS = 32;
export const PROP_TRANSPARENCY = 64;

export interface CompareOptions {
  /** 허용 오차 자릿수(COMPARETOLERANCE 0–14): 허용 오차 = 10^-n */
  tolerance: number;
  /** 문자 객체 비교(COMPARETEXT) */
  text: boolean;
  /** 해치 비교(COMPAREHATCH) */
  hatch: boolean;
  /** 비교할 특성 비트(COMPAREPROPS) */
  props: number;
}

export const DEFAULT_OPTIONS: CompareOptions = { tolerance: 6, text: true, hatch: false, props: 0 };

export interface Signature {
  /** 정확히 같아야 하는 값 */
  key: string;
  /** 허용 오차 안에서 같으면 되는 값 */
  nums: number[];
  /** 각도(도, 0 ≤ a < 360) */
  angs: number[];
  /** 블록 참조가 쓰는 블록 이름(대문자): 정의 내용도 같아야 같다 */
  block: string | null;
  /** 공간 해시에 쓰는 대표점 */
  ax: number;
  ay: number;
}

/** 문자 객체(COMPARETEXT가 0이면 비교하지 않는다) */
export function isTextEntity(e: Entity): boolean {
  return e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTDEF';
}

/** 해치(COMPAREHATCH가 0이면 비교하지 않는다) */
export function isHatchEntity(e: Entity): boolean {
  return e.type === 'HATCH' || e.type === 'MPOLYGON';
}

/** 비교 대상인지(필터로 뺀 객체는 차이 없음으로 둔다) */
export function isCompared(e: Entity, opt: CompareOptions): boolean {
  if (!opt.text && isTextEntity(e)) return false;
  if (!opt.hatch && isHatchEntity(e)) return false;
  return true;
}

const DEG = 180 / Math.PI;
const SEP = '\u0001';

/** 각도(라디안) → 0 ≤ 도 < 360 */
export function normDeg(rad: number): number {
  let d = (rad * DEG) % 360;
  if (d < 0) d += 360;
  return d === 360 ? 0 : d;
}

class Builder {
  readonly parts: string[];
  readonly nums: number[] = [];
  readonly angs: number[] = [];
  block: string | null = null;
  ax = NaN;
  ay = NaN;

  constructor(type: string) {
    this.parts = [type];
  }

  k(...v: (string | number | boolean | undefined)[]): void {
    for (const x of v) this.parts.push(x === undefined ? '' : typeof x === 'boolean' ? (x ? '1' : '0') : String(x));
  }

  n(...v: (number | undefined)[]): void {
    for (const x of v) this.nums.push(x ?? 0);
  }

  p(v: Vec3 | Vec2 | undefined, z = true): void {
    if (!v) {
      this.nums.push(0, 0);
      if (z) this.nums.push(0);
      return;
    }
    this.nums.push(v.x, v.y);
    if (z) this.nums.push((v as Vec3).z ?? 0);
  }

  a(...rad: (number | undefined)[]): void {
    for (const r of rad) this.angs.push(normDeg(r ?? 0));
  }

  anchor(x: number, y: number): void {
    if (Number.isNaN(this.ax)) {
      this.ax = x;
      this.ay = y;
    }
  }

  finish(): Signature {
    if (Number.isNaN(this.ax)) {
      this.ax = this.nums[0] ?? 0;
      this.ay = this.nums[1] ?? 0;
    }
    return { key: this.parts.join(SEP), nums: this.nums, angs: this.angs, block: this.block, ax: this.ax, ay: this.ay };
  }
}

const Z: Vec3 = { x: 0, y: 0, z: 1 };

function colorKey(c: { aci: number; rgb?: number } | undefined): string {
  if (!c) return 'a256';
  return c.rgb !== undefined ? `r${c.rgb & 0xffffff}` : `a${c.aci}`;
}

const up = (s: string | undefined) => (s ?? '').toUpperCase();

/**
 * 문자 내용: \U+XXXX 이스케이프(옛 DXF 코드 페이지로 저장한 글자)를 글자로, DXF의 캐럿 표기(^J 줄바꿈, ^I 탭,
 * ^M, "^ " = ^)를 제어 문자로 바꾼다(같은 문자를 DXF·DWG로 저장한 것이 같게).
 */
export function normText(t: string | undefined): string {
  if (!t) return '';
  let out = t;
  if (out.indexOf('\\U+') >= 0 || out.indexOf('\\u+') >= 0) out = out.replace(/\\[Uu]\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  if (out.indexOf('^') >= 0) out = out.replace(/\^([JIM ])/g, (_, c: string) => (c === 'J' ? '\n' : c === 'I' ? '\t' : c === 'M' ? '\r' : '^'));
  return out;
}

/** 두 점을 정해진 순서로(x, 같으면 y, 같으면 z) */
function ordered(a: Vec3, b: Vec3, tol: number): [Vec3, Vec3] {
  const dx = a.x - b.x;
  if (Math.abs(dx) > tol) return dx < 0 ? [a, b] : [b, a];
  const dy = a.y - b.y;
  if (Math.abs(dy) > tol) return dy < 0 ? [a, b] : [b, a];
  return (a.z ?? 0) <= (b.z ?? 0) ? [a, b] : [b, a];
}

/** 해치 경계 하나 */
function hatchPath(s: Builder, p: HatchPath): void {
  s.k('P', p.flags & ~0x100);
  if (p.polyline) {
    s.k(p.polyline.closed, p.polyline.vertices.length);
    for (const v of p.polyline.vertices) s.n(v.x, v.y, v.bulge ?? 0);
  }
  for (const e of p.edges ?? []) hatchEdge(s, e);
}

function hatchEdge(s: Builder, e: HatchEdge): void {
  s.k(e.type);
  switch (e.type) {
    case 'line':
      s.p(e.start, false);
      s.p(e.end, false);
      break;
    case 'arc':
      s.k(e.ccw);
      s.p(e.center, false);
      s.n(e.radius);
      s.a(e.startAngle, e.endAngle);
      break;
    case 'ellipse':
      s.k(e.ccw);
      s.p(e.center, false);
      s.p(e.majorAxis, false);
      s.n(e.ratio);
      s.a(e.startAngle, e.endAngle);
      break;
    case 'spline':
      s.k(e.degree, e.rational, e.periodic, e.knots.length, e.controlPoints.length, e.fitPoints?.length ?? 0);
      s.n(...e.knots);
      for (const c of e.controlPoints) s.p(c, false);
      if (e.weights) s.n(...e.weights);
      for (const f of e.fitPoints ?? []) s.p(f, false);
      break;
  }
}

/** 핸들이나 파일마다 다른 값을 담는 키(일반 경로에서 뺀다) */
const SKIP_KEYS = new Set([
  'type',
  'handle',
  'owner',
  'layer',
  'linetype',
  'color',
  'lineweight',
  'ltscale',
  'transparency',
  'invisible',
  'paperSpace',
  'extrusion',
  'thickness',
  'xdata',
  'xdict',
  'reactors',
  'plotStyle',
  'material',
  'hyperlink',
  'dwgRaw',
  'rawVersion',
  'imageDef',
  'imageDefReactor',
  'definition',
  'annotation',
  'block',
  'sources',
  'pixelSize',
  'seedPoints',
  'clipBoundary',
]);

/** 원본 태그 중 핸들을 담는 그룹 코드 */
function handleCode(c: number): boolean {
  return c === 5 || c === 105 || (c >= 320 && c <= 369) || (c >= 390 && c <= 399) || c === 480 || c === 481 || c === 1005;
}

function hashBytes(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return `${b.length}:${(h >>> 0).toString(16)}`;
}

const isAngleKey = (k: string) => /angle|rotation|oblique|param$|twist/i.test(k);

/** 일반 경로: 값을 이름 순서로 훑는다(드문 종류용) */
function walk(s: Builder, v: unknown, key: string, opt: CompareOptions, depth: number): void {
  if (v === undefined || v === null || depth > 8) return;
  if (typeof v === 'number') {
    if (isAngleKey(key)) s.a(v);
    else s.n(v);
    return;
  }
  if (typeof v === 'string') {
    if (!opt.text && /^(text|contents?|textString)$/i.test(key)) return;
    s.k(normText(v));
    return;
  }
  if (typeof v === 'boolean') {
    s.k(v);
    return;
  }
  if (v instanceof Uint8Array) {
    s.k(hashBytes(v));
    return;
  }
  if (Array.isArray(v)) {
    s.k(`[${v.length}`);
    for (const x of v) walk(s, x, key, opt, depth + 1);
    return;
  }
  if (typeof v === 'object') {
    // 색(CadColor)은 특성: COMPAREPROPS 색상 비트가 켜졌을 때만
    if ('aci' in (v as object)) {
      if (opt.props & PROP_COLOR) s.k(colorKey(v as { aci: number; rgb?: number }));
      return;
    }
    const keys = Object.keys(v as object).sort();
    for (const k of keys) {
      if (depth === 0 && SKIP_KEYS.has(k)) continue;
      if (/handle$/i.test(k)) continue;
      const x = (v as Record<string, unknown>)[k];
      if (k === 'raw' && Array.isArray(x)) {
        // 원본 태그(ACIS 등): 핸들 코드는 빼고 값만
        for (const t of x as { code: number; value: string | number }[]) if (!handleCode(t.code)) s.k(t.code, t.value);
        continue;
      }
      if (x === undefined) continue;
      s.k(k);
      walk(s, x, k, opt, depth + 1);
    }
  }
}

/**
 * 객체의 서명. doc은 이미지 정의 같은 참조 객체의 이름을 찾는 데 쓴다.
 * tol은 선 끝점 정렬에만 쓴다(허용 오차 비교는 서명을 비교할 때).
 */
export function entitySignature(e: Entity, opt: CompareOptions, doc?: CadDocument, tol = 10 ** -opt.tolerance): Signature {
  const s = new Builder(e.type);
  switch (e.type) {
    case 'LINE': {
      const [a, b] = ordered(e.start, e.end, tol);
      s.anchor(a.x, a.y);
      s.p(a);
      s.p(b);
      break;
    }
    case 'POINT':
      s.anchor(e.position.x, e.position.y);
      s.p(e.position);
      s.a(e.angle);
      break;
    case 'CIRCLE':
      s.anchor(e.center.x, e.center.y);
      s.p(e.center);
      s.n(e.radius);
      break;
    case 'ARC':
      s.anchor(e.center.x, e.center.y);
      s.p(e.center);
      s.n(e.radius);
      s.a(e.startAngle, e.endAngle);
      break;
    case 'ELLIPSE':
      s.anchor(e.center.x, e.center.y);
      s.p(e.center);
      s.p(e.majorAxis);
      s.n(e.ratio);
      s.a(e.startParam, e.endParam);
      break;
    case 'LWPOLYLINE': {
      const vs = lwVertices(e);
      const v0 = vs[0];
      if (v0) s.anchor(v0.x, v0.y);
      s.k(e.closed, e.plinegen, vs.length);
      for (const v of vs) s.n(v.x, v.y, v.bulge ?? 0, v.startWidth ?? 0, v.endWidth ?? 0);
      s.n(e.constantWidth ?? 0, e.elevation ?? 0);
      break;
    }
    case 'POLYLINE': {
      const v0 = e.vertices[0];
      if (v0) s.anchor(v0.location.x, v0.location.y);
      s.k(e.kind, e.flags & 0xff, e.vertices.length, e.mCount, e.nCount, e.smoothType);
      for (const v of e.vertices) {
        s.k(v.flags & 0xff, v.faceIndices?.join(','));
        s.p(v.location);
        s.n(v.bulge ?? 0, v.startWidth ?? 0, v.endWidth ?? 0);
      }
      s.n(e.elevation ?? 0, e.defaultStartWidth ?? 0, e.defaultEndWidth ?? 0);
      break;
    }
    case 'SPLINE': {
      const p0 = e.controlPoints[0] ?? e.fitPoints[0];
      if (p0) s.anchor(p0.x, p0.y);
      s.k(e.flags & 0x1f, e.degree, e.knots.length, e.controlPoints.length, e.fitPoints.length, !!e.weights, !!e.startTangent, !!e.endTangent);
      for (const c of e.controlPoints) s.p(c);
      s.n(...e.knots);
      if (e.weights) s.n(...e.weights);
      for (const f of e.fitPoints) s.p(f);
      if (e.startTangent) s.p(e.startTangent);
      if (e.endTangent) s.p(e.endTangent);
      if (e.helix) walk(s, e.helix, 'helix', opt, 1);
      break;
    }
    case 'XLINE':
    case 'RAY':
      s.anchor(e.base.x, e.base.y);
      s.p(e.base);
      s.p(e.direction);
      break;
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF': {
      // 정렬한 문자는 정렬점이 위치를 정한다(삽입점은 그로부터 계산된 값)
      const h = e.halign;
      const v = e.valign;
      const left = h === 0 && v === 0;
      const both = h === 3 || h === 5;
      const pos = left || both || !e.alignPoint ? e.insert : e.alignPoint;
      s.anchor(pos.x, pos.y);
      s.p(pos);
      if (both) s.p(e.alignPoint ?? e.insert);
      s.k(normText(e.text), up(e.style), e.generation, h, v);
      s.n(e.height, e.widthFactor);
      s.a(e.rotation, e.oblique);
      if (e.type !== 'TEXT') {
        const a = e as Extract<Entity, { tag: string }>;
        s.k(up(a.tag), normText(a.prompt), a.attFlags, normText(a.mtext?.text));
      }
      break;
    }
    case 'MTEXT': {
      s.anchor(e.insert.x, e.insert.y);
      s.p(e.insert);
      s.k(normText(e.text), up(e.style), e.attachment, e.drawingDirection, e.lineSpacingStyle, e.backgroundFlags, colorKey(e.backgroundColor), e.columns ? JSON.stringify(e.columns) : '');
      s.n(e.height, e.width, e.lineSpacingFactor, e.backgroundScale);
      s.a(e.direction ? Math.atan2(e.direction.y, e.direction.x) : e.rotation);
      break;
    }
    case 'INSERT': {
      const name = up(e.block);
      // 익명 블록(동적 블록 표현 *U 등)은 이름이 파일마다 달라 내용으로만 비교한다
      s.k(name.startsWith('*') ? name.slice(0, 2) : name, e.columnCount, e.rowCount);
      s.block = name;
      s.anchor(e.insert.x, e.insert.y);
      s.p(e.insert);
      s.p(e.scale);
      s.a(e.rotation);
      if (e.columnCount > 1) s.n(e.columnSpacing);
      if (e.rowCount > 1) s.n(e.rowSpacing);
      if (opt.text) {
        s.k(e.attribs.length);
        for (const a of e.attribs) {
          s.k(up(a.tag), normText(a.text), a.attFlags & 1, up(a.style), a.halign, a.valign, normText(a.mtext?.text));
          const pos = (a.halign === 0 && a.valign === 0) || !a.alignPoint ? a.insert : a.alignPoint;
          s.p(pos);
          s.n(a.height, a.widthFactor);
          s.a(a.rotation);
        }
      }
      break;
    }
    case 'DIMENSION': {
      s.anchor(e.defPoint.x, e.defPoint.y);
      s.k(e.subtype, (e.dimType & 0x0f) | (e.dimType & 0x40), up(e.dimStyle), e.attachment, e.lineSpacingStyle);
      if (opt.text) s.k(normText(e.text));
      if (e.overrides) {
        const ks = Object.keys(e.overrides).sort((a, b) => Number(a) - Number(b));
        // 핸들 재지정(화살표 블록 등 340번대)은 파일마다 달라 뺀다
        for (const k of ks) if (!handleCode(Number(k))) s.k(`${k}=${e.overrides[Number(k)]}`);
      }
      s.p(e.defPoint);
      // 문자 위치는 사용자가 옮겼을 때(70 비트 128)만: 아니면 치수 스타일로 계산된 값이라 그리는 프로그램마다 조금 다르다
      if (e.dimType & 128) s.p(e.textMid);
      s.p(e.defPoint2);
      s.p(e.defPoint3);
      s.p(e.defPoint4);
      s.p(e.defPoint5);
      s.n(e.leaderLength, e.lineSpacingFactor);
      s.a(e.rotation, e.obliqueAngle, e.textRotation);
      if (e.arc) {
        s.k(e.arc.partial);
        s.p(e.arc.center);
        s.p(e.arc.start);
        s.p(e.arc.end);
        s.a(e.arc.startAngle, e.arc.endAngle);
      }
      break;
    }
    case 'LEADER': {
      const v0 = e.vertices[0];
      if (v0) s.anchor(v0.x, v0.y);
      s.k(up(e.dimStyle), e.arrowHead, e.pathType, e.creation, e.hooklineDirection, e.hookline, e.vertices.length);
      for (const v of e.vertices) s.p(v);
      s.n(e.textHeight, e.textWidth);
      break;
    }
    case 'HATCH':
    case 'MPOLYGON': {
      const p0 = e.paths[0];
      const q = p0?.polyline?.vertices[0] ?? (p0?.edges?.[0] ? edgeStart(p0.edges[0]) : undefined);
      if (q) s.anchor(q.x, q.y);
      s.k(up(e.patternName), e.solid, e.hatchStyle, e.patternType, e.patternDouble, e.paths.length);
      if (e.gradient?.enabled) {
        const g = e.gradient;
        s.k(up(g.name), g.singleColor, colorKey(g.color1), colorKey(g.color2));
        s.n(g.tint, g.shift);
        s.a(g.angle);
      }
      if (e.fillColor) s.k(colorKey(e.fillColor));
      if (!e.solid) {
        s.n(e.patternScale);
        s.a(e.patternAngle);
        if (e.patternType === 2) s.k(e.patternLines.length);
      }
      s.n(e.elevation ?? 0);
      for (const p of e.paths) hatchPath(s, p);
      break;
    }
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      s.anchor(e.points[0].x, e.points[0].y);
      s.k(e.invisibleEdges);
      for (const p of e.points) s.p(p);
      break;
    case 'IMAGE':
    case 'WIPEOUT': {
      s.anchor(e.insert.x, e.insert.y);
      const def = e.imageDef && doc ? doc.objects.get(e.imageDef) : undefined;
      s.k(def && 'fileName' in def ? up((def as { fileName: string }).fileName.replace(/^.*[\\/]/, '')) : '', e.clipping, e.clipBoundaryType, e.clipInverted, e.displayFlags & 0x0f, e.brightness, e.contrast, e.fade, e.clipBoundary.length);
      s.p(e.insert);
      s.p(e.uVector);
      s.p(e.vVector);
      s.p(e.imageSize, false);
      for (const c of e.clipBoundary) s.p(c, false);
      break;
    }
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY': {
      s.anchor(e.insert.x, e.insert.y);
      const def = e.definition && doc ? doc.objects.get(e.definition) : undefined;
      s.k(def && 'fileName' in def ? up(String((def as { fileName: string }).fileName).replace(/^.*[\\/]/, '')) : '', def && 'name' in def ? String((def as { name: string }).name) : '', e.flags, e.contrast, e.fade, e.clipBoundary.length);
      s.p(e.insert);
      s.p(e.scale);
      s.a(e.rotation);
      for (const c of e.clipBoundary) s.p(c, false);
      break;
    }
    case 'ACAD_TABLE': {
      s.anchor(e.insert.x, e.insert.y);
      s.k(e.rows, e.columns, up(e.tableStyle));
      if (opt.text) for (const c of e.cells ?? []) s.k(normText(c.text));
      s.p(e.insert);
      s.p(e.direction);
      s.p(e.scale);
      s.a(e.rotation);
      s.n(...e.rowHeights, ...e.columnWidths);
      break;
    }
    default:
      walk(s, e, '', opt, 0);
  }
  // 공통 특성: 보이기와 돌출 방향은 늘, 나머지는 COMPAREPROPS 비트대로
  s.k(e.invisible ? 1 : 0);
  s.p(e.extrusion ?? Z);
  const pr = opt.props;
  if (pr & PROP_COLOR) s.k(colorKey(e.color));
  if (pr & PROP_LAYER) s.k(up(e.layer));
  if (pr & PROP_LINETYPE) s.k(up(e.linetype || 'BYLAYER'));
  if (pr & PROP_LTSCALE) s.n(e.ltscale ?? 1);
  if (pr & PROP_LINEWEIGHT) s.k(e.lineweight);
  if (pr & PROP_THICKNESS) s.n(e.thickness ?? 0);
  if (pr & PROP_TRANSPARENCY) s.k(e.transparency);
  return s.finish();
}

function edgeStart(e: HatchEdge): Vec2 {
  switch (e.type) {
    case 'line':
      return e.start;
    case 'arc':
    case 'ellipse':
      return e.center;
    case 'spline':
      return e.controlPoints[0] ?? e.fitPoints?.[0] ?? { x: 0, y: 0 };
  }
}

/** 두 수가 허용 오차 안인지(부동소수점 반올림 몇 단계는 봐준다) */
export function near(a: number, b: number, tol: number): boolean {
  if (a === b) return true;
  if (a !== a) return b !== b;
  return Math.abs(a - b) <= tol + 4 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
}

/** 두 각도(도)가 원 위에서 허용 오차 안인지 */
export function nearAngle(a: number, b: number, tol: number): boolean {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d <= tol + 1e-12;
}

/** 열쇠가 같은 두 서명의 숫자·각도가 허용 오차 안인지(블록 내용은 따로) */
export function nearSignature(a: Signature, b: Signature, tol: number): boolean {
  const an = a.nums;
  const bn = b.nums;
  if (an.length !== bn.length || a.angs.length !== b.angs.length) return false;
  for (let i = 0; i < an.length; i++) if (!near(an[i]!, bn[i]!, tol)) return false;
  for (let i = 0; i < a.angs.length; i++) if (!nearAngle(a.angs[i]!, b.angs[i]!, tol)) return false;
  return true;
}
