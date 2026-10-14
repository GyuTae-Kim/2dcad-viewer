/**
 * 쓰기 버전이 지원하지 않는 객체를 그 버전에 있는 객체로 바꾼다.
 * 바꾼 첫 객체는 원래 핸들을 이어받는다(그룹·정렬표가 계속 가리킬 수 있게).
 * - R12: LWPOLYLINE·ELLIPSE·SPLINE → POLYLINE, MTEXT → TEXT, LEADER → POLYLINE, 표·호 치수 → INSERT, 나머지 R2000+ 객체는 뺀다.
 * - R2007 이전: MULTILEADER → 선·MTEXT·INSERT로 분해. R2004 이전: ACAD_TABLE·ARC_DIMENSION·LARGE_RADIAL_DIMENSION → INSERT.
 * - R2010 이전: MESH → 폴리페이스 POLYLINE. R2007 이전: HELIX → SPLINE. 밑그림은 지원하는 버전에서만.
 * - OLE 객체(자료 없음), 원본 태그가 없는 모르는 객체, 버전 계열이 다른 ACIS 객체는 뺀다.
 */
import type {
  AcisEntity,
  Entity,
  EntityBase,
  InsertEntity,
  MLeaderEntity,
  MTextEntity,
  PolyVertex,
  PolylineEntity,
  RawTag,
  SplineEntity,
  TextEntity,
  Vec3,
} from '../../core/model';
import { ellipsePoints, nurbsPoints, interpolateFitPoints, TAU } from '../../geom/curves';
import { rawTagsValid } from './tagwriter';
import type { WriteContext } from './wcontext';

const ACIS = new Set(['REGION', '3DSOLID', 'BODY', 'SURFACE', 'PLANESURFACE', 'EXTRUDEDSURFACE', 'LOFTEDSURFACE', 'REVOLVEDSURFACE', 'SWEPTSURFACE', 'NURBSURFACE']);

function base(e: Entity, handle = ''): EntityBase {
  const b: EntityBase = {
    type: '',
    handle,
    layer: e.layer,
    linetype: e.linetype,
    color: e.color,
    lineweight: e.lineweight,
    ltscale: e.ltscale,
    transparency: e.transparency,
  };
  if (e.invisible) b.invisible = true;
  if (e.extrusion) b.extrusion = e.extrusion;
  if (e.thickness) b.thickness = e.thickness;
  return b;
}

function polyline(e: Entity, kind: PolylineEntity['kind'], vertices: PolyVertex[], flags: number, handle: string, elevation = 0): PolylineEntity {
  return {
    ...base(e, handle),
    type: 'POLYLINE',
    kind,
    flags,
    vertices,
    elevation,
    defaultStartWidth: 0,
    defaultEndWidth: 0,
    mCount: 0,
    nCount: 0,
    mDensity: 0,
    nDensity: 0,
    smoothType: 0,
  };
}

function v(p: { x: number; y: number; z?: number }, flags = 0, bulge = 0): PolyVertex {
  return { location: { x: p.x, y: p.y, z: p.z ?? 0 }, bulge, startWidth: 0, endWidth: 0, flags };
}

/** 점 배열 [x, y, z?…] → 정점 */
function vertsFrom(pts: number[], stride: number, flags: number): PolyVertex[] {
  const out: PolyVertex[] = [];
  for (let i = 0; i + stride - 1 < pts.length; i += stride) out.push(v({ x: pts[i]!, y: pts[i + 1]!, z: stride === 3 ? pts[i + 2]! : 0 }, flags));
  return out;
}

function tolOf(size: number): number {
  return Math.max(size * 1e-3, 1e-9);
}

/** MTEXT 서식 코드를 걷어 낸 줄 목록 */
export function mtextPlainLines(src: string): string[] {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\' || i + 1 >= src.length) {
      out += ch;
      continue;
    }
    const c = src[i + 1]!;
    if (c === 'P') {
      out += '\n';
      i++;
    } else if (c === '~') {
      out += ' ';
      i++;
    } else if (c === '\\' || c === '{' || c === '}') {
      out += c;
      i++;
    } else if ('LlOoKkX'.includes(c)) {
      i++;
    } else if ('ACcFfHhQTWp'.includes(c)) {
      const j = src.indexOf(';', i + 2);
      i = j < 0 ? src.length : j;
    } else if (c === 'S') {
      const j = src.indexOf(';', i + 2);
      const body = src.slice(i + 2, j < 0 ? src.length : j);
      out += body.replace(/[\^#]/g, '/');
      i = j < 0 ? src.length : j;
    } else {
      out += ch;
    }
  }
  return out.split('\n');
}

function explodeMLeader(e: MLeaderEntity, ctx: WriteContext): Entity[] {
  const out: Entity[] = [];
  const c = e.context;
  let first = true;
  const take = () => {
    const h = first ? e.handle : '';
    first = false;
    return h;
  };
  if (e.leaderLineType !== 0) {
    for (const ld of c.leaders) {
      for (const ln of ld.lines) {
        const pts: Vec3[] = [...ln.vertices];
        if (ld.lastLeaderPoint) pts.push(ld.lastLeaderPoint);
        if (pts.length >= 2) out.push(polyline(e, '3d', pts.map((p) => v(p, 32)), 8, take()));
      }
      if (e.dogleg && ld.hasDogleg && ld.lastLeaderPoint && ld.doglegVector) {
        const p0 = ld.lastLeaderPoint;
        const d = ld.doglegVector;
        const len = ld.doglegLength || e.doglegLength;
        out.push({ ...base(e, take()), type: 'LINE', start: p0, end: { x: p0.x + d.x * len, y: p0.y + d.y * len, z: p0.z + d.z * len } } as Entity);
      }
    }
  }
  if (c.text && c.text.text) {
    const t = c.text;
    let style = 'Standard';
    const sh = t.styleHandle ?? e.textStyleHandle;
    if (sh) for (const s of ctx.styles) if (s.h === sh.toUpperCase()) style = s.rec.name;
    const m: MTextEntity = {
      ...base(e, take()),
      type: 'MTEXT',
      insert: t.location,
      height: t.height || c.textHeight,
      width: t.width,
      attachment: t.attachment || 1,
      drawingDirection: t.flowDirection || 1,
      text: t.text,
      style,
      direction: t.direction,
      rotation: 0,
      lineSpacingStyle: t.lineSpacingStyle || 1,
      lineSpacingFactor: t.lineSpacingFactor || 1,
      backgroundFlags: 0,
      backgroundScale: 1.5,
    };
    if (t.color && t.color.aci !== 0) m.color = t.color;
    delete m.extrusion;
    out.push(m);
  }
  if (c.block && c.block.blockHandle) {
    const pb = ctx.blockOf(c.block.blockHandle.toUpperCase());
    if (pb) {
      const ins: InsertEntity = {
        ...base(e, take()),
        type: 'INSERT',
        block: pb.name,
        insert: c.block.location,
        scale: c.block.scale,
        rotation: c.block.rotation,
        columnCount: 1,
        rowCount: 1,
        columnSpacing: 0,
        rowSpacing: 0,
        attribs: [],
      };
      out.push(ins);
    }
  }
  return out;
}

function blockInsert(e: Entity, block: string, insert: Vec3, scale: Vec3 = { x: 1, y: 1, z: 1 }, rotation = 0): InsertEntity {
  return {
    ...base(e, e.handle),
    type: 'INSERT',
    block,
    insert,
    scale,
    rotation,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  };
}

function splineToPolyline(e: SplineEntity): PolylineEntity {
  let ctrl = e.controlPoints;
  let knots = e.knots;
  let degree = e.degree;
  let weights = e.weights;
  if (ctrl.length < 2 && e.fitPoints.length >= 2) {
    const r = interpolateFitPoints(e.fitPoints, e.startTangent, e.endTangent);
    ctrl = r.ctrl;
    knots = r.knots;
    degree = r.degree;
    weights = undefined;
  }
  let size = 0;
  for (const p of ctrl) size = Math.max(size, Math.abs(p.x), Math.abs(p.y));
  const pts = nurbsPoints(degree, knots, ctrl, weights, tolOf(size || 1));
  const flat = ctrl.every((p) => Math.abs(p.z - (ctrl[0]?.z ?? 0)) < 1e-9) && !e.normal;
  if (flat) {
    const z = ctrl[0]?.z ?? 0;
    const vs = vertsFrom(pts, 3, 0).map((q) => ({ ...q, location: { ...q.location, z } }));
    return polyline(e, '2d', vs, e.flags & 1 ? 1 : 0, e.handle, z);
  }
  return polyline(e, '3d', vertsFrom(pts, 3, 32), 8 | (e.flags & 1 ? 1 : 0), e.handle);
}

/** null = 그대로 쓴다, [] = 뺀다, 그 밖 = 바꾼 객체(바꾼 객체도 다시 그 버전에 맞춘다) */
export function convertEntity(e: Entity, ctx: WriteContext): Entity[] | null {
  const first = convertOnce(e, ctx);
  if (!first) return null;
  const out: Entity[] = [];
  for (const x of first) {
    const again = x === e ? null : convertOnce(x, ctx);
    if (again) out.push(...again);
    else out.push(x);
  }
  return out;
}

/** 쓸 수 없을 만큼 모양이 잘못된 객체 */
function invalid(e: Entity): boolean {
  switch (e.type) {
    case 'ELLIPSE':
      return Math.hypot(e.majorAxis.x, e.majorAxis.y, e.majorAxis.z) < 1e-12 || !(e.ratio > 0);
    case 'LEADER':
      return e.vertices.length < 2;
    case 'SPLINE':
      return e.degree < 1 || (e.controlPoints.length === 0 && e.fitPoints.length === 0);
    case 'MESH':
      return !e.vertices.length || !e.faces.length;
  }
  return false;
}

function convertOnce(e: Entity, ctx: WriteContext): Entity[] | null {
  const ver = ctx.ver;
  const r12 = ver <= 1009;
  if (invalid(e)) {
    ctx.warn('entity.invalid_dropped', '모양이 잘못된 객체를 쓰지 않았습니다.', e.type);
    return [];
  }
  if (ACIS.has(e.type)) {
    const a = e as Entity & { raw?: unknown[]; rawVersion?: string };
    const fam = (n: number) => (n <= 1024 ? 'sat' : 'sab');
    if (!r12 && a.raw && a.rawVersion && fam(Number(a.rawVersion.slice(2))) === fam(ver) && rawTagsValid(a.raw as RawTag[])) return null;
    const wires = (e as AcisEntity).wires?.filter((w) => w.length >= 2) ?? [];
    if (wires.length) {
      // 와이어가 있으면 보이는 모양은 남긴다(3D 폴리선).
      ctx.warn('entity.acis_as_wires', 'ACIS 자료를 쓸 수 없어 ACIS 객체를 와이어(3D 폴리선)로 썼습니다.', e.type);
      return wires.map((w, i) => polyline(e, '3d', w.map((p) => v(p, 32)), 8, i === 0 ? e.handle : ''));
    }
    ctx.warn('entity.acis_dropped', 'ACIS 자료가 없거나 이 버전으로 바꿀 수 없어 ACIS 객체(REGION·3DSOLID 등)를 쓰지 않았습니다.', e.type);
    return [];
  }
  switch (e.type) {
    case 'UNKNOWN':
      if (!r12 && e.raw && rawTagsValid(e.raw)) return null;
      ctx.warn('entity.unknown_dropped', '내용을 알 수 없는 객체를 쓰지 않았습니다.', e.originalType);
      return [];
    case 'OLE2FRAME':
    case 'OLEFRAME':
      ctx.warn('entity.ole_dropped', 'OLE 자료가 없어 OLE 객체를 쓰지 않았습니다.');
      return [];
    case 'SHAPE':
      if (!e.name) {
        ctx.warn('entity.shape_dropped', '쉐이프 이름을 몰라 SHAPE를 쓰지 않았습니다.');
        return [];
      }
      return null;
    case 'IMAGE':
      if (r12 || !ctx.hasObjectOfType(e.imageDef, ['IMAGEDEF'])) {
        ctx.warn('entity.image_dropped', 'IMAGEDEF가 없거나 R12라 IMAGE를 쓰지 않았습니다.');
        return [];
      }
      return null;
    case 'WIPEOUT':
      if (r12) {
        ctx.warn('r12.unsupported', 'R12에 없는 객체를 쓰지 않았습니다.', e.type);
        return [];
      }
      return null;
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY': {
      const min = e.type === 'PDFUNDERLAY' ? 1024 : 1021;
      const defType = e.type.replace('UNDERLAY', 'DEFINITION');
      if (ver < min || !ctx.hasObjectOfType(e.definition, [defType])) {
        ctx.warn('entity.underlay_dropped', '이 버전에 없거나 정의가 없는 밑그림을 쓰지 않았습니다.', e.type);
        return [];
      }
      return null;
    }
    case 'MULTILEADER':
      if (ver < 1021) {
        ctx.warn('entity.mleader_exploded', '이 버전에 없는 MULTILEADER를 선·문자·블록으로 분해했습니다.');
        return explodeMLeader(e, ctx);
      }
      return null;
    case 'ACAD_TABLE':
      if (ver < 1018) {
        if (!e.block) {
          ctx.warn('entity.table_dropped', '이 버전에 없는 표(ACAD_TABLE)에 그림 블록이 없어 쓰지 않았습니다.');
          return [];
        }
        ctx.warn('entity.table_as_insert', '이 버전에 없는 표(ACAD_TABLE)를 표 그림 블록의 삽입으로 썼습니다.');
        return [blockInsert(e, e.block, e.insert, e.scale, e.rotation)];
      }
      return null;
    case 'MESH':
      if (ver < 1024) {
        if (!e.vertices.length || !e.faces.length) return [];
        ctx.warn('entity.mesh_as_polyface', '이 버전에 없는 MESH를 폴리페이스 메시로 썼습니다.');
        const vs: PolyVertex[] = e.vertices.map((p) => v(p, 192));
        for (const f of e.faces) {
          if (f.length < 3) continue;
          // 폴리페이스 면은 정점 4개까지 → 그보다 많으면 부채꼴 삼각형으로 나눈다.
          const groups: number[][] = [];
          if (f.length <= 4) groups.push(f);
          else for (let i = 1; i + 1 < f.length; i++) groups.push([f[0]!, f[i]!, f[i + 1]!]);
          for (const g of groups) {
            const fv = v({ x: 0, y: 0 }, 128);
            fv.faceIndices = g.map((k) => k + 1);
            vs.push(fv);
          }
        }
        const pl = polyline(e, 'polyface', vs, 64, e.handle);
        pl.mCount = e.vertices.length;
        pl.nCount = vs.length - e.vertices.length;
        return [pl];
      }
      return null;
    case 'SPLINE':
      if (r12) {
        ctx.warn('r12.approximated', 'R12에 없는 곡선을 폴리선으로 근사했습니다.', e.helix ? 'HELIX' : 'SPLINE');
        return [splineToPolyline(e)];
      }
      if (e.helix && ver < 1021) {
        const s: SplineEntity = { ...e };
        delete s.helix;
        return [s];
      }
      return null;
    case 'DIMENSION':
      if ((e.subtype && ver < 1018) || (r12 && e.subtype)) {
        if (!e.block) {
          ctx.warn('entity.dimension_dropped', '이 버전에 없는 치수 종류에 그림 블록이 없어 쓰지 않았습니다.', e.subtype);
          return [];
        }
        ctx.warn('entity.dimension_as_insert', '이 버전에 없는 치수 종류를 치수 그림 블록의 삽입으로 썼습니다.', e.subtype);
        return [blockInsert(e, e.block, { x: 0, y: 0, z: 0 })];
      }
      if (e.subtype === 'ARC_DIMENSION') {
        // 호 치수의 종류 값: R2013까지 5, R2018부터 8(AutoCAD와 같음)
        const t = (e.dimType & 0xfff0) | (ver >= 1032 ? 8 : 5);
        if (t !== e.dimType) return [{ ...e, dimType: t }];
      }
      return null;
  }
  if (!r12) return null;

  // R12
  switch (e.type) {
    case 'LWPOLYLINE': {
      const vs = e.vertices.map((p) => ({ ...v({ x: p.x, y: p.y, z: e.elevation }, 0, p.bulge), startWidth: p.startWidth, endWidth: p.endWidth }));
      const pl = polyline(e, '2d', vs, (e.closed ? 1 : 0) | (e.plinegen ? 128 : 0), e.handle, e.elevation);
      pl.defaultStartWidth = pl.defaultEndWidth = e.constantWidth;
      return [pl];
    }
    case 'ELLIPSE': {
      ctx.warn('r12.approximated', 'R12에 없는 곡선을 폴리선으로 근사했습니다.', 'ELLIPSE');
      const a = Math.hypot(e.majorAxis.x, e.majorAxis.y);
      const full = Math.abs(e.endParam - e.startParam - TAU) < 1e-9 || Math.abs(e.endParam - e.startParam) < 1e-12;
      const pts = ellipsePoints(e.center.x, e.center.y, e.majorAxis.x, e.majorAxis.y, e.ratio, e.startParam, e.endParam, tolOf(a));
      if (full) pts.splice(-2, 2);
      const vs = vertsFrom(pts, 2, 0).map((q) => ({ ...q, location: { ...q.location, z: e.center.z } }));
      return [polyline(e, '2d', vs, full ? 1 : 0, e.handle, e.center.z)];
    }
    case 'MTEXT': {
      const lines = mtextPlainLines(e.text);
      const dir = e.direction ? Math.atan2(e.direction.y, e.direction.x) : e.rotation;
      const step = e.height * 1.6667 * (e.lineSpacingFactor || 1);
      const out: TextEntity[] = [];
      const col = (e.attachment - 1) % 3;
      const halign = (col === 0 ? 0 : col === 1 ? 1 : 2) as TextEntity['halign'];
      lines.forEach((line, i) => {
        if (!line) return;
        const dx = Math.sin(dir) * step * i;
        const dy = -Math.cos(dir) * step * i;
        const p = { x: e.insert.x + dx, y: e.insert.y + dy - e.height, z: e.insert.z };
        const t: TextEntity = {
          ...base(e, out.length ? '' : e.handle),
          type: 'TEXT',
          insert: p,
          height: e.height,
          text: line,
          rotation: dir,
          widthFactor: 1,
          oblique: 0,
          style: e.style,
          generation: 0,
          halign,
          valign: 0,
        };
        if (halign) t.alignPoint = p;
        delete t.extrusion;
        out.push(t);
      });
      ctx.warn('r12.mtext_as_text', 'R12에 없는 MTEXT를 줄마다 TEXT로 썼습니다.');
      return out;
    }
    case 'LEADER': {
      if (e.vertices.length < 2) return [];
      ctx.warn('r12.leader_as_polyline', 'R12에 없는 LEADER를 폴리선으로 썼습니다.');
      return [polyline(e, '3d', e.vertices.map((p) => v(p, 32)), 8, e.handle)];
    }
    case 'XLINE':
    case 'RAY':
    case 'HATCH':
    case 'MPOLYGON':
    case 'TOLERANCE':
    case 'MLINE':
      ctx.warn('r12.unsupported', 'R12에 없는 객체를 쓰지 않았습니다.', e.type);
      return [];
    case 'INSERT':
    case 'POLYLINE':
      return null;
  }
  return null;
}
