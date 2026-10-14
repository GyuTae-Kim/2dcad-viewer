/** TABLES 구역 쓰기(VPORT, LTYPE, LAYER, STYLE, VIEW, UCS, APPID, DIMSTYLE, BLOCK_RECORD) */
import type { DimStyle, Layer, Linetype, TableRecordBase, TextStyle, UcsRecord, ViewRecord, VPortRecord, XData } from '../../core/model';
import { tableKey } from '../../core/model';
import { DIM_VAR_CODES } from '../../core/dimvars';
import type { TagSink } from './tagwriter';
import { kindOf } from './tagwriter';
import type { PlannedRecord, TableName, WriteContext } from './wcontext';
import { TagOut, appGroups, writeXData } from './wentities';

const SUBCLASS: Record<TableName, string> = {
  VPORT: 'AcDbViewportTableRecord',
  LTYPE: 'AcDbLinetypeTableRecord',
  LAYER: 'AcDbLayerTableRecord',
  STYLE: 'AcDbTextStyleTableRecord',
  VIEW: 'AcDbViewTableRecord',
  UCS: 'AcDbUCSTableRecord',
  APPID: 'AcDbRegAppTableRecord',
  DIMSTYLE: 'AcDbDimStyleTableRecord',
  BLOCK_RECORD: 'AcDbBlockTableRecord',
};

function tableBegin(w: TagOut, name: TableName, count: number, extra?: () => void): void {
  const ctx = w.ctx;
  w.t(0, 'TABLE');
  w.t(2, name);
  if (!w.r12) {
    const h = ctx.tableHeads.get(name)!;
    w.t(5, h);
    const head = ctx.doc.tableHeads?.get(name);
    appGroups(w, head?.xdict, head?.reactors);
    w.t(330, '0');
    w.t(100, 'AcDbSymbolTable');
  }
  w.t(70, count);
  extra?.();
  if (!w.r12) writeXData(w, ctx.doc.tableHeads?.get(name)?.xdata);
}

function recordBegin(w: TagOut, table: TableName, p: PlannedRecord<TableRecordBase>, flags?: number): void {
  const r = p.rec;
  w.t(0, table);
  w.t(table === 'DIMSTYLE' ? 105 : 5, p.h);
  if (!w.r12) {
    appGroups(w, r.xdict, undefined);
    w.t(330, w.ctx.tableHeads.get(table)!);
    w.t(100, 'AcDbSymbolTableRecord');
    w.t(100, SUBCLASS[table]);
  }
  w.t(2, r.name);
  w.t(70, flags ?? r.flags);
}

function vport(w: TagOut, p: PlannedRecord<VPortRecord>): void {
  const v = p.rec;
  const ver = w.ctx.ver;
  recordBegin(w, 'VPORT', p);
  w.p2(10, v.lowerLeft);
  w.p2(11, v.upperRight);
  w.p2(12, v.center);
  w.p2(13, v.snapBase);
  w.p2(14, v.snapSpacing);
  w.p2(15, v.gridSpacing);
  w.p3(16, v.viewDirection);
  w.p3(17, v.viewTarget);
  w.t(40, v.height || 1);
  w.t(41, v.aspect || 1);
  w.t(42, v.lensLength || 50);
  w.t(43, 0);
  w.t(44, 0);
  w.t(50, 0);
  w.deg(51, v.twist);
  w.t(71, 0);
  w.t(72, 1000);
  w.t(73, 1);
  w.t(74, 3);
  w.t(75, 0);
  w.t(76, 0);
  w.t(77, 0);
  w.t(78, 0);
  if (ver >= 1015) {
    w.t(281, 0);
    w.t(65, 1);
    w.p3(110, { x: 0, y: 0, z: 0 });
    w.p3(111, { x: 1, y: 0, z: 0 });
    w.p3(112, { x: 0, y: 1, z: 0 });
    w.t(79, 0);
    w.t(146, 0);
  }
  if (ver >= 1021) {
    w.t(60, 3);
    w.t(61, 5);
    w.t(292, 1);
    w.t(282, 1);
    w.t(141, 0);
    w.t(142, 0);
    w.t(63, 250);
    w.t(421, 3355443);
  }
  writeXData(w, v.xdata);
}

function ltype(w: TagOut, p: PlannedRecord<Linetype>): void {
  const l = p.rec;
  const ctx = w.ctx;
  recordBegin(w, 'LTYPE', p);
  w.t(3, l.description ?? '');
  w.t(72, 65);
  w.t(73, l.elements.length);
  const total = l.patternLength || l.elements.reduce((a, e) => a + Math.abs(e.length), 0);
  w.t(40, total);
  for (const el of l.elements) {
    w.t(49, el.length);
    if (w.r12) continue;
    let flags = el.flags;
    const styleOk = !!el.styleHandle && ctx.isLive(el.styleHandle);
    if (flags & 6 && !styleOk) {
      flags &= ~6;
      ctx.warn('ltype.complex_dropped', '문자·쉐이프 스타일을 찾을 수 없어 선종류 요소의 문자·쉐이프를 뺐습니다.', l.name);
    }
    w.t(74, flags);
    if (flags & 6) {
      w.t(75, flags & 2 ? 0 : (el.shapeNumber ?? 0));
      w.t(340, el.styleHandle!.toUpperCase());
      w.t(46, el.scale || 1);
      w.deg(50, el.rotation);
      w.t(44, el.offset.x);
      w.t(45, el.offset.y);
      if (flags & 2) w.t(9, el.text ?? '');
    }
  }
  writeXData(w, l.xdata);
}

/** 확장 자료에서 앱 하나를 바꾸거나 넣는다. */
function setApp(list: XData[] | undefined, app: string, items: XData['items'] | null): XData[] | undefined {
  const out = (list ?? []).filter((x) => x.app.toUpperCase() !== app.toUpperCase());
  if (items) out.push({ app, items });
  return out.length ? out : undefined;
}

function layer(w: TagOut, p: PlannedRecord<Layer>): void {
  const l = p.rec;
  const ctx = w.ctx;
  const ver = ctx.ver;
  const flags = (l.flags & ~5) | (l.frozen ? 1 : 0) | (l.locked ? 4 : 0);
  recordBegin(w, 'LAYER', p, flags);
  let aci = l.color.aci;
  if (!(aci >= 1 && aci <= 255)) aci = 7;
  w.t(62, l.off ? -aci : aci);
  if (ver >= 1018 && l.color.rgb !== undefined) w.t(420, l.color.rgb & 0xffffff);
  if (ver >= 1018 && l.color.name) w.t(430, l.color.name);
  w.t(6, l.linetype || 'Continuous');
  if (ver >= 1015) {
    if (!l.plot) w.t(290, 0);
    w.t(370, l.lineweight === -1 || l.lineweight === -2 ? -3 : l.lineweight);
    if (!w.h(390, l.plotStyle) && ctx.plotStyleNormalH) w.t(390, ctx.plotStyleNormalH);
  }
  // 투명도·설명 확장 자료는 모델 값과 다를 때만 다시 만든다.
  let xdata = l.xdata;
  if (ver >= 1015) {
    const tr = xdata?.find((x) => x.app.toUpperCase() === 'ACCMTRANSPARENCY');
    const cur = tr ? Number(tr.items.find((i) => i.code === 1071)?.value ?? 0) >>> 0 : undefined;
    const curT = cur !== undefined && cur & 0x02000000 ? cur & 0xff : 255;
    if (curT !== l.transparency && l.transparency >= 0 && l.transparency <= 255) {
      xdata = setApp(xdata, 'AcCmTransparency', l.transparency === 255 ? null : [{ code: 1071, value: (0x02000000 | l.transparency) | 0 }]);
    }
    const ds = xdata?.find((x) => x.app.toUpperCase() === 'ACAECLAYERSTANDARD');
    const curD = ds ? String(ds.items.filter((i) => i.code === 1000)[1]?.value ?? '') : '';
    if ((l.description ?? '') !== curD) {
      xdata = setApp(xdata, 'AcAecLayerStandard', l.description ? [{ code: 1000, value: '' }, { code: 1000, value: l.description }] : null);
    }
  }
  writeXData(w, xdata);
}

function style(w: TagOut, p: PlannedRecord<TextStyle>): void {
  const s = p.rec;
  recordBegin(w, 'STYLE', p);
  w.t(40, s.height || 0);
  w.t(41, s.widthFactor || 1);
  w.deg(50, s.oblique);
  w.t(71, s.generation);
  w.t(42, s.lastHeight || 2.5);
  w.t(3, s.font ?? '');
  w.t(4, s.bigFont ?? '');
  let xdata = s.xdata;
  if (!w.r12 && s.fontFamily) {
    const acad = xdata?.find((x) => x.app.toUpperCase() === 'ACAD');
    const fam = acad?.items.find((i) => i.code === 1000)?.value;
    const fl = acad?.items.find((i) => i.code === 1071)?.value;
    if (fam !== s.fontFamily || (s.fontFlags !== undefined && Number(fl) !== s.fontFlags)) {
      xdata = setApp(xdata, 'ACAD', [
        { code: 1000, value: s.fontFamily },
        { code: 1071, value: s.fontFlags ?? 34 },
      ]);
    }
  }
  writeXData(w, xdata);
}

function view(w: TagOut, p: PlannedRecord<ViewRecord>): void {
  const v = p.rec;
  const ver = w.ctx.ver;
  recordBegin(w, 'VIEW', p);
  w.t(40, v.height || 1);
  w.p2(10, v.center);
  w.t(41, v.width || 1);
  w.p3(11, v.viewDirection);
  w.p3(12, v.viewTarget);
  w.t(42, 50);
  w.t(43, 0);
  w.t(44, 0);
  w.deg(50, v.twist);
  w.t(71, 0);
  if (ver >= 1015) {
    w.t(281, 0);
    w.t(72, 0);
  }
  if (ver >= 1021) w.t(73, 0);
  writeXData(w, v.xdata);
}

function ucs(w: TagOut, p: PlannedRecord<UcsRecord>): void {
  const u = p.rec;
  recordBegin(w, 'UCS', p);
  w.p3(10, u.origin);
  w.p3(11, u.xAxis);
  w.p3(12, u.yAxis);
  if (w.ctx.ver >= 1015) {
    w.t(79, 0);
    w.t(146, 0);
  }
  writeXData(w, u.xdata);
}

/** 치수 변수 이름 → 그룹 코드(이름 하나가 문자열·핸들 두 코드를 가지면 둘 다) */
const DIM_CODES_BY_NAME = new Map<string, number[]>();
for (const [code, name] of Object.entries(DIM_VAR_CODES)) {
  const list = DIM_CODES_BY_NAME.get(name) ?? [];
  list.push(Number(code));
  DIM_CODES_BY_NAME.set(name, list);
}

function dimCodeMinVersion(code: number): number {
  if (code === 49 || code === 50 || code === 69 || code === 70 || code === 90 || code === 290 || (code >= 345 && code <= 347)) return 1021;
  if (code === 294) return 1024;
  if (code === 79 || code === 148 || code === 179 || (code >= 271 && code <= 289) || (code >= 340 && code <= 344) || code === 371 || code === 372) return 1015;
  return 1009;
}

function dimstyle(w: TagOut, p: PlannedRecord<DimStyle>): void {
  const d = p.rec;
  const ctx = w.ctx;
  const ver = ctx.ver;
  recordBegin(w, 'DIMSTYLE', p);
  const tags: [number, string | number][] = [];
  for (const [name, value] of Object.entries(d.vars)) {
    const codes = DIM_CODES_BY_NAME.get(name);
    if (!codes) continue;
    for (const code of codes) {
      if (code === 270 || code === 287) continue; // R13·R14에만 있는 옛 변수
      if (ver < dimCodeMinVersion(code)) continue;
      if (code >= 5 && code <= 7 && ver > 1009) continue; // R2000+는 블록 핸들(342~344)
      if (code >= 340 && code <= 347) {
        const nm = String(value ?? '');
        if (!nm) continue;
        let h: string | undefined;
        if (code === 340) h = ctx.styleH.get(tableKey(nm));
        else if (code >= 345) h = ctx.ltypeH.get(tableKey(nm));
        else h = ctx.blockByKey.get(tableKey(nm))?.recH;
        if (h) tags.push([code, h]);
        else ctx.warn('dimstyle.ref_missing', '치수 스타일이 가리키는 블록·스타일·선종류가 없어 그 변수를 쓰지 않았습니다.', `${d.name}.${name}=${nm}`);
        continue;
      }
      const kind = kindOf(code);
      if (kind === 'str') tags.push([code, String(value ?? '')]);
      else if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))) tags.push([code, Number(value)]);
    }
  }
  tags.sort((a, b) => a[0] - b[0]);
  for (const [c, v] of tags) w.t(c, v);
  writeXData(w, d.xdata);
}

function appid(w: TagOut, p: PlannedRecord<TableRecordBase>): void {
  recordBegin(w, 'APPID', p);
  writeXData(w, p.rec.xdata);
}

export function writeTables(s: TagSink, ctx: WriteContext): void {
  const w = new TagOut(s, ctx);
  const r12 = w.r12;
  w.t(0, 'SECTION');
  w.t(2, 'TABLES');
  const table = <T extends TableRecordBase>(name: TableName, list: PlannedRecord<T>[], fn: (w: TagOut, p: PlannedRecord<T>) => void, extra?: () => void) => {
    tableBegin(w, name, list.length, extra);
    for (const p of list) fn(w, p);
    w.t(0, 'ENDTAB');
  };
  table('VPORT', ctx.vports, vport);
  // R12 선종류 표에는 ByBlock·ByLayer가 없다.
  table('LTYPE', r12 ? ctx.ltypes.filter((p) => !['BYBLOCK', 'BYLAYER'].includes(tableKey(p.rec.name))) : ctx.ltypes, ltype);
  table('LAYER', ctx.layers, layer);
  table('STYLE', ctx.styles, style);
  table('VIEW', ctx.views, view);
  table('UCS', ctx.ucs, ucs);
  table('APPID', ctx.appids, appid);
  table('DIMSTYLE', ctx.dimstyles, dimstyle, () => {
    if (r12) return;
    w.t(100, 'AcDbDimStyleTable');
    w.t(71, ctx.dimstyles.length);
    for (const d of ctx.dimstyles) w.t(340, d.h);
  });
  if (!r12) {
    tableBegin(w, 'BLOCK_RECORD', ctx.blocks.length);
    for (const pb of ctx.blocks) {
      const r = pb.rec;
      w.t(0, 'BLOCK_RECORD');
      w.t(5, pb.recH);
      appGroups(w, r.xdict, undefined);
      w.t(330, ctx.tableHeads.get('BLOCK_RECORD')!);
      w.t(100, 'AcDbSymbolTableRecord');
      w.t(100, 'AcDbBlockTableRecord');
      w.t(2, pb.name);
      w.t(340, pb.layout?.h ?? '0');
      if (ctx.ver >= 1021) {
        w.t(70, r.insertUnits || 0);
        w.t(280, r.explodable ? 1 : 0);
        w.t(281, r.scalable ? 1 : 0);
      }
      writeXData(w, r.xdata);
    }
    w.t(0, 'ENDTAB');
  }
  w.t(0, 'ENDSEC');
}
