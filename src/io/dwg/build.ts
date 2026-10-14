/**
 * 헤더·클래스·객체를 읽어 CadDocument를 만든다.
 * 1단계: 객체 종류만 훑는다. 2단계: 표·사전 같은 비도형 객체. 3단계: 도형(이름은 이미 풀 수 있다).
 * 4단계: 블록마다 도형 순서를 맞추고 속성·정점을 부모에 붙인다.
 */
import {
  type AttribEntity,
  type BlockDef,
  type BlockRecord,
  type CadColor,
  type CadDocument,
  type CadObject,
  type DictionaryObject,
  type DimStyle,
  type GenericObject,
  type HeaderValue,
  type Layer,
  type Layout,
  type Linetype,
  type PolylineEntity,
  type TableRecordBase,
  type TextStyle,
  type UcsRecord,
  type ViewRecord,
  type VPortRecord,
  type ViewportEntity,
  createDocument,
  tableKey,
} from '../../core/model';
import { finalizeDocument } from '../../core/finalize';
import { codepageToEncoding, decoderFor, dwgCodepageName } from '../../core/codepage';
import { warn, type DwgSections } from './container/types';
import { cmcToCad } from './color';
import { readClasses } from './classes';
import { readHeader } from './header';
import { readObjectMap } from './handles';
import { ObjectReader } from './objects/reader';
import { CONTROL_TYPES } from './objects/types';
import {
  type BlockHeaderRec,
  type ControlObject,
  type DimStyleRec,
  type LayerRec,
  type LtypeRec,
  type RecordCommon,
  type StyleRec,
  type UcsRec,
  type ViewRec,
  type VportRec,
  readBlockHeader,
  readControl,
  readDimStyle,
  readLayer,
  readLtype,
  readSimpleRecord,
  readStyle,
  readUcs,
  readView,
  readVport,
} from './objects/tables';
import {
  type LayoutRaw,
  type MLineStyleRaw,
  hex,
  readDictionary,
  readGenericObject,
  readGroup,
  readImageDef,
  readLayout,
  readMLeaderStyle,
  readMLineStyle,
  readPlotSettingsObject,
  readScale,
  readSortEnts,
  readSpatialFilter,
  readUnderlayDef,
  readXRecord,
} from './objects/nonentities';
import { type Names, type ParsedEntity, readEntity, xdataFromEed } from './objects/entities';
import { R2004, R2007, R2010 } from './version';
import { captureRaw } from './rawbody';
import { RAW_TAG_TYPES, decodeRawTags } from './objects/rawtags';
import { decodeTableStyleBody } from './objects/tableraw';
import { parseDimOverrides } from './xdata';

/** 원본 본문을 남기는 도형 */
const RAW_TYPES = new Set(['UNKNOWN', 'REGION', '3DSOLID', 'BODY', 'SURFACE', 'PLANESURFACE', 'EXTRUDEDSURFACE', 'LOFTEDSURFACE', 'REVOLVEDSURFACE', 'SWEPTSURFACE', 'NURBSURFACE', 'OLE2FRAME', 'OLEFRAME', 'ACAD_TABLE', 'MULTILEADER', 'MESH']);

export interface BuildOptions {
  onProgress?: (fraction: number) => void;
  maxEntities?: number;
}

export function buildDocument(sec: DwgSections, opts: BuildOptions = {}): CadDocument {
  const ver = sec.ver;
  const doc = createDocument('dwg');
  doc.version = `AC${ver}`;
  doc.warnings = sec.warnings;
  const warnings = doc.warnings;
  const codepage = dwgCodepageName(sec.codepage);
  doc.codepage = codepage;
  const decoder = decoderFor(codepageToEncoding(codepage));

  const header = readHeader(sec, decoder);
  doc.classes = readClasses(sec, decoder);
  const map = readObjectMap(sec);
  const or = new ObjectReader(sec.objects, ver, decoder, doc.classes);
  opts.onProgress?.(0.05);

  // 1단계: 종류 훑기
  const entityHandles: number[] = [];
  const objectHandles: number[] = [];
  const typeOf = new Map<number, string>();
  for (const [h, off] of map) {
    let info;
    try {
      info = or.peekType(off);
    } catch {
      info = null;
    }
    if (!info) {
      warn(warnings, 'dwg.object_skipped', '객체 위치가 잘못되어 건너뛰었습니다.');
      continue;
    }
    typeOf.set(h, info.typeName);
    if (info.isEntity) entityHandles.push(h);
    else objectHandles.push(h);
  }

  // 2단계: 비도형 객체
  const controls = new Map<number, ControlObject>();
  const layers = new Map<number, LayerRec>();
  const styles = new Map<number, StyleRec>();
  const ltypes = new Map<number, LtypeRec>();
  const dimstyles = new Map<number, DimStyleRec>();
  const blockHeaders = new Map<number, BlockHeaderRec>();
  const vports = new Map<number, VportRec>();
  const views = new Map<number, ViewRec>();
  const ucss = new Map<number, UcsRec>();
  const appids = new Map<number, RecordCommon>();
  const layoutsRaw: LayoutRaw[] = [];
  const mlineStyles = new Map<number, MLineStyleRaw>();
  const objects = new Map<string, CadObject>();
  const crcBad: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const skipSamples: { type: string; handle: string; error: string }[] = [];
  const skip = (t: string, h: number, e: unknown): void => {
    skipped[t] = (skipped[t] ?? 0) + 1;
    if (skipSamples.length < 8) skipSamples.push({ type: t, handle: hex(h), error: String(e) });
  };

  let done = 0;
  const total = map.size || 1;
  const progress = (): void => {
    done++;
    if (opts.onProgress && (done & 511) === 0) opts.onProgress(0.05 + 0.85 * (done / total));
  };

  const deferred: number[] = [];
  // 비도형 객체의 확장 자료(앱 이름은 APPID를 다 읽은 뒤에 푼다)와 표 제어 객체의 머리
  const objEed = new Map<number, NonNullable<typeof or.h.eed>>();
  const controlMeta = new Map<number, { xdict: number; reactors: number[]; eed: typeof or.h.eed }>();
  const dbColors = new Map<number, CadColor>();
  for (const h of objectHandles) {
    progress();
    const off = map.get(h)!;
    let t = typeOf.get(h)!;
    try {
      const oh = or.begin(off, h);
      if (!oh.crcOk) crcBad[t] = (crcBad[t] ?? 0) + 1;
      t = oh.typeName;
      if (oh.eed) objEed.set(h, oh.eed);
      if (CONTROL_TYPES.has(t)) {
        controls.set(h, readControl(or));
        controlMeta.set(h, { xdict: or.h.xdict, reactors: [...or.h.reactors], eed: or.h.eed });
        continue;
      }
      switch (t) {
        case 'LAYER':
          layers.set(h, withXData(readLayer(or), or));
          break;
        case 'STYLE':
          styles.set(h, withXData(readStyle(or), or));
          break;
        case 'LTYPE':
          ltypes.set(h, withXData(readLtype(or), or));
          break;
        case 'DIMSTYLE':
          dimstyles.set(h, withXData(readDimStyle(or), or));
          break;
        case 'BLOCK_HEADER':
          blockHeaders.set(h, withXData(readBlockHeader(or), or));
          break;
        case 'VPORT':
          vports.set(h, withXData(readVport(or), or));
          break;
        case 'VIEW':
          views.set(h, withXData(readView(or), or));
          break;
        case 'UCS':
          ucss.set(h, withXData(readUcs(or), or));
          break;
        case 'APPID':
          appids.set(h, withXData(readSimpleRecord(or), or));
          break;
        case 'VPENT_HEADER':
          readSimpleRecord(or);
          break;
        case 'DICTIONARY':
          objects.set(hex(h), readDictionary(or, false));
          break;
        case 'ACDBDICTIONARYWDFLT':
          objects.set(hex(h), readDictionary(or, true));
          break;
        case 'LAYOUT':
          layoutsRaw.push(readLayout(or));
          break;
        case 'PLOTSETTINGS':
          objects.set(hex(h), readPlotSettingsObject(or));
          break;
        case 'MLINESTYLE': {
          const m = readMLineStyle(or);
          mlineStyles.set(h, m);
          break;
        }
        case 'IMAGEDEF':
          objects.set(hex(h), readImageDef(or));
          break;
        case 'PDFDEFINITION':
        case 'DWFDEFINITION':
        case 'DGNDEFINITION':
          objects.set(hex(h), readUnderlayDef(or, t));
          break;
        case 'SORTENTSTABLE':
          objects.set(hex(h), readSortEnts(or));
          break;
        case 'GROUP':
          objects.set(hex(h), readGroup(or));
          break;
        case 'XRECORD':
          objects.set(hex(h), readXRecord(or));
          break;
        case 'SPATIAL_FILTER':
          objects.set(hex(h), readSpatialFilter(or));
          break;
        case 'MLEADERSTYLE':
          // 확장 자료의 앱 이름이 필요해 표를 다 읽은 뒤에 읽는다
          deferred.push(h);
          break;
        case 'TABLESTYLE':
          // 문자 스타일 이름이 필요해 표를 다 읽은 뒤에 읽는다
          deferred.push(h);
          break;
        case 'DBCOLOR': {
          or.commonObject();
          const color = cmcToCad(or.dat.CMC());
          dbColors.set(h, color);
          const o: GenericObject = { type: 'DBCOLOR', handle: hex(h), color };
          if (or.h.owner) o.owner = hex(or.h.owner);
          if (or.h.reactors.length) o.reactors = or.h.reactors.map(hex);
          if (or.h.xdict) o.xdict = hex(or.h.xdict);
          objects.set(hex(h), o);
          break;
        }
        case 'SCALE':
          objects.set(hex(h), readScale(or));
          break;
        default: {
          const o = readGenericObject(or) as GenericObject;
          if (t === 'DICTIONARYVAR') {
            // 정수(280)와 문자열(1)
            const schema = or.dat.RC();
            o.raw = [
              { code: 280, value: schema },
              { code: 1, value: or.dat.TV() },
            ];
          } else if (t === 'RASTERVARIABLES') {
            // 클래스 판(90), 테두리(70), 표시 품질(71), 단위(72)
            o.raw = [
              { code: 100, value: 'AcDbRasterVariables' },
              { code: 90, value: or.dat.BL() },
              { code: 70, value: or.dat.BS() },
              { code: 71, value: or.dat.BS() },
              { code: 72, value: or.dat.BS() },
            ];
          } else if (t === 'WIPEOUTVARIABLES') {
            // 테두리(70)
            o.raw = [
              { code: 100, value: 'AcDbWipeoutVariables' },
              { code: 70, value: or.dat.BS() },
            ];
          } else if (RAW_TAG_TYPES.has(t)) {
            // FIELD·FIELDLIST·DIMASSOC·문자 주석 축척 자료: DXF와 같은 원본 태그(objects/rawtags.ts)
            const dec = decodeRawTags(or, t);
            if (dec) {
              o.raw = dec.raw;
              if (dec.field) o.field = dec.field;
            }
          }
          // 해석하지 않는 객체: 같은 버전으로 쓸 때 되쓸 본문
          const raw = captureRaw(or, o);
          if (raw) o.dwgRaw = raw;
          objects.set(hex(h), o);
          break;
        }
      }
    } catch (e) {
      skip(t, h, e);
    }
  }

  // 익명 블록: 파일에는 "*D"처럼 접두만 있고, 읽을 때 블록 제어 목록의 순번을 붙인다.
  {
    const appName = new Map<number, string>();
    for (const [h, a] of appids) appName.set(h, a.name);
    const takenNames = new Set([...blockHeaders.values()].map((b) => b.name.toUpperCase()));
    // R13·R14는 이름을 대문자로 저장한다: R2000+ 표기로 맞춘다
    for (const rec of blockHeaders.values()) {
      if (/^\*model_space$/i.test(rec.name)) rec.name = '*Model_Space';
      // 이전 형식으로 저장한 동적 블록: 익명 *U 블록 + AcDbDynamicBlockTrueName 확장 자료(본래 이름)
      // (번호까지 저장된 *U12 같은 이름은 그대로 둔다: 다른 프로그램이 쓴 파일)
      else if (/^\*U$/i.test(rec.name)) {
        const eed = (rec as { eed?: { app: number; items: { code: number; value: unknown }[] }[] | null }).eed;
        const tn = eed?.find((x) => appName.get(x.app)?.toUpperCase() === 'ACDBDYNAMICBLOCKTRUENAME')?.items.find((i) => i.code === 1000)?.value;
        if (typeof tn === 'string' && tn && !takenNames.has(tn.toUpperCase())) {
          takenNames.add(tn.toUpperCase());
          rec.name = tn;

        }
      }
      else if (/^\*paper_space\d*$/i.test(rec.name)) rec.name = '*Paper_Space' + rec.name.slice(12);
    }
    const bctrl = controls.get(header.refs.blockControl);
    if (bctrl) {
      bctrl.entries.forEach((bh, i) => {
        const rec = blockHeaders.get(bh);
        if (rec && /^\*([A-Za-z]|paper_space)$/i.test(rec.name)) rec.name += String(i);
      });
    }
  }

  // 살아 있는 표 레코드(제어 객체 목록에 있는 것). 제어 객체가 없으면 전부.
  const live = (ctrl: number, recs: Map<number, unknown>): number[] => {
    const c = controls.get(ctrl);
    if (!c) return [...recs.keys()];
    const list = [...c.entries, ...c.extra].filter((x) => recs.has(x));
    const set = new Set(list);
    // 제어 목록에 빠진 레코드도 소유자가 같으면 붙인다
    for (const k of recs.keys()) if (!set.has(k) && (recs.get(k) as RecordCommon).owner === ctrl) list.push(k);
    return [...new Set(list)];
  };
  const refs = header.refs;

  // 이름 표
  const layerName = new Map<number, string>();
  for (const [h, l] of layers) layerName.set(h, l.name);
  const ltypeName = new Map<number, string>();
  for (const [h, l] of ltypes) ltypeName.set(h, l.name);
  const styleName = new Map<number, string>();
  for (const [h, s] of styles) styleName.set(h, s.name);
  const dimstyleName = new Map<number, string>();
  for (const [h, d] of dimstyles) dimstyleName.set(h, d.name);
  const blockName = new Map<number, string>();
  for (const [h, b] of blockHeaders) blockName.set(h, b.name);
  const appName = new Map<number, string>();
  for (const [h, a] of appids) appName.set(h, a.name);
  const mlsName = new Map<number, string>();
  for (const [h, m] of mlineStyles) mlsName.set(h, m.name);
  for (const h of deferred) {
    try {
      const oh = or.begin(map.get(h)!, h);
      const t = oh.typeName;
      if (t === 'MLEADERSTYLE') {
        const isNew = ver >= R2010 || !!oh.eed?.some((x) => appName.get(x.app)?.toUpperCase() === 'ACAD_MLEADERVER');
        const o = readMLeaderStyle(or, isNew);
        const raw = captureRaw(or, o);
        if (raw) o.dwgRaw = raw;
        objects.set(hex(h), o);
      } else if (t === 'TABLESTYLE') {
        // 테이블 스타일: DXF와 같은 원본 태그(objects/tableraw.ts). 풀지 못하면 원본 본문만
        const o = readGenericObject(or) as GenericObject;
        const tags = decodeTableStyleBody(or, (x) => styleName.get(x) ?? '');
        if (tags) o.raw = tags;
        const raw = captureRaw(or, o);
        if (raw) o.dwgRaw = raw;
        objects.set(hex(h), o);
      }
    } catch (e) {
      skip(typeOf.get(h) ?? '?', h, e);
    }
  }
  const names: Names = {
    layer: (h) => layerName.get(h) ?? '',
    ltype: (h) => ltypeName.get(h) ?? '',
    style: (h) => styleName.get(h) ?? (h ? '' : ''),
    dimstyle: (h) => dimstyleName.get(h) ?? '',
    block: (h) => blockName.get(h) ?? '',
    app: (h) => appName.get(h) ?? hex(h),
    mlinestyle: (h) => mlsName.get(h) ?? '',
    bookColor: (h) => dbColors.get(h),
  };

  // 표 → 문서
  for (const h of live(refs.layerControl, layers)) {
    const l = layers.get(h)!;
    const layer: Layer = {
      name: l.name,
      handle: hex(h),
      flags: l.flags,
      color: l.color,
      off: l.off,
      frozen: l.frozen,
      locked: l.locked,
      linetype: ltypeName.get(l.ltype) ?? 'Continuous',
      lineweight: l.lineweight,
      plot: l.plot,
      transparency: l.transparency,
    };
    if (l.plotStyle) layer.plotStyle = hex(l.plotStyle);
    applyRecordExtras(layer, l, names);
    if (layer.xdata) {
      const t = layerTransparency(layer.xdata);
      if (t !== undefined) layer.transparency = t;
      // 도면층 설명: AcAecLayerStandard 확장 자료의 두 번째 문자열
      const std = layer.xdata.find((x) => x.app.toUpperCase() === 'ACAECLAYERSTANDARD');
      const strs = std?.items.filter((i) => i.code === 1000).map((i) => String(i.value)) ?? [];
      if (strs.length >= 2 && strs[1]) layer.description = strs[1];
    }
    doc.layers.set(tableKey(l.name), layer);
  }
  for (const h of live(refs.ltypeControl, ltypes)) {
    const l = ltypes.get(h)!;
    const lt: Linetype = {
      name: l.name,
      handle: hex(h),
      flags: l.flags,
      description: l.description,
      patternLength: l.patternLength,
      elements: l.elements.map(({ shapeFile, ...el }) => (shapeFile ? { ...el, styleHandle: hex(shapeFile) } : el)),
    };
    applyRecordExtras(lt, l, names);
    doc.linetypes.set(tableKey(l.name), lt);
  }
  for (const h of live(refs.styleControl, styles)) {
    const s = styles.get(h)!;
    const ts: TextStyle = {
      name: s.name,
      handle: hex(h),
      flags: s.flags,
      height: s.height,
      widthFactor: s.widthFactor,
      oblique: s.oblique,
      generation: s.generation,
      lastHeight: s.lastHeight,
      font: s.font,
      bigFont: s.bigFont,
    };
    applyRecordExtras(ts, s, names);
    const acad = ts.xdata?.find((x) => x.app.toUpperCase() === 'ACAD');
    if (acad) {
      const fam = acad.items.find((i) => i.code === 1000);
      const fl = acad.items.find((i) => i.code === 1071);
      if (fam && typeof fam.value === 'string') ts.fontFamily = fam.value;
      if (fl && typeof fl.value === 'number') ts.fontFlags = fl.value;
    }
    // 이름 없는 쉐이프 파일 항목은 핸들로 구분한다(DXF 리더와 같은 키)
    doc.textStyles.set(tableKey(s.name) || `*SHAPE:${hex(h)}`, ts);
  }
  for (const h of live(refs.dimstyleControl, dimstyles)) {
    const d = dimstyles.get(h)!;
    const vars = { ...d.vars };
    for (const [k, hv] of Object.entries(d.handleVars)) {
      if (!hv) continue; // 비어 있으면 기본값(DXF처럼 변수를 두지 않는다)
      if (k === 'DIMTXSTY') vars[k] = styleName.get(hv) ?? '';
      else if (k.startsWith('DIMLTYPE') || k.startsWith('DIMLTEX')) vars[k] = ltypeName.get(hv) ?? '';
      else vars[k] = blockName.get(hv) ?? '';
    }
    const ds: DimStyle = { name: d.name, handle: hex(h), flags: d.flags, vars };
    applyRecordExtras(ds, d, names);
    doc.dimStyles.set(tableKey(d.name), ds);
  }
  for (const h of live(refs.vportControl, vports)) {
    const v = vports.get(h)!;
    const rec: VPortRecord = {
      name: v.name,
      handle: hex(h),
      flags: v.flags,
      lowerLeft: v.lowerLeft,
      upperRight: v.upperRight,
      center: v.center,
      snapBase: v.snapBase,
      snapSpacing: v.snapSpacing,
      gridSpacing: v.gridSpacing,
      viewDirection: v.direction,
      viewTarget: v.target,
      height: v.height,
      aspect: v.aspect,
      lensLength: v.lens,
      twist: v.twist,
    };
    applyRecordExtras(rec, v, names);
    doc.vports.push(rec);
  }
  for (const h of live(refs.viewControl, views)) {
    const v = views.get(h)!;
    const rec: ViewRecord = { name: v.name, handle: hex(h), flags: v.flags, center: v.center, width: v.width, height: v.height, viewDirection: v.direction, viewTarget: v.target, twist: v.twist };
    applyRecordExtras(rec, v, names);
    doc.views.set(tableKey(v.name), rec);
  }
  for (const h of live(refs.ucsControl, ucss)) {
    const u = ucss.get(h)!;
    const rec: UcsRecord = { name: u.name, handle: hex(h), flags: u.flags, origin: u.origin, xAxis: u.xAxis, yAxis: u.yAxis };
    applyRecordExtras(rec, u, names);
    doc.ucs.set(tableKey(u.name), rec);
  }
  for (const h of live(refs.appidControl, appids)) {
    const a = appids.get(h)!;
    const rec: TableRecordBase = { name: a.name, handle: hex(h), flags: a.flags };
    applyRecordExtras(rec, a, names);
    doc.appIds.set(tableKey(a.name), rec);
  }

  // MLINESTYLE: 선종류 번호(R2018 이전)는 선종류 제어 목록 순서
  const ltCtrl = controls.get(refs.ltypeControl);
  for (const [h, m] of mlineStyles) {
    const { ltRefs, ...rest } = m;
    rest.elements = rest.elements.map((el, i) => {
      const ref = ltRefs[i];
      let name = 'ByLayer';
      if (ref) {
        if (ref.handle) name = ltypeName.get(ref.handle) ?? 'ByLayer';
        else if (ref.index === 32767 || ref.index < 0) name = ref.index === 32766 ? 'ByBlock' : 'ByLayer';
        else if (ltCtrl && ref.index < ltCtrl.entries.length) name = ltypeName.get(ltCtrl.entries[ref.index]) ?? 'ByLayer';
      }
      return { ...el, linetype: name };
    });
    objects.set(hex(h), rest);
  }

  // 3단계: 도형
  const parsed = new Map<number, ParsedEntity>();
  const maxEnt = opts.maxEntities ?? Infinity;
  let entCount = 0;
  for (const h of entityHandles) {
    progress();
    if (entCount >= maxEnt) {
      warn(warnings, 'dwg.entity_limit', `도형이 ${maxEnt}개를 넘어 나머지는 읽지 않았습니다.`);
      break;
    }
    const off = map.get(h)!;
    let t = typeOf.get(h)!;
    try {
      const oh = or.begin(off, h);
      t = oh.typeName;
      if (!oh.crcOk) crcBad[t] = (crcBad[t] ?? 0) + 1;
      const p = readEntity(or, names);
      // 모델이 일부만 담는 도형은 본문을 남긴다(같은 버전으로 쓸 때 되쓴다)
      if (p.entity && RAW_TYPES.has(p.entity.type)) {
        const raw = captureRaw(or, p.entity);
        if (raw) p.entity.dwgRaw = raw;
      }
      parsed.set(h, p);
      entCount++;
    } catch (e) {
      skip(t, h, e);
    }
  }
  {
    const n = Object.values(crcBad).reduce((a, b) => a + b, 0);
    if (n) warnings.push({ code: 'dwg.crc_mismatch', message: `객체 ${n}개의 CRC가 맞지 않습니다(내용은 그대로 읽었습니다).`, count: n, detail: { types: crcBad } });
  }

  // DSTYLE 재지정
  for (const p of parsed.values()) {
    const e = p.entity;
    if (e && (e.type === 'DIMENSION' || e.type === 'LEADER')) {
      const ov = parseDimOverrides(e.xdata);
      if (ov) e.overrides = ov;
    }
  }

  // LEADER 걸이선: DWG에는 걸이선 점이 없고 AutoCAD가 그릴 때(DXF로 쓸 때도) 덧붙인다.
  // 글 주석이 있고 마지막 선분이 수평에서 15°보다 기울면 화살촉 크기만큼의 수평선을 넣는다.
  for (const p of parsed.values()) {
    const e = p.entity;
    if (!e || e.type !== 'LEADER') continue;
    // R2010+는 글 상자 크기를 저장하지 않는다: 주석 MTEXT의 실제 범위로 채운다
    if (e.annotation && e.textHeight === 0 && e.textWidth === 0) {
      const ann = parsed.get(parseInt(e.annotation, 16));
      if (ann?.extents) {
        e.textHeight = ann.extents.height;
        e.textWidth = ann.extents.width;
      }
    }
    if (e.creation !== 0 || !e.annotation || e.vertices.length < 2) continue;
    const xd = e.horizontalDirection ?? { x: 1, y: 0, z: 0 };
    const n = e.vertices.length;
    const a = e.vertices[n - 2];
    const bpt = e.vertices[n - 1];
    const dx = bpt.x - a.x;
    const dy = bpt.y - a.y;
    const dz = bpt.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    const xl = Math.hypot(xd.x, xd.y, xd.z);
    if (len < 1e-12 || xl < 1e-12) continue;
    const cos = Math.abs((dx * xd.x + dy * xd.y + dz * xd.z) / (len * xl));
    if (cos >= Math.cos((15 * Math.PI) / 180)) continue;
    const ds = doc.dimStyles.get(tableKey(e.dimStyle));
    const ov = e.overrides ?? {};
    const asz = Number(ov[41] ?? ds?.vars.DIMASZ ?? 0.18);
    let sc = Number(ov[40] ?? ds?.vars.DIMSCALE ?? 1);
    if (!sc) sc = 1;
    const L = asz * sc;
    if (!(L > 0)) continue;
    const sgn = e.hooklineDirection ? 1 : -1;
    e.vertices.splice(n - 1, 0, { x: bpt.x + (sgn * L * xd.x) / xl, y: bpt.y + (sgn * L * xd.y) / xl, z: bpt.z + (sgn * L * xd.z) / xl });
    e.hookline = true;
  }

  // 4단계: 블록
  const used = new Set<number>();
  const childList = (p: ParsedEntity): number[] => {
    if (p.children) return p.children;
    const out: number[] = [];
    if (!p.firstChild) return out;
    let cur = p.firstChild;
    const seen = new Set<number>();
    for (let guard = 0; guard < 1000000 && cur && !seen.has(cur); guard++) {
      seen.add(cur);
      out.push(cur);
      if (cur === p.lastChild) break;
      const c = parsed.get(cur);
      if (!c) break;
      cur = c.next;
    }
    return out;
  };
  const attach = (p: ParsedEntity): void => {
    const e = p.entity;
    if (!e) return;
    if (e.type === 'INSERT') {
      for (const ch of childList(p)) {
        const c = parsed.get(ch);
        used.add(ch);
        if (c && c.entity && c.kind === 'attrib') e.attribs.push(c.entity as AttribEntity);
      }
    } else if (e.type === 'POLYLINE') {
      for (const ch of childList(p)) {
        const c = parsed.get(ch);
        used.add(ch);
        if (c && c.vertex) e.vertices.push(fixVertex(e, c.vertex));
      }
    }
    if (p.seqend) used.add(p.seqend);
  };

  const blockOrder = live(refs.blockControl, blockHeaders);
  let vpCounter = 0;
  for (const bh of blockOrder) {
    const rec = blockHeaders.get(bh)!;
    const blk = parsed.get(rec.blockEntity);
    vpCounter = 0;
    const def: BlockDef = {
      name: rec.name,
      handle: hex(rec.blockEntity),
      recordHandle: hex(bh),
      basePoint: rec.basePoint,
      // 모형·배치 공간 블록은 DXF처럼 플래그 0
      flags: /^\*(model|paper)_space/i.test(rec.name) ? 0 : rec.flags,
      entities: [],
    };
    if (rec.xrefPath) def.xrefPath = rec.xrefPath;
    if (rec.description) def.description = rec.description;
    if (blk?.layer) def.layer = blk.layer;
    if (rec.endBlk) def.endHandle = hex(rec.endBlk);
    used.add(rec.blockEntity);
    used.add(rec.endBlk);
    let list: number[];
    if (rec.owned) list = rec.owned;
    else {
      list = [];
      let cur = rec.firstEntity;
      const seen = new Set<number>();
      for (let guard = 0; guard < 10000000 && cur && !seen.has(cur); guard++) {
        seen.add(cur);
        list.push(cur);
        if (cur === rec.lastEntity) break;
        const p = parsed.get(cur);
        if (!p) {
          // 연결이 끊긴 곳: 핸들 순서로 다음 도형을 찾는다
          break;
        }
        cur = p.next;
      }
    }
    for (const h of list) {
      const p = parsed.get(h);
      if (!p) continue;
      used.add(h);
      if (p.kind !== 'entity' || !p.entity) continue;
      attach(p);
      if (p.entity.type === 'VIEWPORT') {
        // 배치마다 1부터(1 = 용지 전체 뷰포트). 상태(68)도 같은 쌓임 순서로 둔다
        const vp = p.entity as ViewportEntity;
        vp.id = ++vpCounter;
        vp.status = vp.id;
      }
      def.entities.push(p.entity);
    }
    doc.blocks.set(tableKey(rec.name), def);
    const br: BlockRecord = {
      name: rec.name,
      handle: hex(bh),
      flags: 0, // DXF BLOCK_RECORD에는 70 플래그가 없다(블록 플래그는 BlockDef.flags)
      insertUnits: rec.insertUnits,
      explodable: rec.explodable,
      scalable: rec.scalable,
    };
    if (rec.layout) br.layout = hex(rec.layout);
    applyRecordExtras(br, rec, names);
    doc.blockRecords.set(tableKey(rec.name), br);
  }

  // 블록 목록에 들지 않은 도형: 소유자 블록이 있으면 뒤에 붙인다
  let orphans = 0;
  const byHandle = new Map<number, BlockDef>();
  for (const bh of blockOrder) {
    const rec = blockHeaders.get(bh)!;
    const d = doc.blocks.get(tableKey(rec.name));
    if (d) byHandle.set(bh, d);
  }
  for (const [h, p] of parsed) {
    if (used.has(h) || p.kind !== 'entity' || !p.entity) continue;
    const d = byHandle.get(p.owner);
    if (d && sec.ver < R2004) {
      attach(p);
      d.entities.push(p.entity);
      used.add(h);
    } else orphans++;
  }
  if (orphans) warn(warnings, 'dwg.orphan_entities', `블록에 속하지 않은 도형 ${orphans}개를 버렸습니다.`, { count: orphans });

  // 배치
  for (const lr of layoutsRaw) {
    const bname = blockName.get(lr.blockRecord) ?? '';
    if (!bname) continue;
    const lay: Layout = {
      name: lr.name,
      handle: hex(lr.handle),
      tabOrder: lr.tabOrder,
      blockRecord: hex(lr.blockRecord),
      blockName: bname,
      flags: lr.flags,
      limitsMin: lr.limitsMin,
      limitsMax: lr.limitsMax,
      insertionBase: lr.insertionBase,
      extMin: lr.extMin,
      extMax: lr.extMax,
      elevation: lr.elevation,
      ucsOrigin: lr.ucsOrigin,
      ucsXAxis: lr.ucsXAxis,
      ucsYAxis: lr.ucsYAxis,
      plot: lr.plot,
    };
    if (lr.viewport) lay.viewport = hex(lr.viewport);
    doc.layouts.push(lay);
    const lo = { type: 'LAYOUT', handle: hex(lr.handle), owner: hex(lr.owner), layout: lay } as CadObject;
    if (lr.xdict) lo.xdict = hex(lr.xdict);
    if (lr.reactors.length) lo.reactors = lr.reactors.map(hex);
    objects.set(hex(lr.handle), lo);
  }

  // 배치 블록의 도형은 DXF처럼 종이 공간(67)으로 표시한다
  for (const lay of doc.layouts) {
    if (tableKey(lay.blockName) === '*MODEL_SPACE') continue;
    const blk = doc.blocks.get(tableKey(lay.blockName));
    if (blk) {
      for (const e of blk.entities) {
        e.paperSpace = true;
        if (e.type === 'INSERT') for (const a of e.attribs) a.paperSpace = true;
      }
    }
  }
  // 비도형 객체의 확장 자료
  for (const [h, eed] of objEed) {
    const o = objects.get(hex(h));
    if (o && !o.xdata) {
      const xd = xdataFromEed(eed, names);
      if (xd) o.xdata = xd;
    }
  }
  doc.objects = objects;
  // 표 머리(제어 객체): DWG로 다시 쓸 때 핸들·확장 사전을 잇는다
  {
    const heads = new Map<string, { handle: string; xdict?: string; reactors?: string[]; xdata?: ReturnType<typeof xdataFromEed> }>();
    const pairs: [string, number][] = [
      ['BLOCK_RECORD', refs.blockControl],
      ['LAYER', refs.layerControl],
      ['STYLE', refs.styleControl],
      ['LTYPE', refs.ltypeControl],
      ['VIEW', refs.viewControl],
      ['UCS', refs.ucsControl],
      ['VPORT', refs.vportControl],
      ['APPID', refs.appidControl],
      ['DIMSTYLE', refs.dimstyleControl],
    ];
    for (const [name, h] of pairs) {
      const m = controlMeta.get(h);
      if (!m) continue;
      const head: { handle: string; xdict?: string; reactors?: string[]; xdata?: ReturnType<typeof xdataFromEed> } = { handle: hex(h) };
      if (m.xdict) head.xdict = hex(m.xdict);
      if (m.reactors.length) head.reactors = m.reactors.map(hex);
      const xd = xdataFromEed(m.eed, names);
      if (xd) head.xdata = xd;
      heads.set(name, head);
    }
    if (heads.size) doc.tableHeads = heads as CadDocument['tableHeads'];
  }
  if (refs.namedObjDict) doc.rootDictionary = hex(refs.namedObjDict);

  // 헤더 변수
  fillHeader(doc, sec, header, { layerName, ltypeName, styleName, dimstyleName, blockName, mlsName, ucsName: new Map([...ucss].map(([h, u]) => [h, u.name])) });

  {
    const n = Object.values(skipped).reduce((a, b) => a + b, 0);
    if (n) warnings.push({ code: 'dwg.object_skipped', message: `객체 ${n}개를 읽지 못해 건너뛰었습니다.`, count: n, detail: { types: skipped, samples: skipSamples } });
  }
  opts.onProgress?.(0.95);
  finalizeDocument(doc);
  opts.onProgress?.(1);
  return doc;
}

/** 표 레코드 확장 자료·확장 사전 */
function applyRecordExtras(target: { xdata?: TableRecordBase['xdata']; xdict?: string }, rec: RecordCommon & { eed?: unknown }, names: Names): void {
  const eed = (rec as { eed?: Parameters<typeof xdataFromEed>[0] }).eed;
  const xd = xdataFromEed(eed ?? null, names);
  if (xd) target.xdata = xd;
  if (rec.xdict) target.xdict = hex(rec.xdict);
}

function withXData<T extends RecordCommon>(rec: T, or: ObjectReader): T {
  (rec as T & { eed?: unknown }).eed = or.h.eed;
  return rec;
}

/** 도면층 투명도(확장 자료 AcCmTransparency) */
function layerTransparency(xdata: NonNullable<Layer['xdata']>): number | undefined {
  const x = xdata.find((d) => d.app.toUpperCase() === 'ACCMTRANSPARENCY');
  const v = x?.items.find((i) => i.code === 1071)?.value;
  if (typeof v !== 'number') return undefined;
  const kind = (v >>> 24) & 0xff;
  if (kind >= 2) return v & 0xff;
  return undefined;
}

/** 2D 폴리선 정점의 Z는 폴리선 고도 */
function fixVertex(e: PolylineEntity, v: PolylineEntity['vertices'][number]): PolylineEntity['vertices'][number] {
  if (e.kind === '2d' && v.location.z === 0 && e.elevation) return { ...v, location: { ...v.location, z: e.elevation } };
  return v;
}

interface HeaderNames {
  layerName: Map<number, string>;
  ltypeName: Map<number, string>;
  styleName: Map<number, string>;
  dimstyleName: Map<number, string>;
  blockName: Map<number, string>;
  mlsName: Map<number, string>;
  ucsName: Map<number, string>;
}

function fillHeader(doc: CadDocument, sec: DwgSections, header: ReturnType<typeof readHeader>, n: HeaderNames): void {
  const hv = doc.header;
  hv.set('$ACADVER', doc.version);
  hv.set('$DWGCODEPAGE', doc.codepage);
  for (const [k, v] of header.vars) hv.set(k, v as HeaderValue);
  const name = (m: Map<number, string>, k: string, def = '') => {
    const h = header.handleVars.get(k);
    if (h === undefined) return;
    hv.set(k, m.get(h) ?? def);
  };
  name(n.layerName, '$CLAYER', '0');
  name(n.styleName, '$TEXTSTYLE', 'Standard');
  {
    const h = header.handleVars.get('$CELTYPE');
    if (h !== undefined) hv.set('$CELTYPE', n.ltypeName.get(h) ?? 'ByLayer');
  }
  name(n.dimstyleName, '$DIMSTYLE', 'Standard');
  // 다중선 스타일 이름은 ACAD_MLINESTYLE 사전의 항목 이름(객체 이름은 대문자일 수 있다)
  {
    const h = header.handleVars.get('$CMLSTYLE');
    if (h !== undefined) {
      const dict = doc.objects.get(hex(header.refs.mlineStyleDict));
      let nm: string | undefined;
      if (dict && dict.type === 'DICTIONARY') {
        for (const [k, v] of (dict as DictionaryObject).entries) if (v === hex(h)) nm = k;
      }
      hv.set('$CMLSTYLE', nm ?? n.mlsName.get(h) ?? 'Standard');
    }
  }
  for (const k of ['$UCSNAME', '$PUCSNAME', '$UCSBASE', '$PUCSBASE', '$UCSORTHOREF', '$PUCSORTHOREF']) name(n.ucsName, k);
  name(n.styleName, '$DIMTXSTY', 'Standard');
  // 화살촉 블록 이름은 DXF 헤더처럼 앞의 밑줄을 뺀다(_BoxBlank → BoxBlank)
  for (const k of ['$DIMBLK', '$DIMBLK1', '$DIMBLK2', '$DIMLDRBLK']) {
    name(n.blockName, k);
    const v = hv.get(k);
    if (typeof v === 'string' && v.startsWith('_')) hv.set(k, v.slice(1));
  }
  for (const k of ['$DIMLTYPE', '$DIMLTEX1', '$DIMLTEX2']) name(n.ltypeName, k);
  hv.delete('$_CVPORT_ENT');
  // AcDb:SummaryInfo(R2004+): 제목·주제·작성자·키워드·설명·마지막 저장한 사람 … (길이 + 문자열)
  const si = sec.summaryInfo;
  if (si && si.length > 2) {
    try {
      const wide = sec.ver >= R2007;
      let p = 0;
      const next = (): string => {
        const n = si[p] | (si[p + 1] << 8);
        p += 2;
        let out = '';
        if (wide) {
          for (let i = 0; i < n; i++, p += 2) {
            const c = si[p] | (si[p + 1] << 8);
            if (c) out += String.fromCharCode(c);
          }
        } else {
          let e = p;
          while (e < p + n && si[e]) e++;
          out = decoderFor(codepageToEncoding(doc.codepage)).decode(si.subarray(p, e));
          p += n;
        }
        if (p > si.length) throw new RangeError('summary');
        return out;
      };
      for (let i = 0; i < 5; i++) next();
      const lastSavedBy = next();
      if (lastSavedBy) hv.set('$LASTSAVEDBY', lastSavedBy);
    } catch {
      // 선택 정보
    }
  }
  // MEASUREMENT: AcDb:Template(R2004+) 또는 R2000 이하 다섯째 위치 자료
  const t = sec.template;
  if (t && t.length >= 4) {
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    // 설명 문자열 길이(R2007+는 UTF-16 글자 수) 뒤에 MEASUREMENT
    const n0 = dv.getInt16(0, true) * (sec.ver >= R2007 ? 2 : 1);
    let m: number | undefined;
    if (n0 >= 0 && 2 + n0 + 2 <= t.length) m = dv.getUint16(2 + n0, true);
    if (m === 0 || m === 1) hv.set('$MEASUREMENT', m);
  }
}
