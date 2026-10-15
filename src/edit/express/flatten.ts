/**
 * FLATTEN(Express Tools 평면화) 계산(UI 없음) — 2D 도면용.
 * Z 좌표·고도·두께를 0으로 만든다(평면도 모양은 그대로). Z축이 기울어진(OCS가 XY와 평행하지 않은) 원·호·문자 같은
 * 객체와 장축이 XY 밖으로 나간 타원은 평면도 모양을 지킬 수 없어 건너뛴다. 3D 솔리드·메시·표면도 건너뛴다.
 * 돌출 방향이 −Z인 객체는 평면도 모양을 지킨 채 +Z 객체로 바꾼다(변환 행렬은 항등).
 */
import type { CadDocument, Entity, Vec3 } from '../../core/model';
import { isNaturalExt, isPlanarExt } from '../geom/ocs';
import { transformEntity } from '../geom/transform';

const z0 = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: 0 });
const z0opt = (p: Vec3 | undefined): Vec3 | undefined => (p ? z0(p) : undefined);

export type FlattenResult = { entity: Entity } | { skip: string } | null;

/** 평면화할 수 없는 종류 */
const SOLIDS = new Set(['REGION', '3DSOLID', 'BODY', 'SURFACE', 'PLANESURFACE', 'EXTRUDEDSURFACE', 'LOFTEDSURFACE', 'REVOLVEDSURFACE', 'SWEPTSURFACE', 'NURBSURFACE', 'MESH']);

function flatNumbers(e: Entity): boolean {
  return !e.thickness;
}

/** 객체 하나를 평면화(바뀌지 않으면 null, 못 하면 skip) */
export function flattenEntity(e: Entity, doc: CadDocument): FlattenResult {
  if (SOLIDS.has(e.type)) return { skip: '3D 솔리드·표면·메시' };
  if (e.type === 'POLYLINE' && (e.kind === 'mesh' || e.kind === 'polyface')) return { skip: '3D 솔리드·표면·메시' };
  let src: Entity = e;
  if (!isNaturalExt(e.extrusion)) {
    if (!isPlanarExt(e.extrusion)) return { skip: 'Z축이 기울어진 객체' };
    // −Z 돌출: 항등 변환으로 +Z 객체로 바꾼다
    try {
      const r = transformEntity(e, [1, 0, 0, 1, 0, 0], doc, { mirrorText: true, exact: true, mirrorHatch: true });
      const n = r.replace?.[0] ?? r.add?.[0];
      if (n && isNaturalExt(n.extrusion)) src = { ...n, handle: e.handle };
    } catch {
      /* 그대로 둔다 */
    }
    if (!isNaturalExt(src.extrusion)) return { skip: 'Z축이 −Z인 객체(바꿀 수 없음)' };
  }
  const out = structuredClone(src) as Entity;
  delete out.thickness;
  delete out.extrusion;
  switch (out.type) {
    case 'LINE':
      out.start = z0(out.start);
      out.end = z0(out.end);
      break;
    case 'POINT':
      out.position = z0(out.position);
      break;
    case 'CIRCLE':
    case 'ARC':
      out.center = z0(out.center);
      break;
    case 'ELLIPSE':
      if (Math.abs(out.majorAxis.z) > 1e-9 * Math.hypot(out.majorAxis.x, out.majorAxis.y, out.majorAxis.z)) return { skip: '장축이 XY 평면 밖으로 나간 타원' };
      out.center = z0(out.center);
      out.majorAxis = z0(out.majorAxis);
      break;
    case 'LWPOLYLINE':
      out.elevation = 0;
      break;
    case 'POLYLINE':
      out.elevation = 0;
      for (const v of out.vertices) v.location = z0(v.location);
      break;
    case 'SPLINE':
      out.controlPoints = out.controlPoints.map(z0);
      out.fitPoints = out.fitPoints.map(z0);
      if (out.startTangent) out.startTangent = z0(out.startTangent);
      if (out.endTangent) out.endTangent = z0(out.endTangent);
      if (out.normal) out.normal = { x: 0, y: 0, z: 1 };
      if (out.helix) return { skip: '나선' };
      break;
    case 'XLINE':
    case 'RAY': {
      out.base = z0(out.base);
      const l = Math.hypot(out.direction.x, out.direction.y);
      if (!(l > 1e-12)) return { skip: 'Z 방향 구성선' };
      out.direction = { x: out.direction.x / l, y: out.direction.y / l, z: 0 };
      break;
    }
    case 'TEXT':
    case 'ATTDEF':
    case 'ATTRIB':
      out.insert = z0(out.insert);
      if (out.alignPoint) out.alignPoint = z0(out.alignPoint);
      break;
    case 'MTEXT':
      out.insert = z0(out.insert);
      if (out.direction) out.direction = { ...out.direction, z: 0 };
      break;
    case 'INSERT':
      out.insert = z0(out.insert);
      for (const a of out.attribs) {
        a.insert = z0(a.insert);
        if (a.alignPoint) a.alignPoint = z0(a.alignPoint);
        delete a.extrusion;
        delete a.thickness;
      }
      break;
    case 'DIMENSION':
      out.defPoint = z0(out.defPoint);
      out.textMid = z0(out.textMid);
      out.defPoint2 = z0(out.defPoint2);
      out.defPoint3 = z0(out.defPoint3);
      out.defPoint4 = z0(out.defPoint4);
      out.defPoint5 = z0(out.defPoint5);
      out.insertPoint = z0opt(out.insertPoint);
      if (!out.insertPoint) delete out.insertPoint;
      if (out.arc) out.arc = { ...out.arc, center: z0(out.arc.center), start: z0(out.arc.start), end: z0(out.arc.end), leader1: z0opt(out.arc.leader1), leader2: z0opt(out.arc.leader2) };
      break;
    case 'LEADER':
      out.vertices = out.vertices.map(z0);
      break;
    case 'HATCH':
    case 'MPOLYGON':
      out.elevation = 0;
      break;
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      out.points = out.points.map(z0) as typeof out.points;
      break;
    case 'IMAGE':
    case 'WIPEOUT':
      if (Math.abs(out.uVector.z) > 1e-12 || Math.abs(out.vVector.z) > 1e-12) return { skip: 'XY 평면 밖으로 기운 이미지' };
      out.insert = z0(out.insert);
      break;
    case 'MLINE':
      out.startPoint = z0(out.startPoint);
      for (const v of out.vertices) v.position = z0(v.position);
      break;
    case 'TOLERANCE':
    case 'SHAPE':
    case 'ACAD_TABLE':
      out.insert = z0(out.insert);
      break;
    case 'ARCALIGNEDTEXT':
      out.center = z0(out.center);
      break;
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY':
      out.insert = z0(out.insert);
      break;
    default:
      return { skip: '이 종류의 객체' };
  }
  // 바뀐 것이 없으면 null
  if (src === e && flatNumbers(e) && JSON.stringify(stripRaw(out)) === JSON.stringify(stripRaw(e))) return null;
  return { entity: out };
}

function stripRaw(e: Entity): unknown {
  const c = { ...e } as Partial<Entity>;
  delete c.dwgRaw;
  return c;
}
