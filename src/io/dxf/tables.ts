/** DXF TABLES 구역 해석 */
import type {
  BlockRecord,
  CadDocument,
  DimStyle,
  Layer,
  Linetype,
  LinetypeElement,
  TableRecordBase,
  TextStyle,
  UcsRecord,
  VPortRecord,
  ViewRecord,
  XData,
} from '../../core/model';
import { tableKey } from '../../core/model';
import { DIM_VAR_CODES } from '../../core/dimvars';
import type { DxfRecord } from './records';
import { DEG, Tags, findXData, handle, int, name, num, parseXData, str } from './tagutil';

/** 표 레코드의 공통 부분과 나머지 태그 */
function split(rec: DxfRecord): { base: TableRecordBase; tags: Tags } {
  const codes = rec.codes;
  const values = rec.values;
  const base: TableRecordBase = { name: '', handle: '', flags: 0 };
  const sc: number[] = [];
  const sv: (string | number)[] = [];
  const ss: string[] = [];
  let sub = '';
  let i = 0;
  for (; i < codes.length; i++) {
    const c = codes[i]!;
    const v = values[i]!;
    if (c >= 1000) break;
    if (c === 100) {
      sub = str(v).trim();
      continue;
    }
    if (c === 102) {
      const s = str(v).trim();
      if (s.startsWith('{')) {
        const app = s.slice(1).toUpperCase();
        let j = i + 1;
        for (; j < codes.length && codes[j] !== 102; j++) {
          if (app === 'ACAD_XDICTIONARY' && codes[j] === 360) base.xdict = handle(values[j]);
        }
        i = j;
      }
      continue;
    }
    // DIMSTYLE은 105가 핸들이다(5는 DIMBLK 이름).
    if ((c === 5 && rec.type !== 'DIMSTYLE') || (c === 105 && rec.type === 'DIMSTYLE')) {
      base.handle = handle(v);
      continue;
    }
    if (c === 2 && !base.name) {
      base.name = name(v);
      continue;
    }
    if (c === 70 && (sub === '' || sub.startsWith('AcDbSymbolTableRecord') || sub === 'AcDbSymbolTableRecord')) {
      base.flags = int(v);
      // 70은 표 고유 하위 클래스에도 있어 함께 넘긴다.
    }
    if (c === 330 && sc.length === 0 && sub === '') continue;
    sc.push(c);
    sv.push(v);
    ss.push(sub);
  }
  if (i < codes.length) base.xdata = parseXData(codes, values, i);
  return { base, tags: new Tags(sc, sv, ss) };
}

function layer(rec: DxfRecord): Layer {
  const { base, tags: t } = split(rec);
  const flags = t.int(70);
  let aci = t.int(62, 7);
  const off = aci < 0;
  if (off) aci = -aci;
  const color: Layer['color'] = { aci: aci || 7 };
  if (t.has(420)) color.rgb = t.int(420) & 0xffffff;
  if (t.has(430)) color.name = t.str(430);
  const l: Layer = {
    ...base,
    flags,
    color,
    off,
    frozen: (flags & 1) !== 0,
    locked: (flags & 4) !== 0,
    linetype: name(t.str(6, 'Continuous')),
    lineweight: t.int(370, -3),
    plot: t.int(290, 1) !== 0,
    transparency: 255,
  };
  if (t.has(390)) l.plotStyle = handle(t.str(390));
  applyLayerXData(l, base.xdata);
  return l;
}

function applyLayerXData(l: Layer, xdata: XData[] | undefined): void {
  const tr = findXData(xdata, 'AcCmTransparency');
  if (tr) {
    const it = tr.items.find((x) => x.code === 1071);
    if (it) {
      const v = Number(it.value) >>> 0;
      if (v & 0x02000000) l.transparency = v & 0xff;
    }
  }
  const desc = findXData(xdata, 'AcAecLayerStandard');
  if (desc) {
    const strs = desc.items.filter((x) => x.code === 1000).map((x) => String(x.value));
    if (strs[1]) l.description = strs[1];
  }
}

function linetype(rec: DxfRecord): Linetype {
  const { base, tags: t } = split(rec);
  const elements: LinetypeElement[] = [];
  let cur: LinetypeElement | null = null;
  for (let i = 0; i < t.length; i++) {
    const code = t.codes[i]!;
    const v = t.values[i];
    switch (code) {
      case 49:
        cur = { length: num(v), flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } };
        elements.push(cur);
        break;
      case 74:
        if (cur) cur.flags = int(v);
        break;
      case 75:
        if (cur) cur.shapeNumber = int(v);
        break;
      case 340:
        if (cur) cur.styleHandle = handle(v);
        break;
      case 46:
        if (cur) cur.scale = num(v) || 1;
        break;
      case 50:
        if (cur) cur.rotation = num(v) * DEG;
        break;
      case 44:
        if (cur) cur.offset.x = num(v);
        break;
      case 45:
        if (cur) cur.offset.y = num(v);
        break;
      case 9:
        if (cur) cur.text = str(v);
        break;
    }
  }
  let patternLength = t.num(40);
  if (!patternLength && elements.length) patternLength = elements.reduce((a, e) => a + Math.abs(e.length), 0);
  return { ...base, description: t.str(3), patternLength, elements };
}

function textStyle(rec: DxfRecord): TextStyle {
  const { base, tags: t } = split(rec);
  const s: TextStyle = {
    ...base,
    height: t.num(40),
    widthFactor: t.num(41, 1) || 1,
    oblique: t.num(50) * DEG,
    generation: t.int(71),
    lastHeight: t.num(42, 2.5),
    font: str(t.str(3)).trim(),
    bigFont: str(t.str(4)).trim(),
  };
  const acad = findXData(base.xdata, 'ACAD');
  if (acad) {
    const fam = acad.items.find((x) => x.code === 1000);
    if (fam && String(fam.value)) s.fontFamily = String(fam.value);
    const fl = acad.items.find((x) => x.code === 1071);
    if (fl) s.fontFlags = Number(fl.value);
  }
  return s;
}

function dimStyle(rec: DxfRecord, handles: Map<number, string>): DimStyle {
  const { base, tags: t } = split(rec);
  const vars: Record<string, number | string> = {};
  for (let i = 0; i < t.length; i++) {
    const code = t.codes[i]!;
    const v = t.values[i]!;
    if (code === 2 || code === 70) continue;
    const vn = DIM_VAR_CODES[code];
    if (!vn) continue;
    if (code >= 340 && code <= 347) {
      // 핸들은 나중에 이름으로 바꾼다. 같은 이름의 문자열 변수(DIMBLK 5)보다 우선한다.
      handles.set(code, handle(v));
      vars[vn] = '#' + handle(v);
    } else if (code >= 3 && code <= 7) {
      if (vars[vn] === undefined) vars[vn] = str(v);
    } else {
      vars[vn] = num(v);
    }
  }
  return { ...base, vars };
}

function vport(rec: DxfRecord): VPortRecord {
  const { base, tags: t } = split(rec);
  const p = (c: number, dx = 0, dy = 0) => {
    const q = t.point(c, { x: dx, y: dy, z: 0 });
    return { x: q.x, y: q.y };
  };
  return {
    ...base,
    lowerLeft: p(10),
    upperRight: p(11, 1, 1),
    center: p(12),
    snapBase: p(13),
    snapSpacing: p(14, 1, 1),
    gridSpacing: p(15, 1, 1),
    viewDirection: t.point(16, { x: 0, y: 0, z: 1 }),
    viewTarget: t.point(17),
    height: t.num(40, 1),
    aspect: t.num(41, 1),
    lensLength: t.num(42, 50),
    twist: t.num(51) * DEG,
    // 등각투영 설정(SNAPSTYL·SNAPISOPAIR): 0이 아니면만 둔다(없으면 0)
    ...(t.int(77) ? { snapStyle: t.int(77) } : {}),
    ...(t.int(78) ? { snapIsoPair: t.int(78) } : {}),
  };
}

function view(rec: DxfRecord): ViewRecord {
  const { base, tags: t } = split(rec);
  const c = t.point(10);
  return {
    ...base,
    center: { x: c.x, y: c.y },
    height: t.num(40, 1),
    width: t.num(41, 1),
    viewDirection: t.point(11, { x: 0, y: 0, z: 1 }),
    viewTarget: t.point(12),
    twist: t.num(50) * DEG,
  };
}

function ucs(rec: DxfRecord): UcsRecord {
  const { base, tags: t } = split(rec);
  return { ...base, origin: t.point(10), xAxis: t.point(11, { x: 1, y: 0, z: 0 }), yAxis: t.point(12, { x: 0, y: 1, z: 0 }) };
}

function blockRecord(rec: DxfRecord): BlockRecord {
  const { base, tags: t } = split(rec);
  const r: BlockRecord = {
    ...base,
    insertUnits: t.int(70),
    explodable: t.int(280, 1) !== 0,
    scalable: t.int(281, 1) !== 0,
  };
  if (t.has(340)) r.layout = handle(t.str(340));
  return r;
}

/** 표 레코드 핸들 → 이름(VIEWPORT 동결 도면층, DIMSTYLE 핸들 변수 등을 풀 때 쓴다) */
export interface TableHandles {
  layers: Map<string, string>;
  linetypes: Map<string, string>;
  styles: Map<string, string>;
  blockRecords: Map<string, string>;
  dimStyles: Map<string, string>;
  /** DIMSTYLE 이름 → (핸들 코드 → 핸들) */
  dimHandles: Map<string, Map<number, string>>;
}

export function createTableHandles(): TableHandles {
  return {
    layers: new Map(),
    linetypes: new Map(),
    styles: new Map(),
    blockRecords: new Map(),
    dimStyles: new Map(),
    dimHandles: new Map(),
  };
}

/** TABLE 레코드 다음의 항목을 ENDTAB까지 읽는다. */
export function readTableEntry(doc: CadDocument, rec: DxfRecord, th: TableHandles): void {
  switch (rec.type) {
    case 'LAYER': {
      const l = layer(rec);
      doc.layers.set(tableKey(l.name), l);
      if (l.handle) th.layers.set(l.handle, l.name);
      break;
    }
    case 'LTYPE': {
      const l = linetype(rec);
      doc.linetypes.set(tableKey(l.name), l);
      if (l.handle) th.linetypes.set(l.handle, l.name);
      break;
    }
    case 'STYLE': {
      const s = textStyle(rec);
      // 쉐이프 파일 항목(70 비트 1)은 이름이 비어 있다.
      const key = s.name ? tableKey(s.name) : `*SHAPE:${s.handle || s.font}`;
      doc.textStyles.set(key, s);
      if (s.handle) th.styles.set(s.handle, s.name || key);
      break;
    }
    case 'DIMSTYLE': {
      const hs = new Map<number, string>();
      const d = dimStyle(rec, hs);
      doc.dimStyles.set(tableKey(d.name), d);
      if (d.handle) th.dimStyles.set(d.handle, d.name);
      th.dimHandles.set(tableKey(d.name), hs);
      break;
    }
    case 'VPORT':
      doc.vports.push(vport(rec));
      break;
    case 'VIEW': {
      const v = view(rec);
      doc.views.set(tableKey(v.name), v);
      break;
    }
    case 'UCS': {
      const u = ucs(rec);
      doc.ucs.set(tableKey(u.name), u);
      break;
    }
    case 'APPID': {
      const { base } = split(rec);
      doc.appIds.set(tableKey(base.name), base);
      break;
    }
    case 'BLOCK_RECORD': {
      const b = blockRecord(rec);
      doc.blockRecords.set(tableKey(b.name), b);
      if (b.handle) th.blockRecords.set(b.handle, b.name);
      break;
    }
    default:
      break;
  }
}

/** DIMSTYLE의 핸들 변수를 이름으로 바꾼다(DIMTXSTY는 문자 스타일, DIMBLK*는 블록, DIMLTYPE*는 선종류). */
export function resolveDimStyleHandles(doc: CadDocument, th: TableHandles): void {
  for (const d of doc.dimStyles.values()) {
    for (const [k, v] of Object.entries(d.vars)) {
      if (typeof v !== 'string' || !v.startsWith('#')) continue;
      const h = v.slice(1);
      let resolved: string | undefined;
      if (k === 'DIMTXSTY') resolved = th.styles.get(h);
      else if (k.startsWith('DIMLTYPE') || k.startsWith('DIMLTEX')) resolved = th.linetypes.get(h);
      else resolved = th.blockRecords.get(h);
      d.vars[k] = resolved ?? '';
    }
  }
}
