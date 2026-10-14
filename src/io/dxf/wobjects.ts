/** OBJECTS 구역 쓰기(R2000+) */
import type {
  DictionaryObject,
  GenericObject,
  GroupObject,
  ImageDefObject,
  MLeaderStyleObject,
  MLineStyleObject,
  PlotSettings,
  PlotSettingsObject,
  ScaleObject,
  SortEntsTableObject,
  SpatialFilterObject,
  UnderlayDefObject,
  XRecordObject,
} from '../../core/model';
import type { TagSink } from './tagwriter';
import { type PlannedLayout, type PlannedObject, type WriteContext, standardTableStyle } from './wcontext';
import { TagOut, appGroups, cadColorToRaw, validLineweight, writeXData } from './wentities';
import { fieldTags } from '../fields';
import { parseTableStyleTags, tableStyleTags, tableStyleTagsFit } from '../tablestyle';

/** R2007 전후 형식 계열(필드 값 배치가 다르다) */
const versionFamily = (v: string | undefined): number => (Number(String(v ?? 'AC1032').slice(2)) >= 1021 ? 2 : 1);

function header(w: TagOut, type: string, h: string, owner: string, xdict: string | undefined, reactors: readonly string[] | undefined): void {
  w.t(0, type);
  w.t(5, h);
  appGroups(w, xdict, reactors);
  w.t(330, owner || '0');
  w.ctx.countType(type);
}

function plotSettings(w: TagOut, p: PlotSettings): void {
  const ver = w.ctx.ver;
  w.t(100, 'AcDbPlotSettings');
  w.t(1, p.pageSetupName ?? '');
  w.t(2, p.printerName || 'none_device');
  w.t(4, p.paperName ?? '');
  w.t(6, '');
  w.t(40, p.margins[0] ?? 0);
  w.t(41, p.margins[1] ?? 0);
  w.t(42, p.margins[2] ?? 0);
  w.t(43, p.margins[3] ?? 0);
  w.t(44, p.paperWidth);
  w.t(45, p.paperHeight);
  w.t(46, p.plotOrigin.x);
  w.t(47, p.plotOrigin.y);
  w.t(48, p.windowMin.x);
  w.t(49, p.windowMin.y);
  w.t(140, p.windowMax.x);
  w.t(141, p.windowMax.y);
  w.t(142, p.scaleNumerator || 1);
  w.t(143, p.scaleDenominator || 1);
  w.t(70, p.flags);
  w.t(72, p.paperUnits);
  w.t(73, p.rotation);
  w.t(74, p.plotType);
  w.t(7, p.styleSheet ?? '');
  w.t(75, p.standardScaleType);
  if (ver >= 1018) {
    w.t(147, (p.scaleNumerator || 1) / (p.scaleDenominator || 1));
    w.t(76, 0);
    w.t(77, 2);
    w.t(78, 300);
    w.t(148, 0);
    w.t(149, 0);
  }
}

function layout(w: TagOut, pl: PlannedLayout): void {
  const ctx = w.ctx;
  const l = pl.layout;
  const owner = ctx.layoutOwner.get(pl.h) ?? ctx.rootH;
  header(w, 'LAYOUT', pl.h, owner, pl.obj?.xdict, [owner, ...(pl.obj?.reactors ?? [])]);
  plotSettings(w, l.plot);
  w.t(100, 'AcDbLayout');
  w.t(1, l.name);
  w.t(70, l.flags);
  w.t(71, l.tabOrder);
  w.p2(10, l.limitsMin);
  w.p2(11, l.limitsMax);
  w.p3(12, l.insertionBase);
  w.p3(14, l.extMin);
  w.p3(15, l.extMax);
  w.t(146, l.elevation);
  w.p3(13, l.ucsOrigin);
  w.p3(16, l.ucsXAxis);
  w.p3(17, l.ucsYAxis);
  w.t(76, 0);
  w.t(330, pl.block.recH);
  w.h(331, l.viewport);
  writeXData(w, pl.obj?.xdata);
}

function dictionary(w: TagOut, p: PlannedObject): void {
  const ctx = w.ctx;
  const d = p.obj as DictionaryObject;
  const wdflt = d.type === 'ACDBDICTIONARYWDFLT';
  w.t(100, 'AcDbDictionary');
  if (d.hardOwner) w.t(280, 1);
  w.t(281, d.cloning ?? 1);
  const code = d.hardOwner ? 360 : 350;
  for (const [k, h] of ctx.dictEntries.get(p.h) ?? []) {
    w.t(3, k);
    w.t(code, h);
  }
  if (wdflt) {
    w.t(100, 'AcDbDictionaryWithDefault');
    w.t(340, ctx.dictDefault.get(p.h) ?? (ctx.isLive(d.defaultHandle) ? d.defaultHandle!.toUpperCase() : ctx.plotStyleNormalH || '0'));
  }
}

function mlineStyle(w: TagOut, o: MLineStyleObject): void {
  const RAD2DEG = 180 / Math.PI;
  w.t(100, 'AcDbMlineStyle');
  w.t(2, o.name);
  w.t(70, o.flags);
  w.t(3, o.description ?? '');
  w.t(62, o.fillColor?.aci ?? 256);
  w.t(51, (o.startAngle ?? Math.PI / 2) * RAD2DEG);
  w.t(52, (o.endAngle ?? Math.PI / 2) * RAD2DEG);
  let els = o.elements;
  if (!els.length) {
    els = [{ offset: 0, color: { aci: 256 }, linetype: 'BYLAYER' }];
    w.ctx.warn('mlinestyle.no_elements', '요소가 없는 다중선 스타일에 요소 하나를 넣었습니다.', o.name);
  }
  w.t(71, els.length);
  for (const e of els) {
    w.t(49, e.offset);
    w.t(62, e.color?.aci ?? 256);
    w.t(6, e.linetype || 'BYLAYER');
  }
}

/** MLEADERSTYLE(원본 태그가 없을 때 모델 값으로) */
function mleaderStyle(w: TagOut, o: MLeaderStyleObject): void {
  const ctx = w.ctx;
  w.t(100, 'AcDbMLeaderStyle');
  if (ctx.ver >= 1024) w.t(179, 2);
  w.t(170, o.contentType);
  w.t(171, 1);
  w.t(172, 0);
  w.t(90, 2);
  w.t(40, 0);
  w.t(41, 0);
  w.t(173, o.leaderLineType);
  w.t(91, cadColorToRaw(o.leaderLineColor));
  const bb = ctx.ltypeH.get('BYBLOCK');
  if (bb) w.t(340, bb);
  w.t(92, validLineweight(o.leaderLineWeight));
  w.t(290, o.landing ? 1 : 0);
  w.t(42, o.landingGap);
  w.t(291, 1);
  w.t(43, o.doglegLength);
  w.t(3, o.name);
  w.h(341, o.arrowHeadHandle);
  w.t(44, o.arrowSize);
  w.t(300, '');
  const ts = o.textStyleHandle && ctx.isLive(o.textStyleHandle) ? o.textStyleHandle.toUpperCase() : ctx.styleH.get('STANDARD');
  if (ts) w.t(342, ts);
  w.t(174, 1);
  w.t(178, 1);
  w.t(175, 1);
  w.t(176, 0);
  w.t(93, cadColorToRaw(o.textColor));
  w.t(45, o.textHeight);
  w.t(292, 0);
  w.t(297, 0);
  w.t(46, o.textHeight);
  w.h(343, o.blockHandle);
  w.t(94, cadColorToRaw({ aci: 0 }));
  w.t(47, 1);
  w.t(49, 1);
  w.t(140, 1);
  w.t(293, 1);
  w.t(141, 0);
  w.t(294, 1);
  w.t(177, 0);
  w.t(142, o.scale || 1);
  w.t(295, 0);
  w.t(296, 0);
  // 끊기 간격: acad.dwt 0.125, acadiso.dwt 3.75
  w.t(143, ctx.doc.header.get('$MEASUREMENT') === 1 ? 3.75 : 0.125);
  if (ctx.ver >= 1024) {
    w.t(271, 0);
    w.t(272, 9);
    w.t(273, 9);
  }
  if (ctx.ver >= 1032) w.t(298, 0);
}

function spatialFilter(w: TagOut, o: SpatialFilterObject): void {
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  w.t(100, 'AcDbFilter');
  w.t(100, 'AcDbSpatialFilter');
  w.t(70, o.boundary.length);
  for (const p of o.boundary) w.p2(10, p);
  w.p3(210, o.normal);
  w.p3(11, o.origin);
  w.t(71, o.displayBoundary ? 1 : 0);
  w.t(72, o.frontClip !== undefined ? 1 : 0);
  if (o.frontClip !== undefined) w.t(40, o.frontClip);
  w.t(73, o.backClip !== undefined ? 1 : 0);
  if (o.backClip !== undefined) w.t(41, o.backClip);
  for (const x of o.inverseBlockTransform.length === 12 ? o.inverseBlockTransform : I) w.t(40, x);
  for (const x of o.clipTransform.length === 12 ? o.clipTransform : I) w.t(40, x);
}

function writeObject(w: TagOut, p: PlannedObject): void {
  const ctx = w.ctx;
  const o = p.obj;
  let reactors = o.reactors;
  if (p.synthetic) reactors = p.owner && p.owner !== '0' && o.type !== 'IMAGEDEF_REACTOR' ? [p.owner] : [];
  if (o.type === 'IMAGEDEF') reactors = [...(reactors ?? []), ...(ctx.imageDefReactors.get(p.h) ?? [])];
  header(w, o.type, p.h, p.owner, o.xdict, reactors);
  switch (o.type) {
    case 'DICTIONARY':
    case 'ACDBDICTIONARYWDFLT':
      dictionary(w, p);
      break;
    case 'PLOTSETTINGS':
      plotSettings(w, (o as PlotSettingsObject).plot);
      break;
    case 'MLINESTYLE':
      mlineStyle(w, o as MLineStyleObject);
      break;
    case 'IMAGEDEF': {
      const d = o as ImageDefObject;
      w.t(100, 'AcDbRasterImageDef');
      w.t(90, 0);
      w.t(1, d.fileName ?? '');
      w.p2(10, d.imageSize);
      w.p2(11, d.pixelSize);
      w.t(280, d.loaded ? 1 : 0);
      w.t(281, d.resolutionUnits);
      break;
    }
    case 'IMAGEDEF_REACTOR':
      w.t(100, 'AcDbRasterImageDefReactor');
      w.t(90, 2);
      w.t(330, p.owner);
      break;
    case 'PDFDEFINITION':
    case 'DWFDEFINITION':
    case 'DGNDEFINITION': {
      const d = o as UnderlayDefObject;
      w.t(100, 'AcDbUnderlayDefinition');
      w.t(1, d.fileName ?? '');
      w.t(2, d.name ?? '');
      break;
    }
    case 'SORTENTSTABLE': {
      const s = o as SortEntsTableObject;
      w.t(100, 'AcDbSortentsTable');
      w.t(330, ctx.isLive(s.blockRecord) ? s.blockRecord.toUpperCase() : ctx.model.recH);
      for (const e of s.entries) {
        if (!ctx.isLive(e.entity)) continue;
        w.t(331, e.entity.toUpperCase());
        w.t(5, e.sort.toUpperCase());
      }
      break;
    }
    case 'GROUP': {
      const g = o as GroupObject;
      w.t(100, 'AcDbGroup');
      w.t(300, g.description ?? '');
      w.t(70, g.unnamed ? 1 : 0);
      w.t(71, g.selectable ? 1 : 0);
      for (const h of ctx.groupMembers.get(p.h) ?? []) w.t(340, h);
      break;
    }
    case 'XRECORD': {
      const x = o as XRecordObject;
      w.t(100, 'AcDbXrecord');
      w.t(280, x.cloning ?? 1);
      w.raw(x.data);
      break;
    }
    case 'SPATIAL_FILTER':
      spatialFilter(w, o as SpatialFilterObject);
      break;
    case 'MLEADERSTYLE': {
      const m = o as MLeaderStyleObject;
      if (m.raw && m.raw.length) w.raw(m.raw);
      else mleaderStyle(w, m);
      break;
    }
    case 'SCALE': {
      const s = o as ScaleObject;
      w.t(100, 'AcDbScale');
      w.t(70, 0);
      w.t(300, s.name);
      w.t(140, s.paperUnits);
      w.t(141, s.drawingUnits);
      w.t(290, s.unitScale ? 1 : 0);
      break;
    }
    case 'ACDBPLACEHOLDER':
      break;
    default: {
      const g = o as GenericObject;
      // 필드: 값 배치가 R2007에서 바뀌므로 원본과 형식 계열이 다르면 모델 값으로 다시 만든다
      if (o.type === 'FIELD' && g.field && (!g.raw || versionFamily(ctx.doc.version) !== versionFamily(ctx.version))) w.raw(fieldTags(g.field, ctx.ver));
      // 테이블 스타일: 원본 태그의 배치(R2004 / R2007 / R2010+)가 대상 버전과 다르면 값으로 다시 만든다
      else if (o.type === 'TABLESTYLE' && g.raw && !tableStyleTagsFit(g.raw, ctx.ver) && parseTableStyleTags(g.raw)) w.raw(tableStyleTags(parseTableStyleTags(g.raw)!, ctx.ver));
      else if (g.raw) w.raw(g.raw);
      else if (o.type === 'DBCOLOR' && g.color) {
        w.t(100, 'AcDbColor');
        if (g.color.aci >= 1 && g.color.aci <= 255) w.t(62, g.color.aci);
        if (g.color.rgb !== undefined) w.t(420, g.color.rgb & 0xffffff);
        if (g.color.name) w.t(430, g.color.name);
      } else if (o.type === 'TABLESTYLE') w.raw(standardTableStyle(ctx.ver, ctx.doc.header.get('$MEASUREMENT') === 1).raw!);
    }
  }
  writeXData(w, o.xdata);
}

export function writeObjects(s: TagSink, ctx: WriteContext): void {
  const w = new TagOut(s, ctx);
  w.t(0, 'SECTION');
  w.t(2, 'OBJECTS');
  // 루트 사전이 처음이어야 한다.
  const root = ctx.objByH.get(ctx.rootH);
  if (root) writeObject(w, root);
  let layoutsDone = false;
  const layouts = () => {
    if (layoutsDone) return;
    layoutsDone = true;
    for (const pl of ctx.layouts) layout(w, pl);
  };
  for (const p of ctx.objects) {
    if (p === root) continue;
    writeObject(w, p);
    // 배치 사전 바로 뒤에 배치 객체
    if (ctx.layoutOwner.size && p.h === ctx.layoutOwner.values().next().value) layouts();
  }
  layouts();
  w.t(0, 'ENDSEC');
}
