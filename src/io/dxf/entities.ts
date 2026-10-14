/** DXF 객체(ENTITIES·BLOCKS 구역) 해석 */
import type {
  AcisEntity,
  ArcEntity,
  AttribEntity,
  CircleEntity,
  DimensionEntity,
  EllipseEntity,
  Entity,
  EntityBase,
  FaceEntity,
  HatchEdge,
  HatchEntity,
  HatchGradient,
  HatchPath,
  HatchPatternLine,
  ImageEntity,
  InsertEntity,
  LeaderEntity,
  LineEntity,
  LwPolylineEntity,
  LwVertex,
  MLeaderEntity,
  MLeaderLeader,
  MLeaderLine,
  MLineEntity,
  MLineVertex,
  MTextColumns,
  MTextEntity,
  MeshEntity,
  Ole2FrameEntity,
  PointEntity,
  PolyVertex,
  PolylineEntity,
  ShapeEntity,
  SplineEntity,
  TableEntity,
  TextEntity,
  TextHAlign,
  TextVAlign,
  ToleranceEntity,
  UnderlayEntity,
  UnknownEntity,
  Vec2,
  Vec3,
  ViewportEntity,
  XLineEntity,
} from '../../core/model';
import { entityDefaults } from '../../core/model';
import { rawColorToCad } from '../../core/color';
import type { DxfRecord, TagValue } from './records';
import { DEG, Tags, handle, hexToBytes, int, name, num, parseColor, parseDimOverrides, parseXData, str } from './tagutil';

export interface EntityContext {
  version: string;
  unsupported: Map<string, number>;
}

interface Common {
  base: EntityBase;
  tags: Tags;
  graphics?: Uint8Array;
}

/** 공통 속성(AcDbEntity까지)과 객체 고유 태그를 나눈다. */
function splitCommon(rec: DxfRecord): Common {
  const codes = rec.codes;
  const values = rec.values;
  const base: EntityBase = { type: rec.type, ...entityDefaults() };
  const sc: number[] = [];
  const sv: TagValue[] = [];
  const ss: string[] = [];
  let sub = '';
  let aci: number | undefined;
  let rgb: number | undefined;
  let colorName: string | undefined;
  let gfx: string[] | null = null;
  let i = 0;
  for (; i < codes.length; i++) {
    const c = codes[i]!;
    const v = values[i]!;
    if (c >= 1000) break;
    if (c === 100) {
      sub = str(v).trim();
      continue;
    }
    if (c === 101) {
      sub = 'Embedded:' + str(v).trim();
      continue;
    }
    if (c === 102) {
      const s = str(v).trim();
      if (s.startsWith('{')) {
        const app = s.slice(1).toUpperCase();
        let j = i + 1;
        for (; j < codes.length; j++) {
          if (codes[j] === 102) break;
          if (app === 'ACAD_REACTORS' && codes[j] === 330) (base.reactors ??= []).push(handle(values[j]));
          else if (app === 'ACAD_XDICTIONARY' && codes[j] === 360) base.xdict = handle(values[j]);
        }
        i = j;
      }
      continue;
    }
    if (sub === '' || sub === 'AcDbEntity') {
      switch (c) {
        case 5:
          base.handle = handle(v);
          continue;
        case 330:
          if (base.owner === undefined) base.owner = handle(v);
          continue;
        case 8:
          base.layer = name(v);
          continue;
        case 6:
          base.linetype = name(v);
          continue;
        case 62:
          aci = int(v);
          continue;
        case 420:
          rgb = int(v);
          continue;
        case 430:
          colorName = str(v);
          continue;
        case 370:
          base.lineweight = int(v);
          continue;
        case 48:
          base.ltscale = num(v);
          continue;
        case 60:
          if (int(v) === 1) base.invisible = true;
          continue;
        case 67:
          if (int(v) === 1) base.paperSpace = true;
          continue;
        case 440: {
          const t = int(v) >>> 0;
          base.transparency = t & 0x01000000 ? -2 : t & 0x02000000 ? t & 0xff : -1;
          continue;
        }
        case 390:
          base.plotStyle = handle(v);
          continue;
        case 410:
        case 347:
        case 348:
        case 284:
          continue;
        case 92:
        case 160:
          if (sub === 'AcDbEntity') {
            gfx = [];
            continue;
          }
          break;
        case 310:
          if (sub === 'AcDbEntity' && gfx) {
            gfx.push(str(v));
            continue;
          }
          break;
      }
    }
    sc.push(c);
    sv.push(v);
    ss.push(sub);
  }
  if (i < codes.length) base.xdata = parseXData(codes, values, i);
  if (aci !== undefined && aci < 0) aci = -aci; // 일부 프로그램이 음수 색을 쓴다
  base.color = parseColor(aci, rgb, colorName);
  const tags = new Tags(sc, sv, ss);
  const out: Common = { base, tags };
  if (gfx && gfx.length) out.graphics = hexToBytes(gfx.join(''));
  if (base.xdata) {
    const url = base.xdata.find((x) => x.app.toUpperCase() === 'PE_URL');
    if (url) {
      const strs = url.items.filter((it) => it.code === 1000).map((it) => String(it.value));
      if (strs[0]) base.hyperlink = { url: strs[0], description: strs[1], location: strs[2] };
    }
  }
  return out;
}

const Z = (): Vec3 => ({ x: 0, y: 0, z: 1 });

function ocs(t: Tags, e: EntityBase): void {
  if (t.has(210)) {
    const x = t.point(210);
    if (Math.abs(x.x) > 1e-12 || Math.abs(x.y) > 1e-12 || Math.abs(x.z - 1) > 1e-12) e.extrusion = x;
  }
  const th = t.num(39, 0);
  if (th) e.thickness = th;
}

function p2(p: Vec3): Vec2 {
  return { x: p.x, y: p.y };
}

// ---------------------------------------------------------------------------

function line(c: Common): LineEntity {
  const t = c.tags;
  const e = { ...c.base, type: 'LINE', start: t.point(10), end: t.point(11) } as LineEntity;
  ocs(t, e);
  return e;
}

function point(c: Common): PointEntity {
  const t = c.tags;
  const e = { ...c.base, type: 'POINT', position: t.point(10), angle: t.num(50) * DEG } as PointEntity;
  ocs(t, e);
  return e;
}

function circle(c: Common): CircleEntity {
  const t = c.tags;
  const e = { ...c.base, type: 'CIRCLE', center: t.point(10), radius: t.num(40) } as CircleEntity;
  ocs(t, e);
  return e;
}

function arc(c: Common): ArcEntity {
  const t = c.tags;
  const e = {
    ...c.base,
    type: 'ARC',
    center: t.point(10),
    radius: t.num(40),
    startAngle: t.num(50) * DEG,
    endAngle: t.num(51) * DEG,
  } as ArcEntity;
  ocs(t, e);
  return e;
}

function ellipse(c: Common): EllipseEntity {
  const t = c.tags;
  const e = {
    ...c.base,
    type: 'ELLIPSE',
    center: t.point(10),
    majorAxis: t.point(11),
    ratio: t.num(40, 1),
    startParam: t.num(41, 0),
    endParam: t.num(42, Math.PI * 2),
  } as EllipseEntity;
  ocs(t, e);
  return e;
}

function lwpolyline(c: Common): LwPolylineEntity {
  const t = c.tags;
  const vertices: LwVertex[] = [];
  let cur: LwVertex | null = null;
  let flags = 0;
  let constantWidth = 0;
  let elevation = 0;
  for (let i = 0; i < t.length; i++) {
    const code = t.codes[i]!;
    const v = t.values[i];
    switch (code) {
      case 10:
        cur = { x: num(v), y: 0, bulge: 0, startWidth: 0, endWidth: 0 };
        vertices.push(cur);
        break;
      case 20:
        if (cur) cur.y = num(v);
        break;
      case 40:
        if (cur) cur.startWidth = num(v);
        break;
      case 41:
        if (cur) cur.endWidth = num(v);
        break;
      case 42:
        if (cur) cur.bulge = num(v);
        break;
      case 70:
        flags = int(v);
        break;
      case 43:
        constantWidth = num(v);
        break;
      case 38:
        elevation = num(v);
        break;
    }
  }
  const e = {
    ...c.base,
    type: 'LWPOLYLINE',
    vertices,
    closed: (flags & 1) !== 0,
    plinegen: (flags & 128) !== 0,
    constantWidth,
    elevation,
  } as LwPolylineEntity;
  ocs(t, e);
  return e;
}

function polylineHead(c: Common): PolylineEntity {
  const t = c.tags;
  const flags = t.int(70);
  const kind = flags & 64 ? 'polyface' : flags & 16 ? 'mesh' : flags & 8 ? '3d' : '2d';
  const e = {
    ...c.base,
    type: 'POLYLINE',
    kind,
    flags,
    vertices: [],
    elevation: t.point(10).z,
    defaultStartWidth: t.num(40),
    defaultEndWidth: t.num(41),
    mCount: t.int(71),
    nCount: t.int(72),
    mDensity: t.int(73),
    nDensity: t.int(74),
    smoothType: t.int(75),
  } as PolylineEntity;
  ocs(t, e);
  return e;
}

function vertex(c: Common): PolyVertex {
  const t = c.tags;
  const flags = t.int(70);
  const v: PolyVertex = {
    location: t.point(10),
    bulge: t.num(42),
    startWidth: t.num(40),
    endWidth: t.num(41),
    flags,
  };
  if (flags & 2 && t.has(50)) v.tangent = t.num(50) * DEG;
  if (t.has(71)) {
    const idx = [t.int(71), t.int(72), t.int(73), t.int(74)];
    while (idx.length && idx[idx.length - 1] === 0) idx.pop();
    v.faceIndices = idx;
  }
  return v;
}

function spline(c: Common): SplineEntity {
  const t = c.tags;
  const knots: number[] = [];
  const weights: number[] = [];
  const controlPoints: Vec3[] = [];
  const fitPoints: Vec3[] = [];
  let helix: SplineEntity['helix'];
  for (let i = 0; i < t.length; i++) {
    const code = t.codes[i]!;
    const sub = t.subs[i];
    if (sub === 'AcDbHelix') continue;
    if (code === 40) knots.push(num(t.values[i]));
    else if (code === 41) weights.push(num(t.values[i]));
    else if (code === 10) controlPoints.push(t.pointAt(i));
    else if (code === 11) fitPoints.push(t.pointAt(i));
  }
  if (t.find(10, 'AcDbHelix') >= 0) {
    helix = {
      axisBase: t.point(10, undefined, 'AcDbHelix'),
      start: t.point(11, undefined, 'AcDbHelix'),
      axis: t.point(12, Z(), 'AcDbHelix'),
      radius: t.num(40, 0, 'AcDbHelix'),
      turns: t.num(41, 1, 'AcDbHelix'),
      turnHeight: t.num(42, 0, 'AcDbHelix'),
      ccw: t.int(290, 1, 'AcDbHelix') === 1,
      constrain: t.int(280, 0, 'AcDbHelix'),
    };
  }
  const flags = t.int(70);
  const e = {
    ...c.base,
    type: 'SPLINE',
    flags,
    degree: t.int(71, 3),
    knots,
    controlPoints,
    fitPoints,
    knotTolerance: t.num(42, 1e-10),
    controlTolerance: t.num(43, 1e-10),
    fitTolerance: t.num(44, 1e-10),
  } as SplineEntity;
  if (weights.length && weights.length === controlPoints.length && weights.some((w) => w !== 1)) e.weights = weights;
  if (t.has(12)) e.startTangent = t.point(12, undefined, 'AcDbSpline');
  if (t.has(13)) e.endTangent = t.point(13, undefined, 'AcDbSpline');
  if (t.has(210)) e.normal = t.point(210);
  if (helix) e.helix = helix;
  return e;
}

function xline(c: Common, type: 'XLINE' | 'RAY'): XLineEntity {
  const t = c.tags;
  return { ...c.base, type, base: t.point(10), direction: t.point(11, { x: 1, y: 0, z: 0 }) } as XLineEntity;
}

function textCommon(c: Common, type: TextEntity['type']): TextEntity {
  const t = c.tags;
  const halign = t.int(72) as TextHAlign;
  // TEXT의 세로 정렬은 73, ATTRIB·ATTDEF는 74
  const valign = (type === 'TEXT' ? t.int(73) : t.int(74)) as TextVAlign;
  const e = {
    ...c.base,
    type,
    insert: t.point(10),
    height: t.num(40),
    text: t.str(1),
    rotation: t.num(50) * DEG,
    widthFactor: t.num(41, 1) || 1,
    oblique: t.num(51) * DEG,
    style: name(t.str(7, 'Standard')),
    generation: t.int(71),
    halign,
    valign,
  } as TextEntity;
  if ((halign !== 0 || valign !== 0) && t.hasPoint(11)) e.alignPoint = t.point(11);
  ocs(t, e);
  return e;
}

function attrib(c: Common, type: 'ATTRIB' | 'ATTDEF'): AttribEntity {
  // 여러 줄 속성(R2018)의 MTEXT 부분은 따로 떼어 낸다.
  const t = c.tags;
  const embedIdx = t.subs.findIndex((s) => s.startsWith('Embedded:'));
  let mainTags = t;
  let mtext: MTextEntity | undefined;
  if (embedIdx >= 0) {
    mainTags = new Tags(t.codes.slice(0, embedIdx), t.values.slice(0, embedIdx), t.subs.slice(0, embedIdx));
    const mt = new Tags(t.codes.slice(embedIdx), t.values.slice(embedIdx), t.subs.slice(embedIdx).map(() => 'AcDbMText'));
    mtext = mtextFrom({ base: { ...c.base, type: 'MTEXT' }, tags: mt });
  }
  const base = textCommon({ base: c.base, tags: mainTags }, type) as unknown as AttribEntity;
  const tagSub = type === 'ATTRIB' ? 'AcDbAttribute' : 'AcDbAttributeDefinition';
  const hasSub = mainTags.subs.includes(tagSub);
  base.type = type;
  base.tag = name(mainTags.str(2, '', hasSub ? tagSub : undefined));
  base.attFlags = mainTags.int(70, 0, hasSub ? tagSub : undefined);
  if (type === 'ATTDEF') base.prompt = mainTags.str(3, '', hasSub ? tagSub : undefined);
  if (mainTags.int(280, 0, hasSub ? tagSub : undefined) === 1 && hasSub) base.lockPosition = true;
  if (mtext) base.mtext = mtext;
  return base;
}

function mtextFrom(c: Common): MTextEntity {
  const t = c.tags;
  let text = '';
  const embedStart = t.subs.findIndex((s) => s.startsWith('Embedded:'));
  const end = embedStart >= 0 ? embedStart : t.length;
  let rotation = 0;
  let direction: Vec3 | undefined;
  let bgFlags = 0;
  let bgAci: number | undefined;
  let bgRgb: number | undefined;
  const e = {
    ...c.base,
    type: 'MTEXT',
    insert: { x: 0, y: 0, z: 0 },
    height: 0,
    width: 0,
    attachment: 1,
    drawingDirection: 1,
    text: '',
    style: 'Standard',
    rotation: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    backgroundScale: 1.5,
  } as MTextEntity;
  for (let i = 0; i < end; i++) {
    const code = t.codes[i]!;
    const v = t.values[i];
    switch (code) {
      case 1:
      case 3:
        text += str(v);
        break;
      case 10:
        e.insert = t.pointAt(i);
        break;
      case 11:
        direction = t.pointAt(i);
        break;
      case 40:
        e.height = num(v);
        break;
      case 41:
        e.width = num(v);
        break;
      case 46:
        e.rectHeight = num(v);
        break;
      case 71:
        e.attachment = int(v) || 1;
        break;
      case 72:
        e.drawingDirection = int(v) || 1;
        break;
      case 7:
        e.style = name(v);
        break;
      case 50:
        rotation = num(v) * DEG;
        break;
      case 73:
        e.lineSpacingStyle = int(v) || 1;
        break;
      case 44:
        e.lineSpacingFactor = num(v) || 1;
        break;
      case 90:
        bgFlags = int(v);
        break;
      case 63:
        bgAci = int(v);
        break;
      case 421:
        bgRgb = int(v);
        break;
      case 45:
        e.backgroundScale = num(v) || 1.5;
        break;
      case 210: {
        const x = t.pointAt(i);
        if (Math.abs(x.x) > 1e-12 || Math.abs(x.y) > 1e-12 || Math.abs(x.z - 1) > 1e-12) e.extrusion = x;
        break;
      }
    }
  }
  e.text = text;
  e.rotation = rotation;
  if (direction && (direction.x !== 0 || direction.y !== 0)) e.direction = direction;
  e.backgroundFlags = bgFlags;
  if (bgFlags & 1) e.backgroundColor = parseColor(bgAci, bgRgb, undefined);
  if (embedStart >= 0) {
    const cols: MTextColumns = { type: 0, count: 0, width: 0, gutter: 0, autoHeight: false, flowReversed: false, heights: [] };
    let totalWidth = 0;
    for (let i = embedStart; i < t.length; i++) {
      const code = t.codes[i]!;
      const v = t.values[i];
      switch (code) {
        case 41:
          if (!e.rectHeight) e.rectHeight = num(v);
          break;
        case 42:
          totalWidth = num(v);
          break;
        case 44:
          cols.width = num(v);
          break;
        case 45:
          cols.gutter = num(v);
          break;
        case 71:
          cols.type = int(v);
          break;
        case 72:
          cols.count = int(v);
          break;
        case 73:
          cols.autoHeight = int(v) === 1;
          break;
        case 74:
          cols.flowReversed = int(v) === 1;
          break;
        case 46:
          cols.heights.push(num(v));
          break;
      }
    }
    if (cols.count === 0 && cols.width > 0 && totalWidth > 0) {
      cols.count = Math.round((totalWidth + cols.gutter) / (cols.width + cols.gutter));
    }
    if (cols.type > 0) e.columns = cols;
  }
  return e;
}

function insert(c: Common): InsertEntity {
  const t = c.tags;
  const e = {
    ...c.base,
    type: 'INSERT',
    block: name(t.str(2)),
    insert: t.point(10),
    scale: { x: t.num(41, 1), y: t.num(42, 1), z: t.num(43, 1) },
    rotation: t.num(50) * DEG,
    columnCount: Math.max(1, t.int(70, 1)),
    rowCount: Math.max(1, t.int(71, 1)),
    columnSpacing: t.num(44),
    rowSpacing: t.num(45),
    attribs: [],
  } as InsertEntity;
  ocs(t, e);
  return e;
}

function dimension(c: Common, subtype?: DimensionEntity['subtype']): DimensionEntity {
  const t = c.tags;
  const d = 'AcDbDimension';
  const hasSubs = t.subs.includes(d);
  const s = hasSubs ? d : undefined;
  const e = {
    ...c.base,
    type: 'DIMENSION',
    block: name(t.str(2, '', s)),
    dimStyle: name(t.str(3, 'Standard', s)),
    dimType: t.int(70, 0, s),
    defPoint: t.point(10, undefined, s),
    textMid: t.point(11, undefined, s),
    defPoint2: t.point(13),
    defPoint3: t.point(14),
    defPoint4: t.point(15),
    defPoint5: t.point(16),
    text: t.str(1, '', s),
    measurement: t.has(42) ? t.num(42, NaN, s) : NaN,
    rotation: t.num(50) * DEG,
    obliqueAngle: t.num(52) * DEG,
    textRotation: t.num(53, 0, s) * DEG,
    horizontalDirection: t.num(51, 0, s) * DEG,
    attachment: t.int(71, 5, s),
    leaderLength: t.num(40, 0),
    lineSpacingStyle: t.int(72, 1, s),
    lineSpacingFactor: t.num(41, 1, s),
  } as DimensionEntity;
  if (t.hasPoint(12, s)) e.insertPoint = t.point(12, undefined, s);
  if (subtype) e.subtype = subtype;
  if (subtype === 'ARC_DIMENSION') {
    const a = 'AcDbArcDimension';
    e.arc = {
      center: t.point(15, undefined, a),
      start: t.point(13, undefined, a),
      end: t.point(14, undefined, a),
      startAngle: t.num(40, 0, a),
      endAngle: t.num(41, 0, a),
      partial: t.int(70, 0, a) === 1,
    };
    if (t.hasPoint(16, a)) e.arc.leader1 = t.point(16, undefined, a);
    if (t.hasPoint(17, a)) e.arc.leader2 = t.point(17, undefined, a);
  }
  ocs(t, e);
  const ov = parseDimOverrides(c.base.xdata);
  if (ov) e.overrides = ov;
  return e;
}

function leader(c: Common): LeaderEntity {
  const t = c.tags;
  const vertices: Vec3[] = [];
  for (let i = 0; i < t.length; i++) if (t.codes[i] === 10) vertices.push(t.pointAt(i));
  const e = {
    ...c.base,
    type: 'LEADER',
    dimStyle: name(t.str(3, 'Standard')),
    vertices,
    arrowHead: t.int(71, 1) === 1,
    pathType: t.int(72),
    creation: t.int(73, 3),
    hooklineDirection: t.int(74),
    hookline: t.int(75) === 1,
    textHeight: t.num(40),
    textWidth: t.num(41),
  } as LeaderEntity;
  if (t.has(340)) e.annotation = handle(t.str(340));
  if (t.has(210)) e.normal = t.point(210);
  if (t.has(211)) e.horizontalDirection = t.point(211);
  if (t.has(212)) e.blockOffset = t.point(212);
  if (t.has(213)) e.annotationOffset = t.point(213);
  const ov = parseDimOverrides(c.base.xdata);
  if (ov) e.overrides = ov;
  return e;
}

function mleader(c: Common): MLeaderEntity {
  const t = c.tags;
  const v3 = (i: number) => t.pointAt(i);
  const e = {
    ...c.base,
    type: 'MULTILEADER',
    leaderLineType: 1,
    leaderLineColor: { aci: 0 },
    leaderLineWeight: -2,
    landing: true,
    dogleg: true,
    doglegLength: 8,
    arrowSize: 4,
    contentType: 2,
    textColor: { aci: 0 },
    textFrame: false,
    blockColor: { aci: 0 },
    blockScale: { x: 1, y: 1, z: 1 },
    blockRotation: 0,
    blockConnection: 0,
    scale: 1,
    context: {
      scale: 1,
      contentBase: { x: 0, y: 0, z: 0 },
      textHeight: 4,
      arrowSize: 4,
      landingGap: 2,
      leaders: [],
      basePoint: { x: 0, y: 0, z: 0 },
      baseDirection: { x: 1, y: 0, z: 0 },
      baseVertical: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
  } as MLeaderEntity;
  const ctx = e.context;
  type State = 'main' | 'context' | 'leader' | 'line';
  let state: State = 'main';
  let content: 'none' | 'text' | 'block' = 'none';
  let ld: MLeaderLeader | null = null;
  let ln: MLeaderLine | null = null;
  let breakStart: Vec3 | null = null;
  const attrs: NonNullable<MLeaderEntity['blockAttributes']> = [];
  let curAttr: (typeof attrs)[number] | null = null;
  for (let i = 0; i < t.length; i++) {
    const code = t.codes[i]!;
    const v = t.values[i];
    const s = typeof v === 'string' ? v.trim() : '';
    if (code === 300 && s === 'CONTEXT_DATA{') {
      state = 'context';
      continue;
    }
    if (state === 'context') {
      if (code === 301) {
        state = 'main';
        continue;
      }
      if (code === 302 && s === 'LEADER{') {
        ld = { doglegLength: 0, hasLastPoint: false, hasDogleg: false, lines: [], index: 0, attachmentDirection: 0 };
        ctx.leaders.push(ld);
        state = 'leader';
        content = 'none';
        continue;
      }
      if (content === 'text' && ctx.text) {
        const x = ctx.text;
        switch (code) {
          case 304:
            x.text = str(v);
            continue;
          case 11:
            x.normal = v3(i);
            continue;
          case 340:
            x.styleHandle = handle(v);
            continue;
          case 12:
            x.location = v3(i);
            continue;
          case 13:
            x.direction = v3(i);
            continue;
          case 42:
            x.rotation = num(v);
            continue;
          case 43:
            x.width = num(v);
            continue;
          case 44:
            x.height = num(v);
            continue;
          case 45:
            x.lineSpacingFactor = num(v) || 1;
            continue;
          case 170:
            x.lineSpacingStyle = int(v);
            continue;
          case 90:
            x.color = rawColorToCad(int(v));
            continue;
          case 171:
            x.attachment = int(v);
            continue;
          case 172:
            x.flowDirection = int(v);
            continue;
          case 91:
            x.backgroundColor = rawColorToCad(int(v));
            continue;
          case 141:
            x.backgroundScale = num(v);
            continue;
          case 292:
            x.backgroundFill = int(v) === 1;
            continue;
          case 92:
          case 291:
          case 173:
          case 293:
          case 142:
          case 143:
          case 294:
          case 144:
          case 295:
            continue;
          default:
            content = 'none';
        }
      } else if (content === 'block' && ctx.block) {
        const b = ctx.block;
        switch (code) {
          case 341:
            b.blockHandle = handle(v);
            continue;
          case 14:
            b.normal = v3(i);
            continue;
          case 15:
            b.location = v3(i);
            continue;
          case 16:
            b.scale = v3(i);
            continue;
          case 46:
            b.rotation = num(v);
            continue;
          case 93:
            b.color = rawColorToCad(int(v));
            continue;
          case 47:
            (b.matrix ??= []).push(num(v));
            continue;
          default:
            content = 'none';
        }
      }
      switch (code) {
        case 40:
          ctx.scale = num(v) || 1;
          break;
        case 10:
          ctx.contentBase = v3(i);
          break;
        case 41:
          ctx.textHeight = num(v);
          break;
        case 140:
          ctx.arrowSize = num(v);
          break;
        case 145:
          ctx.landingGap = num(v);
          break;
        case 110:
          ctx.basePoint = v3(i);
          break;
        case 111:
          ctx.baseDirection = v3(i);
          break;
        case 112:
          ctx.baseVertical = v3(i);
          break;
        case 290:
          if (int(v) === 1) {
            content = 'text';
            ctx.text = {
              text: '',
              location: { x: 0, y: 0, z: 0 },
              direction: { x: 1, y: 0, z: 0 },
              normal: { x: 0, y: 0, z: 1 },
              rotation: 0,
              width: 0,
              height: 0,
              lineSpacingFactor: 1,
              lineSpacingStyle: 1,
              color: { aci: 0 },
              attachment: 1,
              flowDirection: 1,
              backgroundFill: false,
              backgroundScale: 1.5,
            };
          }
          break;
        case 296:
          if (int(v) === 1) {
            content = 'block';
            ctx.block = {
              location: { x: 0, y: 0, z: 0 },
              normal: { x: 0, y: 0, z: 1 },
              scale: { x: 1, y: 1, z: 1 },
              rotation: 0,
              color: { aci: 0 },
            };
          }
          break;
      }
      continue;
    }
    if (state === 'leader' && ld) {
      if (code === 303) {
        state = 'context';
        ld = null;
        continue;
      }
      if (code === 304 && s === 'LEADER_LINE{') {
        ln = { vertices: [], index: 0 };
        ld.lines.push(ln);
        state = 'line';
        breakStart = null;
        continue;
      }
      switch (code) {
        case 290:
          ld.hasLastPoint = int(v) === 1;
          break;
        case 291:
          ld.hasDogleg = int(v) === 1;
          break;
        case 10:
          ld.lastLeaderPoint = v3(i);
          break;
        case 11:
          ld.doglegVector = v3(i);
          break;
        case 40:
          ld.doglegLength = num(v);
          break;
        case 90:
          ld.index = int(v);
          break;
        case 271:
          ld.attachmentDirection = int(v);
          break;
      }
      continue;
    }
    if (state === 'line' && ln) {
      if (code === 305) {
        state = 'leader';
        ln = null;
        continue;
      }
      switch (code) {
        case 10:
          ln.vertices.push(v3(i));
          break;
        case 11:
          breakStart = v3(i);
          break;
        case 12:
          if (breakStart) (ln.breaks ??= []).push({ start: breakStart, end: v3(i) });
          breakStart = null;
          break;
        case 91:
          ln.index = int(v);
          break;
        case 92:
          ln.color = rawColorToCad(int(v));
          break;
      }
      continue;
    }
    // 객체 본문
    switch (code) {
      case 340:
        e.styleHandle = handle(v);
        break;
      case 170:
        e.leaderLineType = int(v);
        break;
      case 91:
        e.leaderLineColor = rawColorToCad(int(v));
        break;
      case 341:
        e.leaderLineTypeHandle = handle(v);
        break;
      case 171:
        e.leaderLineWeight = int(v);
        break;
      case 290:
        e.landing = int(v) === 1;
        break;
      case 291:
        e.dogleg = int(v) === 1;
        break;
      case 41:
        e.doglegLength = num(v);
        break;
      case 342:
        e.arrowHeadHandle = handle(v);
        break;
      case 42:
        e.arrowSize = num(v);
        break;
      case 172:
        e.contentType = int(v);
        break;
      case 343:
        e.textStyleHandle = handle(v);
        break;
      case 92:
        e.textColor = rawColorToCad(int(v));
        break;
      case 292:
        e.textFrame = int(v) === 1;
        break;
      case 344:
        e.blockHandle = handle(v);
        break;
      case 93:
        e.blockColor = rawColorToCad(int(v));
        break;
      case 10:
        e.blockScale = v3(i);
        break;
      case 43:
        e.blockRotation = num(v);
        break;
      case 176:
        e.blockConnection = int(v);
        break;
      case 45:
        e.scale = num(v) || 1;
        break;
      case 330:
        curAttr = { attdefHandle: handle(v), index: 0, width: 0, text: '' };
        attrs.push(curAttr);
        break;
      case 177:
        if (curAttr) curAttr.index = int(v);
        break;
      case 44:
        if (curAttr) curAttr.width = num(v);
        break;
      case 302:
        if (curAttr) curAttr.text = str(v);
        break;
    }
  }
  if (attrs.length) e.blockAttributes = attrs;
  return e;
}

/** HATCH·MPOLYGON 경계와 무늬 */
function hatch(c: Common, type: 'HATCH' | 'MPOLYGON', version: string): HatchEntity {
  // R2010부터 스플라인 경계에 맞춤점(97)이 붙는다. 그 전의 97은 경로의 원본 경계 수다.
  const splineFit = version >= 'AC1024';
  const t = c.tags;
  const codes = t.codes;
  const values = t.values;
  const n = codes.length;
  const e = {
    ...c.base,
    type,
    patternName: '',
    solid: false,
    associative: false,
    hatchStyle: 0,
    patternType: 1,
    patternAngle: 0,
    patternScale: 1,
    patternDouble: false,
    elevation: 0,
    paths: [],
    patternLines: [],
    pixelSize: 0,
    seedPoints: [],
  } as HatchEntity;
  let i = 0;
  const at = (k: number) => values[k];
  const p2At = (k: number): Vec2 => ({ x: num(values[k]), y: codes[k + 1] === codes[k]! + 10 ? num(values[k + 1]) : 0 });
  // 경로 이전 머리 태그
  for (; i < n; i++) {
    const code = codes[i]!;
    if (code === 91) break;
    switch (code) {
      case 10:
        e.elevation = t.pointAt(i).z;
        break;
      case 2:
        e.patternName = str(at(i)).trim();
        break;
      case 70:
        e.solid = int(at(i)) === 1;
        break;
      case 71:
        e.associative = int(at(i)) === 1;
        break;
      case 63:
        if (type === 'MPOLYGON') e.fillColor = { aci: int(at(i)) };
        break;
      case 210: {
        const x = t.pointAt(i);
        if (Math.abs(x.x) > 1e-12 || Math.abs(x.y) > 1e-12 || Math.abs(x.z - 1) > 1e-12) e.extrusion = x;
        break;
      }
    }
  }
  if (i < n && codes[i] === 91) {
    const count = int(at(i));
    i++;
    for (let p = 0; p < count && i < n; p++) {
      while (i < n && codes[i] !== 92) i++;
      if (i >= n) break;
      const flags = int(at(i));
      i++;
      const path: HatchPath = { flags };
      if (flags & 2) {
        let hasBulge = false;
        let closed = true;
        let nv = 0;
        for (; i < n && codes[i] !== 10; i++) {
          if (codes[i] === 72) hasBulge = int(at(i)) === 1;
          else if (codes[i] === 73) closed = int(at(i)) === 1;
          else if (codes[i] === 93) nv = int(at(i));
          else break;
        }
        const vs: { x: number; y: number; bulge: number }[] = [];
        for (let k = 0; k < nv && i < n; k++) {
          if (codes[i] !== 10) break;
          const q = p2At(i);
          i += codes[i + 1] === 20 ? 2 : 1;
          let bulge = 0;
          if (hasBulge && codes[i] === 42) {
            bulge = num(at(i));
            i++;
          }
          vs.push({ x: q.x, y: q.y, bulge });
        }
        path.polyline = { closed, vertices: vs };
      } else {
        let ne = 0;
        if (codes[i] === 93) {
          ne = int(at(i));
          i++;
        }
        const edges: HatchEdge[] = [];
        for (let k = 0; k < ne && i < n; k++) {
          if (codes[i] !== 72) break;
          const et = int(at(i));
          i++;
          if (et === 1) {
            const s = codes[i] === 10 ? p2At(i) : { x: 0, y: 0 };
            i += 2;
            const en = codes[i] === 11 ? p2At(i) : { x: 0, y: 0 };
            i += 2;
            edges.push({ type: 'line', start: s, end: en });
          } else if (et === 2) {
            let center = { x: 0, y: 0 };
            let radius = 0;
            let sa = 0;
            let ea = 360;
            let ccw = true;
            for (; i < n; i++) {
              const cc = codes[i]!;
              if (cc === 10) {
                center = p2At(i);
                i++;
              } else if (cc === 40) radius = num(at(i));
              else if (cc === 50) sa = num(at(i));
              else if (cc === 51) ea = num(at(i));
              else if (cc === 73) {
                ccw = int(at(i)) === 1;
                i++;
                break;
              } else break;
            }
            const [s0, e0] = ccw ? [sa, ea] : [360 - ea, 360 - sa];
            edges.push({ type: 'arc', center, radius, startAngle: s0 * DEG, endAngle: e0 * DEG, ccw });
          } else if (et === 3) {
            let center = { x: 0, y: 0 };
            let major = { x: 1, y: 0 };
            let ratio = 1;
            let sa = 0;
            let ea = 360;
            let ccw = true;
            for (; i < n; i++) {
              const cc = codes[i]!;
              if (cc === 10) {
                center = p2At(i);
                i++;
              } else if (cc === 11) {
                major = p2At(i);
                i++;
              } else if (cc === 40) ratio = num(at(i));
              else if (cc === 50) sa = num(at(i));
              else if (cc === 51) ea = num(at(i));
              else if (cc === 73) {
                ccw = int(at(i)) === 1;
                i++;
                break;
              } else break;
            }
            const [s0, e0] = ccw ? [sa, ea] : [360 - ea, 360 - sa];
            edges.push({ type: 'ellipse', center, majorAxis: major, ratio, startAngle: s0 * DEG, endAngle: e0 * DEG, ccw });
          } else if (et === 4) {
            const sp = {
              type: 'spline' as const,
              degree: 3,
              rational: false,
              periodic: false,
              knots: [] as number[],
              controlPoints: [] as Vec2[],
              weights: [] as number[],
              fitPoints: [] as Vec2[],
            } as Extract<HatchEdge, { type: 'spline' }>;
            let nk = 0;
            let nc = 0;
            let nf = 0;
            let fitSeen = false;
            for (; i < n; i++) {
              const cc = codes[i]!;
              if (cc === 94) sp.degree = int(at(i));
              else if (cc === 73) sp.rational = int(at(i)) === 1;
              else if (cc === 74) sp.periodic = int(at(i)) === 1;
              else if (cc === 95) nk = int(at(i));
              else if (cc === 96) nc = int(at(i));
              else if (cc === 40 && sp.knots.length < nk) sp.knots.push(num(at(i)));
              else if (cc === 10 && sp.controlPoints.length < nc) {
                sp.controlPoints.push(p2At(i));
                i++;
              } else if (cc === 42) sp.weights!.push(num(at(i)));
              else if (cc === 97 && splineFit && !fitSeen) {
                nf = int(at(i));
                fitSeen = true;
              }
              else if (cc === 11 && sp.fitPoints!.length < nf) {
                sp.fitPoints!.push(p2At(i));
                i++;
              } else if (cc === 12) {
                sp.startTangent = p2At(i);
                i++;
              } else if (cc === 13) {
                sp.endTangent = p2At(i);
                i++;
              } else break;
            }
            if (!sp.weights!.length) delete sp.weights;
            if (!sp.fitPoints!.length) delete sp.fitPoints;
            edges.push(sp);
          } else {
            break;
          }
        }
        path.edges = edges;
      }
      // 연관 경계 객체
      if (codes[i] === 97) {
        const ns = int(at(i));
        i++;
        const src: string[] = [];
        for (let k = 0; k < ns && i < n && codes[i] === 330; k++, i++) src.push(handle(at(i)));
        if (src.length) path.sources = src;
      }
      e.paths.push(path);
    }
  }
  // 무늬·씨앗점·그라데이션
  let lineCur: HatchPatternLine | null = null;
  let gradient: HatchGradient | undefined;
  let gradColorIdx = 0;
  let seedCount = 0;
  for (; i < n; i++) {
    const code = codes[i]!;
    const v = at(i);
    switch (code) {
      case 75:
        e.hatchStyle = int(v);
        break;
      case 76:
        e.patternType = int(v);
        break;
      case 52:
        e.patternAngle = num(v) * DEG;
        break;
      case 41:
        e.patternScale = num(v) || 1;
        break;
      case 77:
        e.patternDouble = int(v) === 1;
        break;
      case 53:
        lineCur = { angle: num(v) * DEG, base: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, dashes: [] };
        e.patternLines.push(lineCur);
        break;
      case 43:
        if (lineCur) lineCur.base.x = num(v);
        break;
      case 44:
        if (lineCur) lineCur.base.y = num(v);
        break;
      case 45:
        if (lineCur) lineCur.offset.x = num(v);
        break;
      case 46:
        if (lineCur) lineCur.offset.y = num(v);
        break;
      case 49:
        if (lineCur) lineCur.dashes.push(num(v));
        break;
      case 47:
        e.pixelSize = num(v);
        break;
      case 98:
        seedCount = int(v);
        break;
      case 10:
        if (e.seedPoints.length < seedCount) {
          e.seedPoints.push(p2At(i));
          i++;
        }
        break;
      case 450:
        gradient = {
          enabled: int(v) === 1,
          name: '',
          color1: { aci: 5 },
          color2: { aci: 7 },
          singleColor: false,
          tint: 0,
          angle: 0,
          shift: 0,
        };
        break;
      case 452:
        if (gradient) gradient.singleColor = int(v) === 1;
        break;
      case 460:
        if (gradient) gradient.angle = num(v);
        break;
      case 461:
        if (gradient) gradient.shift = num(v);
        break;
      case 462:
        if (gradient) gradient.tint = num(v);
        break;
      case 470:
        if (gradient) gradient.name = str(v).trim();
        break;
      case 63:
        if (gradient) {
          const col = { aci: int(v) };
          if (gradColorIdx === 0) gradient.color1 = col;
          else gradient.color2 = col;
        }
        break;
      case 421:
        if (gradient) {
          const target = gradColorIdx === 0 ? gradient.color1 : gradient.color2;
          target.rgb = int(v) & 0xffffff;
          gradColorIdx++;
        }
        break;
    }
  }
  if (gradient && gradient.enabled) e.gradient = gradient;
  if (!e.patternName && e.solid) e.patternName = 'SOLID';
  return e;
}

function face(c: Common, type: FaceEntity['type']): FaceEntity {
  const t = c.tags;
  const p0 = t.point(10);
  const p1 = t.point(11);
  const p2v = t.point(12);
  const p3v = t.hasPoint(13) ? t.point(13) : { ...p2v };
  const e = { ...c.base, type, points: [p0, p1, p2v, p3v], invisibleEdges: type === '3DFACE' ? t.int(70) : 0 } as FaceEntity;
  ocs(t, e);
  return e;
}

function image(c: Common, type: 'IMAGE' | 'WIPEOUT'): ImageEntity {
  const t = c.tags;
  const clip: Vec2[] = [];
  for (let i = 0; i < t.length; i++) if (t.codes[i] === 14) clip.push(t.point2At(i));
  const e = {
    ...c.base,
    type,
    insert: t.point(10),
    uVector: t.point(11, { x: 1, y: 0, z: 0 }),
    vVector: t.point(12, { x: 0, y: 1, z: 0 }),
    imageSize: p2(t.point(13, { x: 1, y: 1, z: 0 })),
    displayFlags: t.int(70, 7),
    clipping: t.int(280) === 1,
    brightness: t.int(281, 50),
    contrast: t.int(282, 50),
    fade: t.int(283, 0),
    clipBoundaryType: t.int(71, 1),
    clipBoundary: clip,
  } as ImageEntity;
  if (t.has(340)) e.imageDef = handle(t.str(340));
  if (t.int(290) === 1) e.clipInverted = true;
  return e;
}

function viewport(c: Common): ViewportEntity {
  const t = c.tags;
  const frozen: string[] = [];
  for (let i = 0; i < t.length; i++) if (t.codes[i] === 331 || t.codes[i] === 341) frozen.push(handle(t.values[i]));
  const e = {
    ...c.base,
    type: 'VIEWPORT',
    center: t.point(10),
    width: t.num(40),
    height: t.num(41),
    status: t.int(68),
    id: t.int(69),
    viewCenter: p2(t.point(12)),
    snapBase: p2(t.point(13)),
    snapSpacing: p2(t.point(14)),
    gridSpacing: p2(t.point(15)),
    viewDirection: t.point(16, Z()),
    viewTarget: t.point(17),
    lensLength: t.num(42, 50),
    frontClip: t.num(43),
    backClip: t.num(44),
    viewHeight: t.num(45),
    snapAngle: t.num(50) * DEG,
    twistAngle: t.num(51) * DEG,
    circleSides: t.int(72, 1000),
    flags: t.int(90),
    frozenLayers: frozen,
    renderMode: t.int(281),
    ucsPerViewport: t.int(71) === 1,
  } as ViewportEntity;
  if (t.has(340)) e.clipBoundary = handle(t.str(340));
  if (t.has(1)) e.styleSheet = t.str(1);
  if (t.has(110)) {
    e.ucsOrigin = t.point(110);
    e.ucsXAxis = t.point(111);
    e.ucsYAxis = t.point(112);
  }
  return e;
}

function mline(c: Common): MLineEntity {
  const t = c.tags;
  const codes = t.codes;
  const e = {
    ...c.base,
    type: 'MLINE',
    styleName: name(t.str(2, 'Standard')),
    scale: t.num(40, 1),
    justification: t.int(70),
    flags: t.int(71),
    startPoint: t.point(10),
    normal: t.point(210, Z()),
    vertices: [],
    elementCount: t.int(73),
  } as MLineEntity;
  if (t.has(340)) e.styleHandle = handle(t.str(340));
  let cur: MLineVertex | null = null;
  let elem: { params: number[]; fillParams: number[] } | null = null;
  let mode: 'p' | 'f' | null = null;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 11) {
      cur = { position: t.pointAt(i), direction: { x: 1, y: 0, z: 0 }, miter: { x: 0, y: 1, z: 0 }, elements: [] };
      e.vertices.push(cur);
    } else if (!cur) continue;
    else if (code === 12) cur.direction = t.pointAt(i);
    else if (code === 13) cur.miter = t.pointAt(i);
    else if (code === 74) {
      elem = { params: [], fillParams: [] };
      cur.elements.push(elem);
      mode = 'p';
    } else if (code === 41 && elem && mode === 'p') elem.params.push(num(t.values[i]));
    else if (code === 75) mode = 'f';
    else if (code === 42 && elem && mode === 'f') elem.fillParams.push(num(t.values[i]));
  }
  return e;
}

function tolerance(c: Common): ToleranceEntity {
  const t = c.tags;
  return {
    ...c.base,
    type: 'TOLERANCE',
    dimStyle: name(t.str(3, 'Standard')),
    insert: t.point(10),
    text: t.str(1),
    direction: t.point(11, { x: 1, y: 0, z: 0 }),
    ...(t.has(210) ? { extrusion: t.point(210) } : {}),
  } as ToleranceEntity;
}

function shape(c: Common): ShapeEntity {
  const t = c.tags;
  const e = {
    ...c.base,
    type: 'SHAPE',
    insert: t.point(10),
    size: t.num(40, 1),
    name: name(t.str(2)),
    rotation: t.num(50) * DEG,
    widthFactor: t.num(41, 1) || 1,
    oblique: t.num(51) * DEG,
  } as ShapeEntity;
  ocs(t, e);
  return e;
}

function table(c: Common): TableEntity {
  const t = c.tags;
  const rowHeights = t.all(141).map(num);
  const columnWidths = t.all(142).map(num);
  const e = {
    ...c.base,
    type: 'ACAD_TABLE',
    block: name(t.str(2)),
    insert: t.point(10),
    direction: t.point(11, { x: 1, y: 0, z: 0 }),
    scale: { x: t.num(41, 1), y: t.num(42, 1), z: t.num(43, 1) },
    rotation: t.num(50) * DEG,
    rows: t.int(91),
    columns: t.int(92),
    rowHeights,
    columnWidths,
  } as TableEntity;
  if (t.has(342)) e.tableStyle = handle(t.str(342));
  const cells = t.all(1).map((v) => ({ text: str(v) }));
  if (cells.length) e.cells = cells;
  ocs(t, e);
  return e;
}

function mesh(c: Common): MeshEntity {
  const t = c.tags;
  const codes = t.codes;
  const vertices: Vec3[] = [];
  const faces: number[][] = [];
  const edges: [number, number][] = [];
  let i = 0;
  const n = codes.length;
  let subdivision = 0;
  for (; i < n; i++) {
    const code = codes[i]!;
    if (code === 91) subdivision = int(t.values[i]);
    else if (code === 92) {
      const nv = int(t.values[i]);
      i++;
      for (let k = 0; k < nv && i < n; k++) {
        if (codes[i] !== 10) break;
        vertices.push(t.pointAt(i));
        i += 3;
      }
      i--;
    } else if (code === 93) {
      const size = int(t.values[i]);
      const list: number[] = [];
      i++;
      for (let k = 0; k < size && i < n && codes[i] === 90; k++, i++) list.push(int(t.values[i]));
      i--;
      for (let k = 0; k < list.length; ) {
        const cnt = list[k]!;
        faces.push(list.slice(k + 1, k + 1 + cnt));
        k += cnt + 1;
      }
    } else if (code === 94) {
      const ne = int(t.values[i]);
      i++;
      for (let k = 0; k < ne && i + 1 < n && codes[i] === 90; k++, i += 2) edges.push([int(t.values[i]), int(t.values[i + 1])]);
      i--;
    }
  }
  return { ...c.base, type: 'MESH', vertices, faces, edges, subdivision } as MeshEntity;
}

function underlay(c: Common, type: UnderlayEntity['type']): UnderlayEntity {
  const t = c.tags;
  const clip: Vec2[] = [];
  for (let i = 0; i < t.length; i++) if (t.codes[i] === 11) clip.push(t.point2At(i));
  const e = {
    ...c.base,
    type,
    insert: t.point(10),
    scale: { x: t.num(41, 1), y: t.num(42, 1), z: t.num(43, 1) },
    rotation: t.num(50) * DEG,
    flags: t.int(280, 2),
    contrast: t.int(281, 100),
    fade: t.int(282, 0),
    clipBoundary: clip,
  } as UnderlayEntity;
  if (t.has(340)) e.definition = handle(t.str(340));
  ocs(t, e);
  return e;
}

function ole(c: Common, type: 'OLE2FRAME' | 'OLEFRAME'): Ole2FrameEntity {
  const t = c.tags;
  return { ...c.base, type, upperLeft: t.point(10), lowerRight: t.point(11) } as Ole2FrameEntity;
}

function proxy(c: Common): UnknownEntity {
  const t = c.tags;
  // AcDbProxyEntity: 92 그림 크기 뒤의 310 묶음이 프록시 그림이다.
  let gfx: string[] | null = null;
  for (let i = 0; i < t.length; i++) {
    const code = t.codes[i]!;
    if (code === 92 || code === 160) gfx = [];
    else if (code === 93) break;
    else if (code === 310 && gfx) gfx.push(str(t.values[i]));
  }
  const e = { ...c.base, type: 'UNKNOWN', originalType: 'ACAD_PROXY_ENTITY' } as UnknownEntity;
  if (gfx && gfx.length) e.graphics = hexToBytes(gfx.join(''));
  else if (c.graphics) e.graphics = c.graphics;
  return e;
}

const ACIS_TYPES = new Set([
  'REGION',
  '3DSOLID',
  'BODY',
  'SURFACE',
  'PLANESURFACE',
  'EXTRUDEDSURFACE',
  'LOFTEDSURFACE',
  'REVOLVEDSURFACE',
  'SWEPTSURFACE',
  'NURBSURFACE',
]);

/** 레코드 하나를 객체로. POLYLINE의 정점·INSERT의 속성은 호출한 쪽이 붙인다. */
export function parseEntity(rec: DxfRecord, ctx: EntityContext): Entity | null {
  const c = splitCommon(rec);
  switch (rec.type) {
    case 'LINE':
      return line(c);
    case 'POINT':
      return point(c);
    case 'CIRCLE':
      return circle(c);
    case 'ARC':
      return arc(c);
    case 'ELLIPSE':
      return ellipse(c);
    case 'LWPOLYLINE':
      return lwpolyline(c);
    case 'POLYLINE':
      return polylineHead(c);
    case 'SPLINE':
    case 'HELIX':
      return spline(c);
    case 'XLINE':
    case 'RAY':
      return xline(c, rec.type);
    case 'TEXT':
      return textCommon(c, 'TEXT');
    case 'ATTRIB':
    case 'ATTDEF':
      return attrib(c, rec.type);
    case 'MTEXT':
      return mtextFrom(c);
    case 'INSERT':
      return insert(c);
    case 'DIMENSION':
      return dimension(c);
    case 'ARC_DIMENSION':
    case 'LARGE_RADIAL_DIMENSION':
      return dimension(c, rec.type);
    case 'LEADER':
      return leader(c);
    case 'MULTILEADER':
    case 'MLEADER':
      return mleader(c);
    case 'HATCH':
    case 'MPOLYGON':
      return hatch(c, rec.type, ctx.version);
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      return face(c, rec.type);
    case 'IMAGE':
    case 'WIPEOUT':
      return image(c, rec.type);
    case 'VIEWPORT':
      return viewport(c);
    case 'MLINE':
      return mline(c);
    case 'TOLERANCE':
      return tolerance(c);
    case 'SHAPE':
      return shape(c);
    case 'ACAD_TABLE':
      return table(c);
    case 'MESH':
      return mesh(c);
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY':
      return underlay(c, rec.type);
    case 'OLE2FRAME':
    case 'OLEFRAME':
      return ole(c, rec.type);
    case 'ACAD_PROXY_ENTITY':
      return proxy(c);
    default:
      if (ACIS_TYPES.has(rec.type)) return { ...c.base, type: rec.type } as AcisEntity;
      ctx.unsupported.set(rec.type, (ctx.unsupported.get(rec.type) ?? 0) + 1);
      return {
        ...c.base,
        type: 'UNKNOWN',
        originalType: rec.type,
        ...(c.graphics ? { graphics: c.graphics } : {}),
      } as UnknownEntity;
  }
}

/** VERTEX 레코드 → 정점 */
export function parseVertex(rec: DxfRecord): PolyVertex {
  return vertex(splitCommon(rec));
}
