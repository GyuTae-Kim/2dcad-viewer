/**
 * CadDocument → 비교용 요약(scripts/oracle/ezdxf_dump.py와 같은 형식).
 * DXF 리더와 DWG 리더를 같은 기준(ezdxf 요약)과 비교할 때 쓴다.
 */
import type { CadDocument, Entity, Vec3 } from '../../src/core/model';

export type Summary = Record<string, unknown>;

const r = (v: number | undefined): number | null => {
  if (v === undefined || !Number.isFinite(v)) return null;
  const x = Math.round(v * 1e6) / 1e6;
  return x === 0 ? 0 : x;
};

const p3 = (v: Vec3 | undefined): (number | null)[] => (v ? [r(v.x), r(v.y), r(v.z)] : [0, 0, 0]);

function base(e: Entity): Summary {
  const d: Summary = {
    type: e.type === 'UNKNOWN' ? e.originalType : e.type === 'SPLINE' && e.helix ? 'HELIX' : e.type,
    handle: e.handle,
    layer: e.layer,
    linetype: e.linetype,
    color: e.color.rgb !== undefined ? { aci: e.color.aci, rgb: e.color.rgb } : { aci: e.color.aci },
    lineweight: e.lineweight,
  };
  const x = e.extrusion;
  if (x && (Math.abs(x.x) > 1e-12 || Math.abs(x.y) > 1e-12 || Math.abs(x.z - 1) > 1e-12)) d.extrusion = p3(x);
  if (e.invisible) d.invisible = true;
  return d;
}

export function summarizeEntity(e: Entity): Summary {
  const d = base(e);
  switch (e.type) {
    case 'LINE':
      d.start = p3(e.start);
      d.end = p3(e.end);
      break;
    case 'POINT':
      d.position = p3(e.position);
      break;
    case 'CIRCLE':
      d.center = p3(e.center);
      d.radius = r(e.radius);
      break;
    case 'ARC':
      d.center = p3(e.center);
      d.radius = r(e.radius);
      d.startAngle = r(e.startAngle);
      d.endAngle = r(e.endAngle);
      break;
    case 'ELLIPSE':
      d.center = p3(e.center);
      d.majorAxis = p3(e.majorAxis);
      d.ratio = r(e.ratio);
      d.startParam = r(e.startParam);
      d.endParam = r(e.endParam);
      break;
    case 'LWPOLYLINE':
      d.closed = e.closed;
      d.vertices = e.vertices.map((v) => [r(v.x), r(v.y), r(v.bulge), r(v.startWidth), r(v.endWidth)]);
      d.constantWidth = r(e.constantWidth);
      d.elevation = r(e.elevation);
      break;
    case 'POLYLINE':
      d.flags = e.flags;
      d.vertices = e.vertices.map((v) => p3(v.location));
      break;
    case 'SPLINE':
      d.degree = e.degree;
      d.flags = e.flags;
      d.knots = e.knots.length;
      d.controlPoints = e.controlPoints.length;
      d.fitPoints = e.fitPoints.length;
      break;
    case 'XLINE':
    case 'RAY':
      d.base = p3(e.base);
      d.direction = p3(e.direction);
      break;
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF':
      d.text = e.text;
      d.insert = p3(e.insert);
      if (e.alignPoint) d.alignPoint = p3(e.alignPoint);
      d.height = r(e.height);
      d.rotation = r(e.rotation);
      d.widthFactor = r(e.widthFactor);
      d.style = e.style;
      d.halign = e.halign;
      d.valign = e.valign;
      if (e.type !== 'TEXT') d.tag = (e as { tag?: string }).tag ?? '';
      break;
    case 'MTEXT':
      d.text = e.text;
      d.insert = p3(e.insert);
      d.height = r(e.height);
      d.width = r(e.width);
      d.attachment = e.attachment;
      d.style = e.style;
      break;
    case 'INSERT':
      d.block = e.block;
      d.insert = p3(e.insert);
      d.scale = p3(e.scale);
      d.rotation = r(e.rotation);
      d.attribs = e.attribs.map((a) => a.tag);
      break;
    case 'DIMENSION':
      d.block = e.block;
      d.dimType = e.dimType;
      d.text = e.text;
      d.defPoint = p3(e.defPoint);
      break;
    case 'HATCH':
      d.patternName = e.patternName;
      d.solid = e.solid;
      d.paths = e.paths.length;
      d.patternLines = e.patternLines.length;
      break;
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      d.points = e.points.map(p3);
      break;
    case 'VIEWPORT':
      d.center = p3(e.center);
      d.width = r(e.width);
      d.height = r(e.height);
      d.viewHeight = r(e.viewHeight);
      break;
    case 'MULTILEADER':
      d.leaders = e.context.leaders.length;
      break;
    default:
      break;
  }
  return d;
}

export function summarizeDocument(doc: CadDocument): Summary {
  const layers = [...doc.layers.values()]
    .map((l) => ({
      name: l.name,
      color: l.color.aci,
      off: l.off,
      frozen: l.frozen,
      locked: l.locked,
      linetype: l.linetype,
      lineweight: l.lineweight,
    }))
    .sort((a, b) => (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : 1));
  const blocks: Record<string, Summary[]> = {};
  for (const [key, b] of doc.blocks) blocks[key] = b.entities.map(summarizeEntity);
  return {
    version: doc.version,
    codepage: doc.header.get('$DWGCODEPAGE') ?? '',
    insunits: doc.header.get('$INSUNITS') ?? 0,
    layers,
    linetypes: [...doc.linetypes.values()].map((l) => l.name).sort(),
    textStyles: [...doc.textStyles.values()].map((s) => s.name).filter(Boolean).sort(),
    dimStyles: [...doc.dimStyles.values()].map((s) => s.name).sort(),
    layouts: doc.layouts.map((l) => ({ name: l.name, block: l.blockName, tabOrder: l.tabOrder })),
    blocks,
  };
}
