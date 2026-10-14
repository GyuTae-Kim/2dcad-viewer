/** DXF OBJECTS 구역 해석 */
import type {
  CadObject,
  DictionaryObject,
  GenericObject,
  GroupObject,
  ImageDefObject,
  Layout,
  LayoutObject,
  MLeaderStyleObject,
  MLineStyleElement,
  MLineStyleObject,
  ObjectBase,
  PlotSettings,
  PlotSettingsObject,
  RawTag,
  ScaleObject,
  SortEntsTableObject,
  SpatialFilterObject,
  UnderlayDefObject,
  Vec2,
  XRecordObject,
} from '../../core/model';
import { rawColorToCad } from '../../core/color';
import { defaultLayout } from '../../core/finalize';
import type { DxfRecord } from './records';
import { DEG, Tags, handle, int, name, num, parseColor, parseXData, str } from './tagutil';

function split(rec: DxfRecord, raw?: RawTag[]): { base: ObjectBase; tags: Tags } {
  const codes = rec.codes;
  const values = rec.values;
  const base: ObjectBase = { type: rec.type, handle: '' };
  const sc: number[] = [];
  const sv: (string | number)[] = [];
  const ss: string[] = [];
  let sub = '';
  let i = 0;
  let ownerSeen = false;
  for (; i < codes.length; i++) {
    const c = codes[i]!;
    const v = values[i]!;
    if (c === 1001 && rec.type !== 'XRECORD') break;
    if (c === 100) {
      sub = str(v).trim();
      raw?.push({ code: c, value: v });
      continue;
    }
    if (c === 102 && sub === '') {
      const s = str(v).trim();
      if (s.startsWith('{')) {
        const app = s.slice(1).toUpperCase();
        let j = i + 1;
        const known = app === 'ACAD_REACTORS' || app === 'ACAD_XDICTIONARY';
        if (!known) raw?.push({ code: c, value: v });
        for (; j < codes.length && codes[j] !== 102; j++) {
          if (app === 'ACAD_REACTORS' && codes[j] === 330) (base.reactors ??= []).push(handle(values[j]));
          else if (app === 'ACAD_XDICTIONARY' && codes[j] === 360) base.xdict = handle(values[j]);
          else if (!known) raw?.push({ code: codes[j]!, value: values[j]! });
        }
        if (!known && j < codes.length) raw?.push({ code: 102, value: values[j]! });
        i = j;
      }
      continue;
    }
    if (sub === '') {
      if (c === 5) {
        base.handle = handle(v);
        continue;
      }
      if (c === 330 && !ownerSeen) {
        base.owner = handle(v);
        ownerSeen = true;
        continue;
      }
    }
    sc.push(c);
    sv.push(v);
    ss.push(sub);
    raw?.push({ code: c, value: v });
  }
  if (i < codes.length) base.xdata = parseXData(codes, values, i);
  return { base, tags: new Tags(sc, sv, ss) };
}

function dictionary(rec: DxfRecord): DictionaryObject {
  const { base, tags: t } = split(rec);
  const entries = new Map<string, string>();
  let key: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const code = t.codes[i]!;
    if (code === 3) key = str(t.values[i]);
    else if ((code === 350 || code === 360) && key !== null) {
      entries.set(key, handle(t.values[i]));
      key = null;
    }
  }
  const d: DictionaryObject = {
    ...base,
    type: rec.type === 'ACDBDICTIONARYWDFLT' ? 'ACDBDICTIONARYWDFLT' : 'DICTIONARY',
    entries,
    hardOwner: t.int(280) === 1,
    cloning: t.int(281, 1),
  };
  if (t.has(340)) d.defaultHandle = handle(t.str(340));
  return d;
}

function plotSettings(t: Tags): PlotSettings {
  const s = 'AcDbPlotSettings';
  const has = t.subs.includes(s);
  const sub = has ? s : undefined;
  return {
    pageSetupName: t.str(1, '', sub),
    printerName: t.str(2, '', sub),
    paperName: t.str(4, '', sub),
    paperWidth: t.num(44, 0, sub),
    paperHeight: t.num(45, 0, sub),
    margins: [t.num(40, 0, sub), t.num(41, 0, sub), t.num(42, 0, sub), t.num(43, 0, sub)],
    plotOrigin: { x: t.num(46, 0, sub), y: t.num(47, 0, sub) },
    windowMin: { x: t.num(48, 0, sub), y: t.num(49, 0, sub) },
    windowMax: { x: t.num(140, 0, sub), y: t.num(141, 0, sub) },
    scaleNumerator: t.num(142, 1, sub) || 1,
    scaleDenominator: t.num(143, 1, sub) || 1,
    flags: t.int(70, 0, sub),
    paperUnits: t.int(72, 1, sub),
    rotation: t.int(73, 0, sub),
    plotType: t.int(74, 5, sub),
    styleSheet: t.str(7, '', sub),
    standardScaleType: t.int(75, 16, sub),
  };
}

function layout(rec: DxfRecord): LayoutObject {
  const { base, tags: t } = split(rec);
  const s = 'AcDbLayout';
  const p = (c: number): Vec2 => {
    const q = t.point(c, undefined, s);
    return { x: q.x, y: q.y };
  };
  const nm = name(t.str(1, 'Layout', s));
  const l: Layout = defaultLayout(nm, '', t.int(71, 0, s));
  l.handle = base.handle;
  l.flags = t.int(70, 0, s);
  l.limitsMin = p(10);
  l.limitsMax = p(11);
  l.insertionBase = t.point(12, undefined, s);
  l.extMin = t.point(14, undefined, s);
  l.extMax = t.point(15, undefined, s);
  l.elevation = t.num(146, 0, s);
  l.ucsOrigin = t.point(13, undefined, s);
  l.ucsXAxis = t.point(16, { x: 1, y: 0, z: 0 }, s);
  l.ucsYAxis = t.point(17, { x: 0, y: 1, z: 0 }, s);
  l.blockRecord = handle(t.str(330, '', s));
  if (t.find(331, s) >= 0) l.viewport = handle(t.str(331, '', s));
  l.plot = plotSettings(t);
  return { ...base, type: 'LAYOUT', layout: l };
}

function mlineStyle(rec: DxfRecord): MLineStyleObject {
  const { base, tags: t } = split(rec);
  const elements: MLineStyleElement[] = [];
  let fillColor = { aci: 256 } as MLineStyleObject['fillColor'];
  let seenCount = false;
  let cur: MLineStyleElement | null = null;
  for (let i = 0; i < t.length; i++) {
    const code = t.codes[i]!;
    const v = t.values[i];
    if (code === 71) seenCount = true;
    else if (!seenCount && code === 62) fillColor = { aci: int(v) };
    else if (!seenCount && code === 420) fillColor = { ...fillColor, rgb: int(v) & 0xffffff };
    else if (seenCount && code === 49) {
      cur = { offset: num(v), color: { aci: 256 }, linetype: 'BYLAYER' };
      elements.push(cur);
    } else if (seenCount && code === 62 && cur) cur.color = { aci: int(v) };
    else if (seenCount && code === 420 && cur) cur.color = { ...cur.color, rgb: int(v) & 0xffffff };
    else if (seenCount && code === 6 && cur) cur.linetype = name(v);
  }
  return {
    ...base,
    type: 'MLINESTYLE',
    name: name(t.str(2, 'Standard')),
    flags: t.int(70),
    description: t.str(3),
    fillColor,
    startAngle: t.num(51, 90) * DEG,
    endAngle: t.num(52, 90) * DEG,
    elements,
  };
}

function imageDef(rec: DxfRecord): ImageDefObject {
  const { base, tags: t } = split(rec);
  const sz = t.point(10, { x: 1, y: 1, z: 0 });
  const px = t.point(11, { x: 1, y: 1, z: 0 });
  return {
    ...base,
    type: 'IMAGEDEF',
    fileName: t.str(1),
    imageSize: { x: sz.x, y: sz.y },
    pixelSize: { x: px.x, y: px.y },
    loaded: t.int(280) === 1,
    resolutionUnits: t.int(281),
  };
}

function underlayDef(rec: DxfRecord): UnderlayDefObject {
  const { base, tags: t } = split(rec);
  return { ...base, type: rec.type as UnderlayDefObject['type'], fileName: t.str(1), name: t.str(2) };
}

function sortents(rec: DxfRecord): SortEntsTableObject {
  const { base, tags: t } = split(rec);
  const entries: SortEntsTableObject['entries'] = [];
  let block = '';
  let pending: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const code = t.codes[i]!;
    if (code === 330) block = handle(t.values[i]);
    else if (code === 331) pending = handle(t.values[i]);
    else if (code === 5 && pending !== null) {
      entries.push({ entity: pending, sort: handle(t.values[i]) });
      pending = null;
    }
  }
  return { ...base, type: 'SORTENTSTABLE', blockRecord: block, entries };
}

function group(rec: DxfRecord): GroupObject {
  const { base, tags: t } = split(rec);
  return {
    ...base,
    type: 'GROUP',
    description: t.str(300),
    unnamed: t.int(70) === 1,
    selectable: t.int(71, 1) === 1,
    entities: t.all(340).map((v) => handle(v)),
  };
}

function xrecord(rec: DxfRecord): XRecordObject {
  const { base, tags: t } = split(rec);
  // AcDbXrecord 첫 280은 복제 플래그다. 자료 태그는 그 뒤부터다.
  const data = t.raw();
  let cloning = 1;
  if (data.length && data[0]!.code === 280 && t.subs[0] === 'AcDbXrecord') {
    cloning = int(data[0]!.value);
    data.shift();
  }
  return { ...base, type: 'XRECORD', cloning, data };
}

function spatialFilter(rec: DxfRecord): SpatialFilterObject {
  const { base, tags: t } = split(rec);
  const codes = t.codes;
  const boundary: Vec2[] = [];
  let i = 0;
  const n = codes.length;
  let count = 0;
  for (; i < n; i++) {
    if (codes[i] === 70) {
      count = int(t.values[i]);
      i++;
      break;
    }
  }
  for (let k = 0; k < count && i < n; k++) {
    if (codes[i] !== 10) break;
    boundary.push(t.point2At(i));
    i += codes[i + 1] === 20 ? 2 : 1;
  }
  const f: SpatialFilterObject = {
    ...base,
    type: 'SPATIAL_FILTER',
    boundary,
    normal: { x: 0, y: 0, z: 1 },
    origin: { x: 0, y: 0, z: 0 },
    displayBoundary: true,
    inverseBlockTransform: [],
    clipTransform: [],
  };
  // 72 앞 자르기 켬 → 바로 뒤 40이 거리, 73 뒤 자르기 켬 → 41, 그 뒤 40 × 24가 두 행렬이다.
  const mats: number[] = [];
  for (; i < n; i++) {
    const code = codes[i]!;
    const v = t.values[i];
    if (code === 210) f.normal = t.pointAt(i);
    else if (code === 11) f.origin = t.pointAt(i);
    else if (code === 71) f.displayBoundary = int(v) === 1;
    else if (code === 72) {
      if (int(v) === 1 && codes[i + 1] === 40) {
        f.frontClip = num(t.values[i + 1]);
        i++;
      }
    } else if (code === 41) f.backClip = num(v);
    else if (code === 40) mats.push(num(v));
  }
  f.inverseBlockTransform = mats.slice(0, 12);
  f.clipTransform = mats.slice(12, 24);
  return f;
}

function mleaderStyle(rec: DxfRecord): MLeaderStyleObject {
  const raw: RawTag[] = [];
  const { base, tags: t } = split(rec, raw);
  const s: MLeaderStyleObject = {
    ...base,
    type: 'MLEADERSTYLE',
    name: t.str(3, 'Standard'),
    contentType: t.int(170, 2),
    leaderLineType: t.int(173, 1),
    leaderLineColor: rawColorToCad(t.int(91, 0xc1000000 | 0)),
    leaderLineWeight: t.int(92, -2),
    landing: t.int(290, 1) === 1,
    doglegLength: t.num(43, 8),
    arrowSize: t.num(44, 4),
    textHeight: t.num(45, 4),
    textColor: rawColorToCad(t.int(93, 0xc1000000 | 0)),
    landingGap: t.num(42, 2),
    scale: t.num(142, 1),
  };
  if (t.has(341)) s.arrowHeadHandle = handle(t.str(341));
  if (t.has(342)) s.textStyleHandle = handle(t.str(342));
  if (t.has(343)) s.blockHandle = handle(t.str(343));
  s.raw = raw;
  return s;
}

function scale(rec: DxfRecord): ScaleObject {
  const { base, tags: t } = split(rec);
  return {
    ...base,
    type: 'SCALE',
    name: t.str(300),
    paperUnits: t.num(140, 1),
    drawingUnits: t.num(141, 1),
    unitScale: t.int(290) === 1,
  };
}

export function parseObject(rec: DxfRecord): CadObject | null {
  switch (rec.type) {
    case 'DICTIONARY':
    case 'ACDBDICTIONARYWDFLT':
      return dictionary(rec);
    case 'LAYOUT':
      return layout(rec);
    case 'PLOTSETTINGS': {
      const { base, tags } = split(rec);
      return { ...base, type: 'PLOTSETTINGS', plot: plotSettings(tags) } as PlotSettingsObject;
    }
    case 'MLINESTYLE':
      return mlineStyle(rec);
    case 'IMAGEDEF':
      return imageDef(rec);
    case 'PDFDEFINITION':
    case 'DWFDEFINITION':
    case 'DGNDEFINITION':
      return underlayDef(rec);
    case 'SORTENTSTABLE':
      return sortents(rec);
    case 'GROUP':
      return group(rec);
    case 'XRECORD':
      return xrecord(rec);
    case 'SPATIAL_FILTER':
      return spatialFilter(rec);
    case 'MLEADERSTYLE':
      return mleaderStyle(rec);
    case 'SCALE':
      return scale(rec);
    default: {
      const raw: RawTag[] = [];
      const { base } = split(rec, raw);
      return { ...base, raw } as GenericObject;
    }
  }
}

export { parseColor };
