/**
 * 새 치수 객체 만들기: 정의점·종류·회전을 채우고 측정값·문자 중간점을 계산한다.
 * block은 ''(부르는 쪽이 *D 블록을 만들어 이름을 넣는다), handle도 ''다.
 */
import { type CadDocument, type DimensionEntity, type Vec3, entityDefaults } from '../../core/model';
import { generateDimensionGeometry } from './generate';
import { dimVars } from './vars';
import { type P, add, dir, dot, intersect, madd, mul, perp, sub, unit } from './vec';

export interface CreateDimOptions {
  /** 치수 스타일 이름(없으면 $DIMSTYLE, 그다음 Standard) */
  style?: string;
  /** 문자 재지정("" = 측정값, "<>" 포함 가능, " " = 숨김) */
  text?: string;
  /** 도면층(없으면 $CLAYER) */
  layer?: string;
}

const V = (q: { x: number; y: number; z?: number }): Vec3 => ({ x: q.x, y: q.y, z: q.z ?? 0 });
const P2 = (q: Vec3): P => ({ x: q.x, y: q.y });
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

function headerStr(doc: CadDocument, k: string): string | undefined {
  const v = doc.header.get(k);
  return typeof v === 'string' && v ? v : undefined;
}

function base(doc: CadDocument, dimType: number, opt: CreateDimOptions = {}): DimensionEntity {
  const style = opt.style ?? headerStr(doc, '$DIMSTYLE') ?? 'Standard';
  const ds = doc.dimStyles.get(style.toUpperCase());
  return {
    ...entityDefaults(),
    type: 'DIMENSION',
    layer: opt.layer ?? headerStr(doc, '$CLAYER') ?? '0',
    block: '',
    dimStyle: ds?.name ?? style,
    dimType: dimType | 32,
    defPoint: { ...ZERO },
    textMid: { ...ZERO },
    defPoint2: { ...ZERO },
    defPoint3: { ...ZERO },
    defPoint4: { ...ZERO },
    defPoint5: { ...ZERO },
    text: opt.text ?? '',
    measurement: NaN,
    rotation: 0,
    obliqueAngle: 0,
    textRotation: 0,
    horizontalDirection: 0,
    attachment: 5,
    leaderLength: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
  };
}

/** 측정값·문자 중간점 채우기 */
function finish(doc: CadDocument, d: DimensionEntity): DimensionEntity {
  const g = generateDimensionGeometry(doc, d);
  d.measurement = g.measurement;
  d.textMid = g.textMid;
  return d;
}

/** 수평·수직 자동: 치수선 점이 두 점의 X 범위 안이면 수평, Y 범위 안이면 수직, 그 밖은 더 먼 쪽 */
function autoRotation(p1: P, p2: P, q: P): number {
  const outX = Math.max(0, Math.min(p1.x, p2.x) - q.x, q.x - Math.max(p1.x, p2.x));
  const outY = Math.max(0, Math.min(p1.y, p2.y) - q.y, q.y - Math.max(p1.y, p2.y));
  if (outX === 0 && outY === 0) return Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y) ? 0 : Math.PI / 2;
  return outY >= outX ? 0 : Math.PI / 2;
}

/** 치수선이 지나는 점 q, 방향 u일 때 둘째 보조선 위의 정의점(10) */
function dimLinePoint(p2: P, q: P, u: P, extDir: P): P {
  return intersect(q, u, p2, extDir) ?? madd(p2, perp(u), dot(sub(q, p2), perp(u)));
}

export function createLinearDimension(
  doc: CadDocument,
  p1: Vec3,
  p2: Vec3,
  dimLinePt: Vec3,
  opt: CreateDimOptions & { rotation?: number } = {},
): DimensionEntity {
  const d = base(doc, 0, opt);
  const rot = opt.rotation ?? autoRotation(P2(p1), P2(p2), P2(dimLinePt));
  const u = dir(rot);
  d.rotation = rot;
  d.defPoint2 = V(p1);
  d.defPoint3 = V(p2);
  d.defPoint = V(dimLinePoint(P2(p2), P2(dimLinePt), u, perp(u)));
  return finish(doc, d);
}

export function createAlignedDimension(doc: CadDocument, p1: Vec3, p2: Vec3, dimLinePt: Vec3, opt: CreateDimOptions = {}): DimensionEntity {
  const d = base(doc, 1, opt);
  const u = unit(sub(P2(p2), P2(p1)));
  d.defPoint2 = V(p1);
  d.defPoint3 = V(p2);
  d.defPoint = V(dimLinePoint(P2(p2), P2(dimLinePt), u, perp(u)));
  return finish(doc, d);
}

/** 세 점 각도: center 꼭짓점, p1·p2 두 변 위 점, arcPoint 치수 호 위치 */
export function createAngularDimension(doc: CadDocument, center: Vec3, p1: Vec3, p2: Vec3, arcPoint: Vec3, opt: CreateDimOptions = {}): DimensionEntity {
  const d = base(doc, 5, opt);
  d.defPoint4 = V(center);
  d.defPoint2 = V(p1);
  d.defPoint3 = V(p2);
  d.defPoint = V(arcPoint);
  return finish(doc, d);
}

/** 두 선 각도: l1a→l1b, l2a→l2b, arcPoint 치수 호 위치 */
export function createAngular2LineDimension(
  doc: CadDocument,
  l1a: Vec3,
  l1b: Vec3,
  l2a: Vec3,
  l2b: Vec3,
  arcPoint: Vec3,
  opt: CreateDimOptions = {},
): DimensionEntity {
  const d = base(doc, 2, opt);
  d.defPoint2 = V(l1a);
  d.defPoint3 = V(l1b);
  d.defPoint4 = V(l2a);
  d.defPoint = V(l2b);
  d.defPoint5 = V(arcPoint);
  return finish(doc, d);
}

const towards = (center: Vec3, radius: number, a: number | Vec3): P => {
  const c = P2(center);
  const u = typeof a === 'number' ? dir(a) : unit(sub(P2(a), c));
  return madd(c, u, radius);
};

/** 반지름: chordAngleOrPoint = 호 위 점의 각도(라디안) 또는 그 방향의 점 */
export function createRadialDimension(doc: CadDocument, center: Vec3, radius: number, chordAngleOrPoint: number | Vec3, opt: CreateDimOptions = {}): DimensionEntity {
  const d = base(doc, 4, opt);
  d.defPoint = V(center);
  d.defPoint4 = V({ ...towards(center, radius, chordAngleOrPoint), z: center.z });
  return finish(doc, d);
}

/** 지름: pointOnCircle 쪽이 문자·화살촉 쪽(15), 반대쪽이 10 */
export function createDiameterDimension(doc: CadDocument, center: Vec3, radius: number, pointOnCircle: number | Vec3, opt: CreateDimOptions = {}): DimensionEntity {
  const d = base(doc, 3, opt);
  const near = towards(center, radius, pointOnCircle);
  const c = P2(center);
  d.defPoint4 = V({ ...near, z: center.z });
  d.defPoint = V({ ...add(c, sub(c, near)), z: center.z });
  return finish(doc, d);
}

/** 세로좌표: xAxis가 없으면 지시선이 세로에 가까울 때 X 좌표 */
export function createOrdinateDimension(doc: CadDocument, featurePoint: Vec3, leaderEnd: Vec3, opt: CreateDimOptions & { xAxis?: boolean } = {}): DimensionEntity {
  const dx = Math.abs(leaderEnd.x - featurePoint.x);
  const dy = Math.abs(leaderEnd.y - featurePoint.y);
  const xType = opt.xAxis ?? dy >= dx;
  const d = base(doc, 6 | (xType ? 64 : 0), opt);
  const org = doc.header.get('$UCSORG');
  d.defPoint = org && typeof org === 'object' ? V(org as Vec3) : { ...ZERO };
  d.defPoint2 = V(featurePoint);
  d.defPoint3 = V(leaderEnd);
  return finish(doc, d);
}

/** 호 길이: 중심·반지름·시작·끝 각도(반시계, 라디안), arcPoint 치수 호 위치 */
export function createArcLengthDimension(
  doc: CadDocument,
  center: Vec3,
  radius: number,
  startAngle: number,
  endAngle: number,
  arcPoint: Vec3,
  opt: CreateDimOptions = {},
): DimensionEntity {
  const d = base(doc, 5, opt);
  d.subtype = 'ARC_DIMENSION';
  const c = P2(center);
  const s = V({ ...madd(c, dir(startAngle), radius), z: center.z });
  const e = V({ ...madd(c, dir(endAngle), radius), z: center.z });
  d.defPoint2 = s;
  d.defPoint3 = e;
  d.defPoint4 = V(center);
  d.defPoint = V(arcPoint);
  d.arc = { center: V(center), start: { ...s }, end: { ...e }, startAngle, endAngle, partial: false };
  return finish(doc, d);
}

/**
 * 문자 위치 옮기기(70 비트 128). DIMTMOVE 0이면 AutoCAD처럼 치수선(호·지시선)도 문자를 따라 옮긴다.
 * 새 객체를 돌려준다(블록은 다시 만들어야 한다).
 */
export function moveDimensionText(doc: CadDocument, dim: DimensionEntity, textMid: Vec3): DimensionEntity {
  const d: DimensionEntity = structuredClone(dim);
  d.textMid = V(textMid);
  d.dimType |= 128;
  const v = dimVars(doc, d);
  if (v.tmove !== 0 || d.extrusion) return finish(doc, d);
  const t = P2(textMid);
  const kind = d.subtype === 'ARC_DIMENSION' ? 'arc' : d.dimType & 7;
  if (kind === 0 || kind === 1) {
    const p1 = P2(d.defPoint2);
    const p2 = P2(d.defPoint3);
    const u = kind === 1 ? unit(sub(p2, p1)) : dir(d.rotation);
    const e = d.obliqueAngle ? dir(d.obliqueAngle) : perp(u);
    d.defPoint = V({ ...dimLinePoint(p2, t, u, e), z: d.defPoint.z });
  } else if (kind === 4 || kind === 3) {
    const far = P2(d.defPoint);
    const near = P2(d.defPoint4);
    const c = kind === 4 ? far : mul(add(far, near), 0.5);
    const r = Math.hypot(near.x - c.x, near.y - c.y);
    const u = unit(sub(t, c), unit(sub(near, c)));
    d.defPoint4 = V({ ...madd(c, u, r), z: d.defPoint4.z });
    if (kind === 3) d.defPoint = V({ ...madd(c, u, -r), z: d.defPoint.z });
  } else if (kind === 2 || kind === 5 || kind === 'arc') {
    const c = kind === 2 ? null : P2(kind === 'arc' ? (d.arc?.center ?? d.defPoint4) : d.defPoint4);
    if (kind === 2) {
      const x = intersect(P2(d.defPoint2), sub(P2(d.defPoint3), P2(d.defPoint2)), P2(d.defPoint4), sub(P2(d.defPoint), P2(d.defPoint4)));
      if (x) {
        const old = P2(d.defPoint5);
        const r = Math.hypot(t.x - x.x, t.y - x.y);
        d.defPoint5 = V({ ...madd(x, unit(sub(old, x)), r), z: d.defPoint5.z });
      }
    } else if (c) {
      const old = P2(d.defPoint);
      const r = Math.hypot(t.x - c.x, t.y - c.y);
      d.defPoint = V({ ...madd(c, unit(sub(old, c)), r), z: d.defPoint.z });
    }
  } else if (kind === 6) {
    d.defPoint3 = V({ ...t, z: d.defPoint3.z });
  }
  return finish(doc, d);
}

/** 새 치수 블록 이름: 도면에 있는 *D 번호 중 가장 큰 것 + 1 */
export function nextDimBlockName(doc: CadDocument): string {
  let max = 0;
  for (const b of doc.blocks.values()) {
    const m = /^\*D(\d+)$/i.exec(b.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  for (const r of doc.blockRecords.values()) {
    const m = /^\*D(\d+)$/i.exec(r.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `*D${max + 1}`;
}
