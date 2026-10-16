/**
 * 장면 빌더: 공간(모형·배치 블록)의 객체를 표시 목록으로 바꾼다.
 * 블록 참조는 펼치고(중첩 16단계까지), 도면층 0·ByBlock 상속, 선종류, 문자, 해치를 처리한다.
 */
import type {
  BlockDef,
  CadColor,
  CadDocument,
  DictionaryObject,
  DimStyle,
  DimensionEntity,
  Entity,
  HatchEntity,
  InsertEntity,
  LeaderEntity,
  Linetype,
  MLeaderEntity,
  MLineEntity,
  MLineStyleObject,
  SortEntsTableObject,
  SpatialFilterObject,
  TextEntity,
  TextStyle,
  UnderlayDefObject,
  UnderlayEntity,
  UnknownEntity,
  Vec2,
  Vec3,
} from '../core/model';
import { BYBLOCK, BYLAYER, normalizeHandle, tableKey } from '../core/model';
import { lwCount } from '../core/lwpoly';
import { DIM_VAR_CODES, DIM_VAR_DEFAULTS } from '../core/dimvars';
import { ACI_RGB } from '../core/color';
import { type FrameKind, frameSetting } from '../core/framevars';
import {
  type Mat,
  apply,
  applyDir,
  applyXY,
  identity,
  mat,
  multiply,
  multiplyInto,
  ocsMatrix,
  planarScale,
  rotationZ,
  scaling,
  setRotationZ,
  setScaling,
  setTranslation,
  translation,
  withOcs,
} from '../geom/matrix';
import { TAU, arcPoints, bulgePoints, ccwSweep, interpolateFitPoints, nurbsPoints } from '../geom/curves';
import { type DashPattern, dashPolyline } from './linetype';
import { DisplayListBuilder, type DisplayList, type SnapshotView, clipConvex } from './displaylist';
import { ColorKind, type LayerState, type StyleSpec, STYLE_FLAG_FIELD, STYLE_FLAG_NO_PLOT, StyleTable, WidthKind, hiddenStyleSpec, layerStates, plotStyleNames } from './styles';
import { HATCH_LINE_LIMIT, hatchLoops, patternSegments, triangulateLoops, userPattern } from './hatch';
import { builtinArrow } from './arrows';
import { boundaryEdges, contourSegments, openRing, stripOutline, textLineBoxes } from './fillmode';
import { type Affine, type TextEngine, type TextLayout, affMul } from '../text/layout';
import { type ShxFont, ShxRunner } from '../text/shx';
import { parseProxyGraphics } from './proxy';
import { arcTextDrawParts, arcTextUseProxy } from './arctext';
import { codepageToEncoding, decoderFor } from '../core/codepage';
import { mlineDrawing } from '../edit/mline/draw';
import { toleranceLayout } from '../edit/annot/tolerance';
import { breakRuns } from '../edit/annot/mleader';
import { type AnnoDisplay, annoDisplayFor } from '../edit/annoscale/view';

export interface BuildOptions {
  text: TextEngine;
  /** 파일이 연결된 래스터 이미지 열쇠(imageKey) */
  images?: ReadonlySet<string>;
  /** 선종류 축척에 곱할 값(PSLTSCALE: 배치 뷰포트에서 무늬를 종이 단위로 맞출 때 1 / 뷰포트 축척) */
  ltFactor?: number;
  /** 파일이 연결된 PDF 페이지(pdfUnderlayKey → 페이지 폭·높이, 인치) */
  pdfPages?: ReadonlyMap<string, readonly [number, number]>;
  /** 숨긴 최상위 객체(HIDEOBJECTS·ISOLATEOBJECTS) */
  hidden?: ReadonlySet<string>;
  /** 곡선 정밀도(도면 단위). 없으면 도면 범위로 정한다 */
  tolerance?: number;
  /** 해치 무늬 선 상한 */
  hatchLineLimit?: number;
  /** 주석 축척 이름(주석 객체를 그 축척의 표현으로 그린다). 없으면 공간에 맞게(모형 CANNOSCALE, 배치 1:1), null이면 고르지 않는다 */
  annoScale?: string | null;
  /** ANNOALLVISIBLE(0이면 그 축척을 지원하지 않는 주석 객체를 숨긴다). 없으면 그 탭의 값 */
  annoAllVisible?: boolean;
  /** 장면 만들기 진행률(0~1, 최상위 객체 기준으로 약 50번) */
  onProgress?: (fraction: number) => void;
  /** 객체 상자를 형식 배열(list.packed)로만 만든다(워커 → 메인 전송용, list.entities는 빈 배열) */
  packBoxes?: boolean;
  /**
   * 점진 빌드: 만드는 동안 지금까지 마감한 객체의 그림을 미리 보기 조각으로 넘긴다(처음 약 0.25초, 그 뒤 약 1초마다, 끝에 한 번 더).
   * 조각은 묶음 하나(좌표는 partialView.origin 기준)라 화면이 바로 그릴 수 있다. 최종 표시 목록은 넘기지 않을 때와 같다.
   */
  onPartial?: (part: PartialScene) => void;
  /** 미리 보기 화면: 조각 좌표 원점(보통 첫 화면 가운데)과, 있으면 보이지 않을 것을 뺄 범위·배율 */
  partialView?: PartialView;
  /** 조각 사이 시간(ms, 시험용 — 기본은 처음 250, 그 뒤 1000) */
  partialInterval?: number;
}

export interface PartialView extends SnapshotView {
  origin: readonly [number, number];
}

/** 점진 빌드의 미리 보기 조각(화면에 먼저 그리는 그림) */
export interface PartialScene {
  /** 묶음 하나와 글리프(객체 상자 없음) */
  list: DisplayList;
  /** 지금까지의 스타일 표(조각마다 처음부터 — 뒤 조각일수록 길다) */
  styles: StyleSpec[];
  layers: LayerState[];
}

export interface SpaceScene {
  list: DisplayList;
  styles: StyleTable;
  layers: LayerState[];
  layerIndex: Map<string, number>;
  warnings: { code: string; count: number; detail?: Record<string, unknown> }[];
  /** 주석 객체 수(배치 뷰포트마다 다른 축척의 장면이 필요한지 가린다) */
  annotative?: number;
}

interface ColorSpec {
  kind: ColorKind;
  value: number;
}

interface Ctx {
  m: Mat;
  /** 도면층 0 객체가 따를 도면층(블록 참조의 도면층) */
  layer: number | null;
  byColor: ColorSpec;
  byLinetype: string;
  byLineweight: { kind: WidthKind; value: number };
  byAlpha: number;
  freeze: number[];
  depth: number;
  chain: string[];
  /** 치수 블록 안: 객체 자신의 OCS를 쓰지 않는다 */
  dimBlock: boolean;
  /** 블록 안의 ATTDEF는 그리지 않는다(상수 속성 제외) */
  inBlock: boolean;
  z0: number;
  z1: number;
}

interface Resolved {
  style: number;
  linetype: string;
  ltscale: number;
  layer: number;
}

const MAX_DEPTH = 16;

export class SceneBuilder {
  readonly styles = new StyleTable();
  readonly layers: LayerState[];
  readonly layerIndex: Map<string, number>;
  private out!: DisplayListBuilder;
  private tol = 0.01;
  private ltscale = 1;
  private readonly warn = new Map<string, number>();
  private readonly sortCache = new Map<string, Entity[]>();
  private readonly styleByHandle = new Map<string, TextStyle>();
  private readonly mlineStyles = new Map<string, MLineStyleObject>();
  private readonly blockByRecord = new Map<string, BlockDef>();
  private pdmode = 0;
  private pdsize = 0;
  /** 이름 있는 플롯 스타일 핸들 → 이름 */
  private readonly plotStyleNames: Map<string, string>;
  /** ATTDISP: 0 모두 숨김, 1 보통(숨김 속성은 숨김), 2 모두 보임 */
  private attmode = 1;
  private fill = true;
  /** QTEXTMODE: 문자를 테두리 사각형으로 */
  private qtext = false;
  /** TEXTFILL: 윤곽 글꼴 문자를 채운다(0이면 윤곽선, FILLMODE 0도 윤곽선) */
  private textFill = true;
  /** 윤곽 글꼴 글자의 윤곽선 선분(채우기를 끈 그리기용) */
  private readonly glyphOutlines = new WeakMap<object, Float32Array>();
  private extentSize = 100;
  /** 임시 행렬(블록 참조·여러 줄 문자의 변환을 만들 때만 잠깐 쓴다 — 재귀 호출 전에 다 쓴다) */
  private readonly scratch: Mat[] = Array.from({ length: 6 }, () => new Float64Array(12));

  constructor(
    private readonly doc: CadDocument,
    private readonly opt: BuildOptions,
  ) {
    // 스타일 0번은 숨김(편집할 때 옛 그림을 가리는 데 쓴다)
    this.styles.intern(hiddenStyleSpec());
    const ls = layerStates(doc);
    this.layers = ls.states;
    this.layerIndex = ls.indexOf;
    for (const s of doc.textStyles.values()) if (s.handle) this.styleByHandle.set(s.handle, s);
    for (const o of doc.objects.values()) if (o.type === 'MLINESTYLE') {
      const ms = o as MLineStyleObject;
      this.mlineStyles.set(ms.handle, ms);
      this.mlineStyles.set('NAME:' + tableKey(ms.name), ms);
    }
    for (const b of doc.blocks.values()) if (b.recordHandle) this.blockByRecord.set(b.recordHandle, b);
    for (const r of doc.blockRecords.values()) {
      const b = doc.blocks.get(tableKey(r.name));
      if (b && r.handle) this.blockByRecord.set(r.handle, b);
    }
    const num = (k: string, d: number) => {
      const v = doc.header.get(k);
      return typeof v === 'number' && Number.isFinite(v) ? v : d;
    };
    this.ltscale = (num('$LTSCALE', 1) || 1) * (opt.ltFactor && opt.ltFactor > 0 ? opt.ltFactor : 1);
    this.plotStyleNames = plotStyleNames(doc);
    this.pdmode = num('$PDMODE', 0);
    this.attmode = num('$ATTMODE', 1);
    this.pdsize = num('$PDSIZE', 0);
    this.fill = num('$FILLMODE', 1) !== 0;
    this.qtext = num('$QTEXTMODE', 0) !== 0;
    this.textFill = num('$TEXTFILL', 1) !== 0;
  }

  private warnInc(code: string, n = 1): void {
    this.warn.set(code, (this.warn.get(code) ?? 0) + n);
  }

  /** 원래 이름 → 도면층 번호(대문자로 바꾸는 일을 객체마다 하지 않게) */
  private readonly layerByName = new Map<string, number>();

  private layerOf(name: string): number {
    const hit = this.layerByName.get(name);
    if (hit !== undefined) return hit;
    const i = this.layerIndex.get(tableKey(name));
    if (i !== undefined) {
      this.layerByName.set(name, i);
      return i;
    }
    // 정의되지 않은 도면층: 새로 만든다(색 7, 켜짐)
    const idx = this.layers.length;
    this.layers.push({ name, rgb: 0, aci: 7, hasRgb: false, on: true, frozen: false, lineweight: -3, transparency: 255, plot: true });
    this.layerIndex.set(tableKey(name), idx);
    return idx;
  }

  // -------------------------------------------------------------------------
  // 특성 해석
  // -------------------------------------------------------------------------

  private effLayer(e: { layer: string }, ctx: Ctx): number {
    if (ctx.layer !== null && e.layer === '0') return ctx.layer;
    return this.layerOf(e.layer);
  }

  private colorSpec(c: CadColor, layer: number, ctx: Ctx): ColorSpec {
    if (c.rgb !== undefined && c.aci !== BYBLOCK && c.aci !== BYLAYER) return { kind: ColorKind.Rgb, value: c.rgb };
    if (c.rgb !== undefined && c.aci === BYLAYER && c.rgb !== 0) return { kind: ColorKind.Rgb, value: c.rgb };
    if (c.aci === BYLAYER || c.aci === 257) return { kind: ColorKind.Layer, value: layer };
    if (c.aci === BYBLOCK) return ctx.byColor;
    return { kind: ColorKind.Aci, value: c.aci };
  }

  /**
   * 자주 쓰는 스타일 캐시: 도면층 번호 → 색 값 → (색 종류·선 굵기·투명도) → 스타일 번호.
   * 동결 목록·플롯 스타일·표지가 없는 경우(대부분의 객체)에만 쓴다. intern 열쇠 문자열을 객체마다 만들지 않는다.
   */
  private readonly fastStyles: (Map<number, Map<number, number>> | undefined)[] = [];
  /** 동결 목록(블록 참조 도면층 사슬)을 하나로 모은다: 부모 목록 → 도면층 → 자식 목록. 같은 사슬이면 같은 배열이다 */
  private readonly freezeChild = new Map<readonly number[], Map<number, number[]>>();
  /** 모은 동결 목록 → 번호(빠른 스타일 캐시 열쇠, 빈 목록은 0) */
  private readonly freezeIds = new Map<readonly number[], number>();
  /** 동결 목록 번호별 빠른 스타일 캐시(0은 fastStyles) */
  private readonly fastStylesFrozen: (Map<number, Map<number, number>> | undefined)[][] = [];

  private freezeWith(parent: number[], layer: number): number[] {
    if (parent.includes(layer)) return parent;
    let byLayer = this.freezeChild.get(parent);
    if (!byLayer) this.freezeChild.set(parent, (byLayer = new Map()));
    let child = byLayer.get(layer);
    if (!child) {
      child = [...parent, layer];
      byLayer.set(layer, child);
      this.freezeIds.set(child, this.freezeIds.size + 1);
    }
    return child;
  }
  /** 도면층 번호 → ByLayer 선종류 */
  private readonly layerLinetypes: (string | undefined)[] = [];

  private layerLinetype(layer: number): string {
    let lt = this.layerLinetypes[layer];
    if (lt === undefined) {
      lt = this.layers[layer] ? (this.doc.layers.get(tableKey(this.layers[layer]!.name))?.linetype ?? 'Continuous') : 'Continuous';
      this.layerLinetypes[layer] = lt;
    }
    return lt;
  }

  private resolve(e: Entity | { layer: string; color: CadColor; linetype: string; lineweight: number; ltscale: number; transparency: number }, ctx: Ctx, override?: { color?: CadColor; flags?: number }): Resolved {
    const layer = this.effLayer(e, ctx);
    // 색(colorSpec과 같은 규칙, 객체를 만들지 않는다)
    const c = override?.color ?? e.color;
    let ck: ColorKind;
    let cv: number;
    if (c.rgb !== undefined && c.aci !== BYBLOCK && c.aci !== BYLAYER) {
      ck = ColorKind.Rgb;
      cv = c.rgb;
    } else if (c.rgb !== undefined && c.aci === BYLAYER && c.rgb !== 0) {
      ck = ColorKind.Rgb;
      cv = c.rgb;
    } else if (c.aci === BYLAYER || c.aci === 257) {
      ck = ColorKind.Layer;
      cv = layer;
    } else if (c.aci === BYBLOCK) {
      ck = ctx.byColor.kind;
      cv = ctx.byColor.value;
    } else {
      ck = ColorKind.Aci;
      cv = c.aci;
    }
    let wk: WidthKind;
    let wv: number;
    if (e.lineweight === -1) {
      wk = WidthKind.Layer;
      wv = layer;
    } else if (e.lineweight === -2) {
      wk = ctx.byLineweight.kind;
      wv = ctx.byLineweight.value;
    } else if (e.lineweight === -3 || e.lineweight < 0) {
      wk = WidthKind.Default;
      wv = 0;
    } else {
      wk = WidthKind.Value;
      wv = e.lineweight;
    }
    let alpha = e.transparency;
    if (alpha === -2) alpha = ctx.byAlpha;
    let lt = e.linetype || 'ByLayer';
    if (lt === 'ByLayer') lt = this.layerLinetype(layer);
    else {
      const ltu = lt.toUpperCase();
      if (ltu === 'BYLAYER') lt = this.layerLinetype(layer);
      else if (ltu === 'BYBLOCK') lt = ctx.byLinetype;
    }
    const ps = (e as { plotStyle?: string }).plotStyle;
    const flags = override?.flags ?? 0;
    // 빠른 길: 열쇠 = 색 값(Map) + [색 종류 3비트 | 굵기 종류 2비트 | 투명도+2 9비트 | 굵기 값 15비트]
    let inner: Map<number, number> | undefined;
    let k2 = -1;
    const fid = ctx.freeze.length === 0 ? 0 : this.freezeIds.get(ctx.freeze);
    if (
      !ps &&
      flags === 0 &&
      fid !== undefined &&
      Number.isInteger(cv) &&
      Number.isInteger(wv) &&
      wv >= 0 &&
      wv < 32768 &&
      Number.isInteger(alpha) &&
      alpha >= -2 &&
      alpha < 510
    ) {
      k2 = ck + wk * 8 + (alpha + 2) * 32 + wv * 16384;
      const table = fid === 0 ? this.fastStyles : (this.fastStylesFrozen[fid] ??= []);
      let byColor = table[layer];
      if (!byColor) table[layer] = byColor = new Map();
      inner = byColor.get(cv);
      if (!inner) byColor.set(cv, (inner = new Map()));
      const hit = inner.get(k2);
      if (hit !== undefined) return { style: hit, linetype: lt, ltscale: (e.ltscale || 1) * this.ltscale, layer };
    }
    const style = this.styles.intern({
      colorKind: ck,
      color: cv,
      layer,
      freezeLayers: ctx.freeze,
      widthKind: wk,
      width: wv,
      alpha,
      flags,
      plotStyle: ps ? this.plotStyleNames.get(ps) : undefined,
    });
    if (inner) inner.set(k2, style);
    return { style, linetype: lt, ltscale: (e.ltscale || 1) * this.ltscale, layer };
  }

  private styleWithColor(base: Resolved, c: CadColor | null, ctx: Ctx): number {
    if (!c) return base.style;
    const spec = this.styles.specs[base.style]!;
    const col = this.colorSpec(c, base.layer, { ...ctx, byColor: { kind: spec.colorKind, value: spec.color } });
    return this.styles.intern({ ...spec, colorKind: col.kind, color: col.value });
  }

  private backgroundStyle(base: Resolved): number {
    const spec = this.styles.specs[base.style]!;
    return this.styles.intern({ ...spec, colorKind: ColorKind.Background, color: 0 });
  }

  private frames: Partial<Record<FrameKind, number>> = {};
  /** IMAGEFRAME·WIPEOUTFRAME(한 번만 찾는다) */
  private frame(kind: FrameKind): number {
    return (this.frames[kind] ??= frameSetting(this.doc, kind));
  }

  /** 필드가 든 문자(이 앱의 OPENCAD_FIELD 확장 자료, AutoCAD의 확장 사전 ACAD_FIELD) */
  private hasField(e: Entity): boolean {
    if (e.xdata?.some((x) => x.app.toUpperCase() === 'OPENCAD_FIELD')) return true;
    if (!e.xdict) return false;
    const d = this.doc.objects.get(e.xdict);
    return d?.type === 'DICTIONARY' && [...(d as DictionaryObject).entries.keys()].some((k) => k.toUpperCase() === 'ACAD_FIELD');
  }

  /** 필드 회색 배경(FIELDDISPLAY): 문자 범위 뒤에, 화면에만 */
  private fieldBackground(e: Entity, lay: TextLayout, world: Affine, r: Resolved): void {
    if (!this.hasField(e) || !(lay.maxX > lay.minX) || !(lay.maxY > lay.minY)) return;
    const pad = (lay.maxY - lay.minY) * 0.08;
    const [x0, y0, x1, y1] = [lay.minX - pad, lay.minY - pad, lay.maxX + pad, lay.maxY + pad];
    const q = [x0, y0, x1, y0, x1, y1, x0, y1];
    const w: number[] = [];
    for (let i = 0; i < 8; i += 2) w.push(world[0] * q[i]! + world[2] * q[i + 1]! + world[4], world[1] * q[i]! + world[3] * q[i + 1]! + world[5]);
    const spec = this.styles.specs[r.style]!;
    const st = this.styles.intern({ ...spec, colorKind: ColorKind.Rgb, color: 0x808080, alpha: 110, flags: spec.flags | STYLE_FLAG_FIELD | STYLE_FLAG_NO_PLOT });
    this.out.triangle(w[0]!, w[1]!, w[2]!, w[3]!, w[4]!, w[5]!, st);
    this.out.triangle(w[0]!, w[1]!, w[4]!, w[5]!, w[6]!, w[7]!, st);
  }

  /** 화면에는 보이고 출력에서는 빠지는 스타일(IMAGEFRAME·WIPEOUTFRAME 2) */
  private noPlotStyle(style: number): number {
    const spec = this.styles.specs[style]!;
    return this.styles.intern({ ...spec, flags: spec.flags | STYLE_FLAG_NO_PLOT });
  }

  private patternCache = new Map<string, DashPattern | null>();

  private pattern(lt: string, scale: number): DashPattern | null {
    if (lt === 'Continuous') return null;
    const key = lt.toUpperCase();
    if (key === 'CONTINUOUS' || key === 'BYLAYER' || key === 'BYBLOCK' || !key) return null;
    let base = this.patternCache.get(key);
    if (base === undefined) {
      const def: Linetype | undefined = this.doc.linetypes.get(key);
      if (!def || !def.elements.length || !(def.patternLength > 0)) base = null;
      else {
        const texts: NonNullable<DashPattern['texts']> = [];
        let at = 0;
        for (const el of def.elements) {
          if (el.flags & 2 && el.text) {
            const st = el.styleHandle ? this.styleByHandle.get(el.styleHandle) : undefined;
            texts.push({ at, text: el.text, style: st?.name, scale: el.scale, rotation: el.rotation, absolute: (el.flags & 1) !== 0, dx: el.offset.x, dy: el.offset.y });
          } else if (el.flags & 4 && el.shapeNumber) {
            // 도형 요소: 문자 스타일의 글꼴이 도형 파일(예: ltypeshp.shx)
            const st = el.styleHandle ? this.styleByHandle.get(el.styleHandle) : undefined;
            if (st?.font) texts.push({ at, text: '', scale: el.scale, rotation: el.rotation, absolute: (el.flags & 1) !== 0, dx: el.offset.x, dy: el.offset.y, shape: { file: st.font, num: el.shapeNumber } });
          }
          at += Math.abs(el.length);
        }
        base = { dashes: def.elements.map((e) => e.length), period: def.elements.reduce((a, e) => a + Math.abs(e.length), 0), texts: texts.length ? texts : undefined };
      }
      this.patternCache.set(key, base);
    }
    if (!base) return null;
    if (scale === 1) return base;
    return {
      dashes: base.dashes.map((d) => d * scale),
      period: base.period * scale,
      texts: base.texts?.map((t) => ({ ...t, at: t.at * scale, scale: t.scale * scale, dx: t.dx * scale, dy: t.dy * scale })),
    };
  }

  // -------------------------------------------------------------------------
  // 내보내기 도우미
  // -------------------------------------------------------------------------

  /** 월드 꺾은선(선종류 적용) */
  private stroke(pts: number[], closed: boolean, r: Resolved, ctx: Ctx, lsScale = 1): void {
    const n = pts.length >> 1;
    if (n === 0) return;
    if (n === 1) {
      this.out.segment(pts[0]!, pts[1]!, pts[0]!, pts[1]!, r.style);
      return;
    }
    const pat = this.pattern(r.linetype, r.ltscale * lsScale * planarScale(ctx.m));
    if (!pat) {
      this.out.polyline(pts, closed, r.style);
      return;
    }
    this.out.dashed = true;
    dashPolyline(
      pts,
      closed,
      pat,
      (x0, y0, x1, y1) => this.out.segment(x0, y0, x1, y1, r.style),
      (x, y, ang, t) => {
        if (t.shape) {
          // 복합 선종류 도형(SHX를 불러왔을 때만)
          const a = t.absolute ? t.rotation : ang + t.rotation;
          const c = Math.cos(ang);
          const s = Math.sin(ang);
          this.emitShape(t.shape.file, t.shape.num, t.scale, 1, 0, a, x + c * t.dx - s * t.dy, y + s * t.dx + c * t.dy, r);
          return;
        }
        // 복합 선종류 문자
        const st = t.style ? this.doc.textStyles.get(tableKey(t.style)) : undefined;
        const lay = this.opt.text.layoutText({
          text: t.text,
          insert: { x: 0, y: 0 },
          height: t.scale,
          rotation: 0,
          widthFactor: st?.widthFactor ?? 1,
          oblique: 0,
          generation: 0,
          halign: 0,
          valign: 0,
          style: st,
        });
        const a = t.absolute ? t.rotation : ang + t.rotation;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const px = x + c * t.dx - s * t.dy;
        const py = y + s * t.dx + c * t.dy;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        this.emitText(lay, [ca, sa, -sa, ca, px, py], r, ctx);
      },
    );
  }

  /** 프록시 그림(ODA 명세 29장)으로 그리기. 그린 것이 있으면 true */
  private proxy(e: UnknownEntity, ctx: Ctx): boolean {
    const dec = decoderFor(codepageToEncoding(this.doc.codepage || 'ANSI_1252'));
    const parsed = parseProxyGraphics(e.graphics!, (b) => dec.decode(b));
    if (!parsed.prims.some((p) => p.k !== 'color' && p.k !== 'rgb' && p.k !== 'lineweight' && p.k !== 'fill')) return false;
    const base = this.resolve(e, ctx);
    let r = base;
    const stack: Mat[] = [ctx.m];
    const top = () => stack[stack.length - 1]!;
    const tol = this.localTol(ctx.m);
    // 평면 법선 n의 두 축
    const axes = (n: [number, number, number]) => {
      const o = ocsMatrix({ x: n[0], y: n[1], z: n[2] });
      const u = o ? { x: o[0]!, y: o[4]!, z: o[8]! } : { x: 1, y: 0, z: 0 };
      const v = o ? { x: o[1]!, y: o[5]!, z: o[9]! } : { x: 0, y: 1, z: 0 };
      return { u, v };
    };
    const ring = (c: [number, number, number], r0: number, u: Vec3, v: Vec3, a0: number, sweep: number): number[] => {
      const n = Math.max(8, Math.min(720, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r0, 1e-12)))))));
      const out: number[] = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + (sweep * i) / n;
        const ca = Math.cos(a) * r0;
        const sa = Math.sin(a) * r0;
        const q = applyXY(top(), c[0] + ca * u.x + sa * v.x, c[1] + ca * u.y + sa * v.y, c[2] + ca * u.z + sa * v.z);
        out.push(q.x, q.y);
      }
      return out;
    };
    let drew = false;
    for (const p of parsed.prims) {
      switch (p.k) {
        case 'poly': {
          const pts: number[] = [];
          for (let i = 0; i + 2 < p.pts.length; i += 3) {
            const q = applyXY(top(), p.pts[i]!, p.pts[i + 1]!, p.pts[i + 2]!);
            pts.push(q.x, q.y);
          }
          if (p.fill && pts.length >= 6 && this.fill) this.out.triangles(triangulateLoops([pts]), r.style);
          else this.stroke(pts, p.closed || (p.fill && pts.length >= 6), r, ctx);
          drew = true;
          break;
        }
        case 'circle': {
          const { u, v } = axes(p.n);
          this.stroke(ring(p.c, p.r, u, v, 0, Math.PI * 2), true, r, ctx);
          drew = true;
          break;
        }
        case 'arc': {
          const { u, v } = axes(p.n);
          // 시작 방향을 평면 축으로 나타낸 각도
          const a0 = Math.atan2(p.start[0] * v.x + p.start[1] * v.y + p.start[2] * v.z, p.start[0] * u.x + p.start[1] * u.y + p.start[2] * u.z);
          this.stroke(ring(p.c, p.r, u, v, a0, p.sweep), false, r, ctx);
          drew = true;
          break;
        }
        case 'arc3':
        case 'circle3': {
          const [a, b, c] = p.p as [[number, number, number], [number, number, number], [number, number, number]];
          const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
          if (Math.abs(d) < 1e-15) break;
          const a2 = a[0] ** 2 + a[1] ** 2;
          const b2 = b[0] ** 2 + b[1] ** 2;
          const c2 = c[0] ** 2 + c[1] ** 2;
          const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
          const cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
          const rr = Math.hypot(a[0] - cx, a[1] - cy);
          const u = { x: 1, y: 0, z: 0 };
          const v = { x: 0, y: 1, z: 0 };
          if (p.k === 'circle3') this.stroke(ring([cx, cy, a[2]], rr, u, v, 0, Math.PI * 2), true, r, ctx);
          else {
            const t0 = Math.atan2(a[1] - cy, a[0] - cx);
            const tm = Math.atan2(b[1] - cy, b[0] - cx);
            const t1 = Math.atan2(c[1] - cy, c[0] - cx);
            let sw = ccwSweep(t0, t1);
            if (ccwSweep(t0, tm) > sw) sw = sw - Math.PI * 2;
            this.stroke(ring([cx, cy, a[2]], rr, u, v, t0, sw), false, r, ctx);
          }
          drew = true;
          break;
        }
        case 'text': {
          const st = this.doc.textStyles.get('STANDARD');
          const lay = this.opt.text.layoutText({ text: p.text, insert: { x: 0, y: 0 }, height: p.height, rotation: 0, widthFactor: p.width || 1, oblique: p.oblique, generation: 0, halign: 0, valign: 0, style: st });
          const o = applyXY(top(), p.at[0], p.at[1], p.at[2]);
          const dx = applyDir(top(), p.dir[0], p.dir[1], p.dir[2]);
          const l = Math.hypot(dx.x, dx.y) || 1;
          const ux = dx.x / l;
          const uy = dx.y / l;
          this.emitText(lay, [ux, uy, -uy, ux, o.x, o.y], r, ctx);
          drew = true;
          break;
        }
        case 'xline': {
          const a = applyXY(top(), p.a[0], p.a[1], p.a[2]);
          const b = applyXY(top(), p.b[0], p.b[1], p.b[2]);
          this.out.xline(a.x, a.y, b.x - a.x, b.y - a.y, p.ray, r.style);
          drew = true;
          break;
        }
        case 'color':
          r = { ...base, style: this.styleWithColor(base, { aci: p.aci }, ctx) };
          break;
        case 'rgb':
          r = { ...base, style: this.styleWithColor(base, { aci: 7, rgb: p.rgb }, ctx) };
          break;
        case 'push': {
          const q = p.m;
          stack.push(multiply(top(), mat(q[0]!, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!, q[6]!, q[7]!, q[8]!, q[9]!, q[10]!, q[11]!)));
          break;
        }
        case 'pop':
          if (stack.length > 1) stack.pop();
          break;
        default:
          break;
      }
    }
    return drew;
  }

  private shapeCache = new Map<string, number[][] | null>();

  /** 불러온 SHX 도형 파일에서 번호(또는 이름)로 도형 찾기 */
  private findShape(file: string | undefined, num: number | undefined, name: string | undefined): { font: ShxFont; num: number } | null {
    const lib = this.opt.text.shx;
    if (!lib?.size) return null;
    const fonts: ShxFont[] = [];
    const f0 = file ? lib.get(file) : undefined;
    if (f0) fonts.push(f0);
    else for (const n of lib.names()) fonts.push(lib.get(n)!);
    for (const f of fonts) {
      if (num && f.defs.has(num)) return { font: f, num };
      if (name) for (const [n, nm] of f.names) if (nm.toUpperCase() === name.toUpperCase()) return { font: f, num: n };
    }
    return null;
  }

  /** SHX 도형을 그린다(도형 단위 × k, 폭 비율·기울기·회전, 위치) */
  private emitShape(file: string, num: number, k: number, widthFactor: number, oblique: number, angle: number, x: number, y: number, r: Resolved, extra = 1): void {
    const lib = this.opt.text.shx;
    const font = lib?.get(file);
    if (!font) return;
    const key = `${font.name}|${num}`;
    let strokes = this.shapeCache.get(key);
    if (strokes === undefined) {
      strokes = new ShxRunner(font).run(num)?.strokes ?? null;
      this.shapeCache.set(key, strokes);
    }
    if (!strokes) return;
    const s = k * extra;
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    const t = Math.tan(oblique);
    for (const st of strokes) {
      const out = new Array<number>(st.length);
      for (let i = 0; i < st.length; i += 2) {
        const lx = (st[i]! + st[i + 1]! * t) * widthFactor * s;
        const ly = st[i + 1]! * s;
        out[i] = x + c * lx - sn * ly;
        out[i + 1] = y + sn * lx + c * ly;
      }
      if (out.length === 2) this.out.segment(out[0]!, out[1]!, out[0]!, out[1]!, r.style);
      else this.out.polyline(out, false, r.style);
    }
  }

  /** 로컬 2D 점들을 행렬로 옮긴다 */
  private xf(m: Mat, pts: number[], z = 0): number[] {
    const out = new Array<number>(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i]!;
      const y = pts[i + 1]!;
      out[i] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!;
      out[i + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!;
    }
    return out;
  }

  private xf3(m: Mat, pts3: number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i + 2 < pts3.length; i += 3) {
      const x = pts3[i]!;
      const y = pts3[i + 1]!;
      const z = pts3[i + 2]!;
      out.push(m[0]! * x + m[1]! * y + m[2]! * z + m[3]!, m[4]! * x + m[5]! * y + m[6]! * z + m[7]!);
    }
    return out;
  }

  /** 객체 OCS를 붙인 행렬 */
  private ocsM(ctx: Ctx, ext: Vec3 | undefined): Mat {
    if (ctx.dimBlock) return ctx.m;
    return withOcs(ctx.m, ext);
  }

  private localTol(m: Mat): number {
    return this.tol / planarScale(m);
  }

  private emitText(lay: TextLayout, world: Affine, r: Resolved, ctx: Ctx): void {
    // 빠른 문자(QTEXTMODE 1): 치수·지시선·공차 등의 문자도 줄마다 테두리 사각형
    if (this.qtext) return this.qtextBoxes(lay, world, r);
    for (const g of lay.glyphs) {
      const m = affMul(world, g.m);
      const style = g.color ? this.styleWithColor(r, g.color, ctx) : r.style;
      const geom = g.geom;
      const bbox = [geom.minX, geom.minY, geom.maxX, geom.maxY] as const;
      if (geom.segs) {
        if (geom.segs.length) this.out.glyph(geom, 1, geom.segs, m, bbox, style);
      } else if (geom.tris && geom.tris.length) {
        // 채우기를 끄면(FILLMODE 0·TEXTFILL 0) 윤곽 글꼴은 윤곽선만
        if ((!this.fill || !this.textFill) && geom.contours?.length) {
          let segs = this.glyphOutlines.get(geom);
          if (!segs) this.glyphOutlines.set(geom, (segs = contourSegments(geom.contours)));
          if (segs.length) this.out.glyph(segs, 1, segs, m, bbox, style);
        } else this.out.glyph(geom, 0, geom.tris, m, bbox, style);
      }
    }
    for (const l of lay.lines) {
      const style = l.color ? this.styleWithColor(r, l.color, ctx) : r.style;
      this.out.segment(
        world[0] * l.x0 + world[2] * l.y0 + world[4],
        world[1] * l.x0 + world[3] * l.y0 + world[5],
        world[0] * l.x1 + world[2] * l.y1 + world[4],
        world[1] * l.x1 + world[3] * l.y1 + world[5],
        style,
      );
    }
  }

  /** 빠른 문자(QTEXTMODE 1): 줄마다 글자 범위의 테두리 사각형 */
  private qtextBoxes(lay: TextLayout, world: Affine, r: Resolved): void {
    const boxes: { minX: number; minY: number; maxX: number; maxY: number; base: number }[] = [];
    let hMin = Infinity;
    for (const g of lay.glyphs) {
      const m = g.m;
      const gm = g.geom;
      const ys = [gm.minY, gm.maxY];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const x of [gm.minX, gm.maxX])
        for (const y of ys) {
          const px = m[0] * x + m[2] * y + m[4];
          const py = m[1] * x + m[3] * y + m[5];
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
        }
      const h = Math.hypot(m[2], m[3]);
      if (h > 0) hMin = Math.min(hMin, h);
      boxes.push({ minX, minY, maxX, maxY, base: m[5] });
    }
    let lines = textLineBoxes(boxes, Number.isFinite(hMin) ? hMin * 0.5 : 0);
    if (!lines.length && lay.maxX > lay.minX && lay.maxY > lay.minY) lines = [{ minX: lay.minX, minY: lay.minY, maxX: lay.maxX, maxY: lay.maxY }];
    for (const b of lines) {
      if (!(b.maxX > b.minX) && !(b.maxY > b.minY)) continue;
      const q = [b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY];
      const w: number[] = [];
      for (let i = 0; i < 8; i += 2) w.push(world[0] * q[i]! + world[2] * q[i + 1]! + world[4], world[1] * q[i]! + world[3] * q[i + 1]! + world[5]);
      this.out.polyline(w, true, r.style);
    }
  }

  /** 3×4 행렬 + 평면 Z → 2D 아핀(평면도) */
  private planar(m: Mat, z = 0): Affine {
    return [m[0]!, m[4]!, m[1]!, m[5]!, m[2]! * z + m[3]!, m[6]! * z + m[7]!];
  }

  // -------------------------------------------------------------------------
  // 공간 만들기
  // -------------------------------------------------------------------------

  /** 블록의 그리기 순서(SORTENTSTABLE) */
  private ordered(b: BlockDef): Entity[] {
    const key = b.name.toUpperCase();
    const cached = this.sortCache.get(key);
    if (cached) return cached;
    let list = b.entities;
    const rec = this.doc.blockRecords.get(key);
    const xdict = rec?.xdict;
    if (xdict) {
      const d = this.doc.objects.get(xdict) as DictionaryObject | undefined;
      const h = d?.entries?.get('ACAD_SORTENTS');
      const st = h ? (this.doc.objects.get(h) as SortEntsTableObject | undefined) : undefined;
      if (st && st.type === 'SORTENTSTABLE' && st.entries.length) {
        const map = new Map(st.entries.map((x) => [x.entity, x.sort]));
        const keyed = list.map((e, i) => {
          const sk = map.get(e.handle) ?? e.handle;
          let v = 0n;
          try {
            v = BigInt('0x' + (sk || '0'));
          } catch {
            v = BigInt(i);
          }
          return { e, v, i };
        });
        keyed.sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : a.i - b.i));
        list = keyed.map((k) => k.e);
      }
    }
    this.sortCache.set(key, list);
    return list;
  }

  /** 공간의 곡선 정밀도를 정한다(도면 범위 대각선 × 2e-5, 또는 주어진 값) */
  prepare(blockName: string): void {
    const diag = spaceExtentSize(this.doc, blockName);
    this.extentSize = diag;
    this.tol = this.opt.tolerance || diag * 2e-5;
    try {
      this.anno = annoDisplayFor(this.doc, blockName, this.opt);
    } catch {
      this.anno = null;
    }
  }

  /** 주석 축척 표현 선택기(prepare가 정한다) */
  private anno: AnnoDisplay | null = null;

  /** 블록 정의(주석 표현이 쓰는 가상 블록 포함) */
  private blockNamed(name: string): BlockDef | undefined {
    const k = tableKey(name);
    return this.anno?.blocks.get(k) ?? this.doc.blocks.get(k);
  }

  build(blockName: string): SpaceScene {
    this.run(blockName, null);
    const warnings = [...this.warn.entries()].map(([code, count]) => ({ code, count }));
    return { list: this.out.finish(this.opt.packBoxes), styles: this.styles, layers: this.layers, layerIndex: this.layerIndex, warnings, annotative: this.anno?.annotative ?? 0 };
  }

  /**
   * 미리 보기(점진 빌드의 첫 화면): only가 고른 최상위 객체만 그려 조각 하나로 돌려준다. 깊이(그리기 순서)는 전체를 그릴 때와 같다.
   */
  buildPreview(blockName: string, only: (index: number, e: Entity) => boolean, view: PartialView): PartialScene {
    this.run(blockName, only);
    return { list: this.out.snapshot(view.origin[0], view.origin[1], view), styles: this.styles.specs.slice(), layers: this.layers };
  }

  /** 최상위 객체를 차례로 그린다(only가 있으면 고른 것만, 깊이는 전체 순서로) */
  private run(blockName: string, only: ((index: number, e: Entity) => boolean) | null): void {
    this.out = new DisplayListBuilder((s) => this.styles.isTransparent(s, this.layers));
    const block = this.doc.blocks.get(tableKey(blockName));
    const hidden = this.opt.hidden;
    const ents = block ? this.ordered(block).filter((e) => (e.type !== 'VIEWPORT' || (e.id !== 1 && e.status !== 1)) && !hidden?.has(e.handle)) : [];
    this.prepare(blockName);
    const N = ents.length;
    // 최상위 객체의 문맥은 깊이(z0·z1)만 다르다. 행렬·배열·객체는 함께 쓴다(그리기 코드는 문맥을 고치지 않고 새로 만든다).
    const top: Ctx = {
      m: identity(),
      layer: null,
      byColor: { kind: ColorKind.Aci, value: 7 },
      byLinetype: 'Continuous',
      byLineweight: { kind: WidthKind.Default, value: 0 },
      byAlpha: 255,
      freeze: [],
      depth: 0,
      chain: [blockName.toUpperCase()],
      dimBlock: false,
      inBlock: false,
      z0: 0,
      z1: 0,
    };
    const progress = this.opt.onProgress;
    const step = progress ? Math.max(1, Math.floor(N / 50)) : 0;
    const partial = only ? undefined : this.opt.onPartial;
    const pv: PartialView = this.opt.partialView ?? { origin: [0, 0] };
    const gap = this.opt.partialInterval;
    let nextPartial = partial ? performance.now() + (gap ?? 250) : 0;
    for (let i = 0; i < N; i++) {
      const e = ents[i]!;
      if (step && i % step === 0) progress!(i / N);
      if (only && !only(i, e)) continue;
      const z1 = 1 - (i + 1) / (N + 2);
      const z0 = 1 - (i + 2) / (N + 2);
      const ctx: Ctx = { ...top, z0, z1 };
      this.out.setDepth(z1);
      try {
        this.entity(e, ctx);
      } catch (err) {
        this.warnInc('entity.failed');
        void err;
      }
      this.out.endEntity(e.handle);
      if (partial && (i & 255) === 255 && performance.now() >= nextPartial) {
        partial({ list: this.out.snapshot(pv.origin[0], pv.origin[1], pv), styles: this.styles.specs.slice(), layers: this.layers });
        nextPartial = performance.now() + (gap ?? 1000);
      }
    }
    if (partial) partial({ list: this.out.snapshot(pv.origin[0], pv.origin[1], pv), styles: this.styles.specs.slice(), layers: this.layers });
  }

  /**
   * 지정한 객체들만 그린다(선택 강조·객체 고르기용). 객체는 그 공간의 최상위 객체여야 한다.
   */
  buildEntities(list: readonly Entity[]): DisplayList {
    this.out = new DisplayListBuilder(() => false);
    for (const e of list) {
      const ctx: Ctx = {
        m: identity(),
        layer: null,
        byColor: { kind: ColorKind.Aci, value: 7 },
        byLinetype: 'Continuous',
        byLineweight: { kind: WidthKind.Default, value: 0 },
        byAlpha: 255,
        freeze: [],
        depth: 0,
        chain: [],
        dimBlock: false,
        inBlock: false,
        z0: 0,
        z1: 0.5,
      };
      this.out.setDepth(0.5);
      try {
        this.entity(e, ctx);
      } catch {
        /* 그리지 못한 객체는 건너뛴다 */
      }
      this.out.endEntity(e.handle);
    }
    return this.out.finish();
  }

  /** 블록 안 객체들(그리기 순서 깊이를 나눠 준다) */
  private children(list: readonly Entity[], ctx: Ctx): void {
    const n = list.length;
    const span = ctx.z1 - ctx.z0;
    for (let i = 0; i < n; i++) {
      const z1 = ctx.z1 - (span * i) / (n + 1);
      const z0 = ctx.z1 - (span * (i + 1)) / (n + 1);
      this.out.setDepth(z1);
      const e = list[i]!;
      try {
        this.entity(e, { ...ctx, z0, z1 });
      } catch {
        this.warnInc('entity.failed');
      }
    }
    this.out.setDepth(ctx.z1);
  }

  private entity(e: Entity, ctx: Ctx): void {
    if (e.invisible) return;
    // 주석 객체(공간의 최상위 객체): 그 공간·뷰포트의 주석 축척 표현, 지원하지 않으면 ANNOALLVISIBLE대로
    if (this.anno && ctx.depth === 0) {
      const v = this.anno.view(e);
      if (!v) return;
      e = v;
    }
    switch (e.type) {
      case 'LINE': {
        const r = this.resolve(e, ctx);
        const m = ctx.m;
        const a = applyXY(m, e.start.x, e.start.y, e.start.z);
        const b = applyXY(m, e.end.x, e.end.y, e.end.z);
        this.stroke([a.x, a.y, b.x, b.y], false, r, ctx);
        return;
      }
      case 'POINT':
        return this.point(e.position, e.extrusion, e, ctx);
      case 'CIRCLE': {
        const r = this.resolve(e, ctx);
        const m = this.ocsM(ctx, e.extrusion);
        const pts = arcPoints(e.center.x, e.center.y, e.radius, 0, TAU, this.localTol(m));
        pts.length -= 2;
        this.stroke(this.xf(m, pts, e.center.z), true, r, ctx);
        return;
      }
      case 'ARC': {
        const r = this.resolve(e, ctx);
        const m = this.ocsM(ctx, e.extrusion);
        const sweep = ccwSweep(e.startAngle, e.endAngle);
        const pts = arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, sweep, this.localTol(m));
        this.stroke(this.xf(m, pts, e.center.z), false, r, ctx);
        return;
      }
      case 'ELLIPSE': {
        const r = this.resolve(e, ctx);
        const n = e.extrusion ?? { x: 0, y: 0, z: 1 };
        const M = e.majorAxis;
        // 단축 = 법선 × 장축 × 비율
        const minor = { x: (n.y * M.z - n.z * M.y) * e.ratio, y: (n.z * M.x - n.x * M.z) * e.ratio, z: (n.x * M.y - n.y * M.x) * e.ratio };
        const full = Math.abs(e.endParam - e.startParam - TAU) < 1e-9 || Math.abs(e.endParam - e.startParam) < 1e-12;
        const sweep = full ? TAU : ccwSweep(e.startParam, e.endParam);
        const len = Math.hypot(M.x, M.y, M.z);
        const nSeg = Math.max(8, Math.min(1024, Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - this.localTol(ctx.m) / Math.max(len, 1e-12)))))));
        const pts3: number[] = [];
        for (let i = 0; i <= nSeg; i++) {
          const t = e.startParam + (sweep * i) / nSeg;
          const c = Math.cos(t);
          const s = Math.sin(t);
          pts3.push(e.center.x + M.x * c + minor.x * s, e.center.y + M.y * c + minor.y * s, e.center.z + M.z * c + minor.z * s);
        }
        if (full) pts3.length -= 3;
        this.stroke(this.xf3(ctx.m, pts3), full, r, ctx);
        return;
      }
      case 'LWPOLYLINE':
        return this.lwpolyline(e, ctx);
      case 'POLYLINE':
        return this.polyline(e, ctx);
      case 'SPLINE':
        return this.spline(e, ctx);
      case 'XLINE':
      case 'RAY': {
        const r = this.resolve(e, ctx);
        const b = applyXY(ctx.m, e.base.x, e.base.y, e.base.z);
        const d = applyDir(ctx.m, e.direction.x, e.direction.y, e.direction.z);
        const l = Math.hypot(d.x, d.y);
        if (l < 1e-12) return;
        this.out.xline(b.x, b.y, d.x / l, d.y / l, e.type === 'RAY', r.style);
        return;
      }
      case 'TEXT':
      case 'ATTRIB':
      case 'ATTDEF':
        return this.text(e as TextEntity, ctx);
      case 'MTEXT':
        return this.mtext(e, ctx);
      case 'INSERT':
        return this.insert(e, ctx);
      case 'DIMENSION':
        return this.dimension(e, ctx);
      case 'LEADER':
        return this.leader(e, ctx);
      case 'MULTILEADER':
        return this.mleader(e, ctx);
      case 'HATCH':
      case 'MPOLYGON':
        return this.hatch(e, ctx);
      case 'SOLID':
      case 'TRACE': {
        const r = this.resolve(e, ctx);
        const m = this.ocsM(ctx, e.extrusion);
        const [p0, p1, p2, p3] = e.points;
        const q = this.xf(m, [p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y], p0.z);
        if (this.fill) {
          this.out.triangle(q[0]!, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!, r.style);
          this.out.triangle(q[2]!, q[3]!, q[6]!, q[7]!, q[4]!, q[5]!, r.style);
        } else {
          this.out.polyline([q[0]!, q[1]!, q[2]!, q[3]!, q[6]!, q[7]!, q[4]!, q[5]!], true, r.style);
        }
        return;
      }
      case '3DFACE': {
        const r = this.resolve(e, ctx);
        const q = this.xf3(ctx.m, e.points.flatMap((p) => [p.x, p.y, p.z]));
        for (let i = 0; i < 4; i++) {
          if (e.invisibleEdges & (1 << i)) continue;
          const j = (i + 1) % 4;
          this.out.segment(q[i * 2]!, q[i * 2 + 1]!, q[j * 2]!, q[j * 2 + 1]!, r.style);
        }
        return;
      }
      case 'WIPEOUT':
      case 'IMAGE':
        return this.image(e, ctx);
      case 'VIEWPORT': {
        // 배치의 뷰포트 테두리
        const r = this.resolve(e, ctx);
        const c = e.center;
        const w = e.width / 2;
        const h = e.height / 2;
        if (e.clipBoundary && this.doc.entityIndex.has(e.clipBoundary)) return;
        const q = this.xf(ctx.m, [c.x - w, c.y - h, c.x + w, c.y - h, c.x + w, c.y + h, c.x - w, c.y + h]);
        this.out.polyline(q, true, r.style);
        return;
      }
      case 'MLINE':
        return this.mline(e, ctx);
      case 'ARCALIGNEDTEXT':
        // 원호 정렬 문자: 고치지 않은 원본은 프록시 그림, 아니면 글자 TEXT·밑줄 호로 펼쳐 그린다
        if (arcTextUseProxy(e) && this.proxy(e as unknown as UnknownEntity, ctx)) return;
        for (const p of arcTextDrawParts(e)) this.entity(p, ctx);
        return;
      case 'TOLERANCE': {
        const r = this.resolve(e, ctx);
        const dv = this.dimVars(e.dimStyle, undefined);
        const sc = num(dv.DIMSCALE, 1) || 1;
        const h = num(dv.DIMTXT, 2.5) * sc;
        const gap = num(dv.DIMGAP, 0.625) * sc;
        const style = this.doc.textStyles.get(tableKey(String(dv.DIMTXSTY || 'Standard')));
        const lay = (t: string) => this.opt.text.layoutMText({ text: t, height: h, width: 0, attachment: 4, lineSpacingStyle: 1, lineSpacingFactor: 1, style });
        // 프레임·칸막이·GDT 기호는 선으로(gdt.shx 없이), 값·데이텀 문자는 칸 안에 왼쪽 가운데 기준으로
        const tl = toleranceLayout(e.text, h, gap, (t) => {
          const l = lay(t);
          const w = l.maxX - l.minX;
          return Number.isFinite(w) ? w : t.length * h * 0.7;
        });
        const ang = Math.atan2(e.direction.y, e.direction.x);
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const world = affMul(this.planar(this.ocsM(ctx, e.extrusion), e.insert.z), [ca, sa, -sa, ca, e.insert.x, e.insert.y]);
        for (const s of tl.strokes) {
          const q: number[] = [];
          for (const p of s.pts) q.push(world[0] * p.x + world[2] * p.y + world[4], world[1] * p.x + world[3] * p.y + world[5]);
          this.out.polyline(q, !!s.closed, r.style);
        }
        for (const t of tl.texts) this.emitText(lay(t.text), affMul(world, [1, 0, 0, 1, t.x, t.y]), r, ctx);
        return;
      }
      case 'ACAD_TABLE': {
        const b = this.doc.blocks.get(tableKey(e.block));
        if (!b) return;
        const ang = Math.atan2(e.direction.y, e.direction.x);
        const local = multiply(translation(e.insert.x, e.insert.y, e.insert.z), multiply(rotationZ(ang), scaling(e.scale.x || 1, e.scale.y || 1, e.scale.z || 1)));
        const m = multiply(this.ocsM(ctx, e.extrusion), multiply(local, translation(-b.basePoint.x, -b.basePoint.y, -b.basePoint.z)));
        this.blockContents(b, e, m, ctx);
        return;
      }
      case 'MESH': {
        const r = this.resolve(e, ctx);
        const v = e.vertices.map((p) => applyXY(ctx.m, p.x, p.y, p.z));
        if (e.edges.length) for (const [a, b] of e.edges) this.out.segment(v[a]!.x, v[a]!.y, v[b]!.x, v[b]!.y, r.style);
        else
          for (const f of e.faces)
            for (let i = 0; i < f.length; i++) {
              const a = v[f[i]!];
              const b = v[f[(i + 1) % f.length]!];
              if (a && b) this.out.segment(a.x, a.y, b.x, b.y, r.style);
            }
        return;
      }
      case 'OLE2FRAME':
      case 'OLEFRAME': {
        const r = this.resolve(e, ctx);
        const a = e.upperLeft;
        const b = e.lowerRight;
        this.out.polyline(this.xf(ctx.m, [a.x, a.y, b.x, a.y, b.x, b.y, a.x, b.y], a.z), true, r.style);
        return;
      }
      case 'PDFUNDERLAY':
      case 'DWFUNDERLAY':
      case 'DGNUNDERLAY':
        this.underlay(e, ctx);
        return;
      case 'SHAPE': {
        // 도형 파일: 스타일 핸들의 글꼴, 없으면 이름으로 불러온 도형 파일에서 찾는다
        const st = e.styleHandle ? this.styleByHandle.get(e.styleHandle) : undefined;
        const found = this.findShape(st?.font, e.shapeNumber, e.name);
        if (!found) {
          this.warnInc('shape.unsupported');
          return;
        }
        const r = this.resolve(e, ctx);
        const m = this.ocsM(ctx, e.extrusion);
        const p = applyXY(m, e.insert.x, e.insert.y, e.insert.z);
        const k = e.size / (found.font.above || 1);
        const d = applyDir(m, Math.cos(e.rotation), Math.sin(e.rotation), 0);
        this.emitShape(found.font.name, found.num, k, e.widthFactor || 1, e.oblique || 0, Math.atan2(d.y, d.x), p.x, p.y, r, planarScale(m));
        return;
      }
      case 'UNKNOWN':
        // 프록시 그림이 있으면 그것으로 그린다
        if (e.graphics?.length && this.proxy(e, ctx)) return;
        this.warnInc('entity.not_drawn');
        return;
      case 'REGION':
      case '3DSOLID':
      case 'BODY':
        this.warnInc('entity.not_drawn');
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------

  private point(p: Vec3, ext: Vec3 | undefined, e: Entity, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const m = this.ocsM(ctx, ext);
    const c = applyXY(m, p.x, p.y, p.z);
    const mode = this.pdmode;
    let size = this.pdsize;
    if (size === 0) size = this.extentSize * 0.01;
    else if (size < 0) size = (this.extentSize * -size) / 100;
    const s = (size / 2) * planarScale(ctx.m);
    const base = mode & 7;
    if (base === 0) this.out.segment(c.x, c.y, c.x, c.y, r.style);
    else if (base === 2) {
      this.out.segment(c.x - s, c.y, c.x + s, c.y, r.style);
      this.out.segment(c.x, c.y - s, c.x, c.y + s, r.style);
    } else if (base === 3) {
      this.out.segment(c.x - s, c.y - s, c.x + s, c.y + s, r.style);
      this.out.segment(c.x - s, c.y + s, c.x + s, c.y - s, r.style);
    } else if (base === 4) this.out.segment(c.x, c.y, c.x, c.y + s, r.style);
    if (mode & 32) {
      const pts = arcPoints(c.x, c.y, s, 0, TAU, s * 0.01);
      this.out.polyline(pts, false, r.style);
    }
    if (mode & 64) this.out.polyline([c.x - s, c.y - s, c.x + s, c.y - s, c.x + s, c.y + s, c.x - s, c.y + s], true, r.style);
  }

  private lwpolyline(e: Extract<Entity, { type: 'LWPOLYLINE' }>, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const m = this.ocsM(ctx, e.extrusion);
    const vs = e.verts;
    const n = lwCount(e);
    if (!n) return;
    const ew = e.widths;
    const cw = e.constantWidth;
    let wide = cw > 0;
    if (!wide && ew) for (let i = 0; i < ew.length && !wide; i++) wide = ew[i]! > 0;
    // 폭(정점 폭이 0이면 일정 폭)은 폭 있게 그릴 때만 만든다
    let ws: number[] | null = null;
    if (wide) {
      ws = [];
      for (let i = 0; i < n; i++) ws.push((ew ? ew[i * 2]! : 0) || cw, (ew ? ew[i * 2 + 1]! : 0) || cw);
    }
    this.polyCommon(vs, n, ws, e.closed, e.plinegen, m, e.elevation, r, ctx);
  }

  /**
   * 2D 폴리선 공통(경량 폴리선·POLYLINE 2D): xyb = 정점 평탄 좌표 [x, y, 볼록, …](앞 n개),
   * ws = 정점별 [시작 폭, 끝 폭, …](폭 있게 그릴 때만, 아니면 null).
   */
  private polyCommon(xyb: readonly number[], n: number, ws: readonly number[] | null, closed: boolean, plinegen: boolean, m: Mat, z: number, r: Resolved, ctx: Ctx): void {
    const tol = this.localTol(m);
    if (n === 1) {
      const p = applyXY(m, xyb[0]!, xyb[1]!, z);
      this.out.segment(p.x, p.y, p.x, p.y, r.style);
      return;
    }
    const segCount = closed ? n : n - 1;
    if (ws) {
      for (let i = 0; i < segCount; i++) {
        const a = i * 3;
        const b = ((i + 1) % n) * 3;
        const ax = xyb[a]!;
        const ay = xyb[a + 1]!;
        const pts: number[] = [ax, ay];
        bulgePoints(ax, ay, xyb[b]!, xyb[b + 1]!, xyb[a + 2]!, tol, pts);
        // 폭이 0인 세그먼트는 보통 선으로. 채우기를 끄면(FILLMODE 0) 폭의 윤곽만
        const sw = ws[i * 2]!;
        const ew = ws[i * 2 + 1]!;
        if (sw > 0 || ew > 0) this.wideStrip(pts, sw, ew, m, z, r, !this.fill);
        else this.stroke(this.xf(m, pts, z), false, r, ctx);
      }
      return;
    }
    if (plinegen || !this.pattern(r.linetype, 1)) {
      const pts: number[] = [xyb[0]!, xyb[1]!];
      for (let i = 0; i < segCount; i++) {
        const a = i * 3;
        const b = ((i + 1) % n) * 3;
        bulgePoints(xyb[a]!, xyb[a + 1]!, xyb[b]!, xyb[b + 1]!, xyb[a + 2]!, tol, pts);
      }
      if (closed) pts.length -= 2;
      this.stroke(this.xf(m, pts, z), closed, r, ctx);
      return;
    }
    // PLINEGEN이 없으면 무늬가 정점마다 다시 시작한다.
    for (let i = 0; i < segCount; i++) {
      const a = i * 3;
      const b = ((i + 1) % n) * 3;
      const ax = xyb[a]!;
      const ay = xyb[a + 1]!;
      const pts: number[] = [ax, ay];
      bulgePoints(ax, ay, xyb[b]!, xyb[b + 1]!, xyb[a + 2]!, tol, pts);
      this.stroke(this.xf(m, pts, z), false, r, ctx);
    }
  }

  /** 폭 있는 선분(로컬 점 배열, 시작·끝 폭) → 삼각형 띠 */
  private wideStrip(pts: number[], sw: number, ew: number, m: Mat, z: number, r: Resolved, outline = false): void {
    const n = pts.length >> 1;
    if (n < 2) return;
    let total = 0;
    const acc: number[] = [0];
    for (let i = 1; i < n; i++) {
      total += Math.hypot(pts[i * 2]! - pts[i * 2 - 2]!, pts[i * 2 + 1]! - pts[i * 2 - 1]!);
      acc.push(total);
    }
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = total > 0 ? acc[i]! / total : 0;
      const w = (sw + (ew - sw) * t) / 2;
      // 접선(앞뒤 평균)
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 1);
      let tx = pts[i1 * 2]! - pts[i0 * 2]!;
      let ty = pts[i1 * 2 + 1]! - pts[i0 * 2 + 1]!;
      const l = Math.hypot(tx, ty) || 1;
      tx /= l;
      ty /= l;
      left.push(pts[i * 2]! - ty * w, pts[i * 2 + 1]! + tx * w);
      right.push(pts[i * 2]! + ty * w, pts[i * 2 + 1]! - tx * w);
    }
    const L = this.xf(m, left, z);
    const R = this.xf(m, right, z);
    if (outline) {
      for (const pl of stripOutline(L, R)) this.out.polyline(pl, false, r.style);
      return;
    }
    for (let i = 0; i + 1 < n; i++) {
      const a = i * 2;
      const b = (i + 1) * 2;
      this.out.triangle(L[a]!, L[a + 1]!, R[a]!, R[a + 1]!, L[b]!, L[b + 1]!, r.style);
      this.out.triangle(R[a]!, R[a + 1]!, R[b]!, R[b + 1]!, L[b]!, L[b + 1]!, r.style);
    }
  }

  private polyline(e: Extract<Entity, { type: 'POLYLINE' }>, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    if (e.kind === '2d') {
      const m = this.ocsM(ctx, e.extrusion);
      const vs = e.vertices.filter((v) => !(v.flags & 16));
      const wide = e.defaultStartWidth > 0 || e.defaultEndWidth > 0 || vs.some((v) => v.startWidth > 0 || v.endWidth > 0);
      const xyb: number[] = [];
      for (const v of vs) xyb.push(v.location.x, v.location.y, v.bulge);
      let ws: number[] | null = null;
      if (wide) {
        ws = [];
        for (const v of vs) ws.push(v.startWidth, v.endWidth);
      }
      // 맞춤(curve-fit) 폴리선도 정점의 볼록도가 실제 호다
      this.polyCommon(xyb, vs.length, ws, (e.flags & 1) !== 0, (e.flags & 128) !== 0, m, e.elevation, r, ctx);
      return;
    }
    if (e.kind === '3d') {
      const vs = e.vertices.filter((v) => !(v.flags & 16));
      const pts = this.xf3(
        ctx.m,
        vs.flatMap((v) => [v.location.x, v.location.y, v.location.z]),
      );
      this.stroke(pts, (e.flags & 1) !== 0, r, ctx);
      return;
    }
    if (e.kind === 'mesh') {
      const M = e.mCount;
      const N = e.nCount;
      const v = e.vertices.map((q) => applyXY(ctx.m, q.location.x, q.location.y, q.location.z));
      if (M * N > v.length || M < 1 || N < 1) return;
      const closedM = (e.flags & 1) !== 0;
      const closedN = (e.flags & 32) !== 0;
      for (let i = 0; i < M; i++)
        for (let j = 0; j < N; j++) {
          const a = v[i * N + j]!;
          if (j + 1 < N || closedN) {
            const b = v[i * N + ((j + 1) % N)]!;
            this.out.segment(a.x, a.y, b.x, b.y, r.style);
          }
          if (i + 1 < M || closedM) {
            const b = v[((i + 1) % M) * N + j]!;
            this.out.segment(a.x, a.y, b.x, b.y, r.style);
          }
        }
      return;
    }
    // 폴리페이스
    const coords = e.vertices.filter((v) => v.flags & 64 || !v.faceIndices);
    const pts = coords.map((q) => applyXY(ctx.m, q.location.x, q.location.y, q.location.z));
    for (const f of e.vertices) {
      if (!f.faceIndices || f.flags & 64) continue;
      const idx = f.faceIndices;
      for (let i = 0; i < idx.length; i++) {
        const a = idx[i]!;
        if (a < 0) continue; // 숨긴 모서리
        const b = Math.abs(idx[(i + 1) % idx.length]!);
        const pa = pts[Math.abs(a) - 1];
        const pb = pts[b - 1];
        if (pa && pb) this.out.segment(pa.x, pa.y, pb.x, pb.y, r.style);
      }
    }
  }

  private spline(e: Extract<Entity, { type: 'SPLINE' }>, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const tol = this.localTol(ctx.m);
    let ctrl = e.controlPoints;
    let knots = e.knots;
    let degree = e.degree;
    let weights = e.weights;
    if (ctrl.length < 2 && e.fitPoints.length >= 2) {
      const s = interpolateFitPoints(e.fitPoints, e.startTangent, e.endTangent);
      ctrl = s.ctrl;
      knots = s.knots;
      degree = s.degree;
      weights = undefined;
    }
    const pts3 = nurbsPoints(degree, knots, ctrl, weights, tol);
    this.stroke(this.xf3(ctx.m, pts3), false, r, ctx);
  }

  private text(e: TextEntity, ctx: Ctx): void {
    if (e.type === 'ATTDEF' && ctx.inBlock && !((e as { attFlags?: number }).attFlags! & 2)) return;
    if (e.type === 'ATTRIB' && (this.attmode === 0 || ((e as { attFlags?: number }).attFlags! & 1 && this.attmode !== 2))) return;
    const mt = (e as { mtext?: Extract<Entity, { type: 'MTEXT' }> }).mtext;
    if (mt && (e.type === 'ATTRIB' || e.type === 'ATTDEF')) {
      this.mtext({ ...mt, layer: e.layer, color: e.color, linetype: e.linetype, lineweight: e.lineweight, transparency: e.transparency, handle: e.handle }, ctx);
      return;
    }
    const r = this.resolve(e, ctx);
    const style = this.doc.textStyles.get(tableKey(e.style));
    let text = e.text;
    if (e.type === 'ATTDEF' && !ctx.inBlock) text = (e as { tag?: string }).tag ?? text;
    const lay = this.opt.text.layoutText({
      text,
      insert: e.insert,
      alignPoint: e.alignPoint,
      height: e.height,
      rotation: e.rotation,
      widthFactor: e.widthFactor,
      oblique: e.oblique,
      generation: e.generation,
      halign: e.halign,
      valign: e.valign,
      style,
    });
    const m = this.ocsM(ctx, e.extrusion);
    const world = this.planar(m, e.insert.z);
    if (this.qtext) return this.qtextBoxes(lay, world, r);
    this.fieldBackground(e, lay, world, r);
    this.emitText(lay, world, r, ctx);
  }

  private mtext(e: Extract<Entity, { type: 'MTEXT' }>, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const style = this.doc.textStyles.get(tableKey(e.style));
    const lay = this.opt.text.layoutMText({
      text: e.text,
      height: e.height,
      width: e.width,
      attachment: e.attachment,
      lineSpacingStyle: e.lineSpacingStyle,
      lineSpacingFactor: e.lineSpacingFactor,
      style,
      columns: e.columns && e.columns.count > 1 ? e.columns : undefined,
      rectHeight: e.rectHeight,
      background: e.backgroundFlags & 1 || e.backgroundFlags & 2 ? { scale: e.backgroundScale } : undefined,
      frame: (e.backgroundFlags & 16) !== 0,
    });
    // 문자 평면: X축 = 방향, 법선 = extrusion
    const n = e.extrusion ?? { x: 0, y: 0, z: 1 };
    let dx: Vec3;
    if (e.direction) dx = e.direction;
    else {
      const o = ocsMatrix(e.extrusion);
      const c = Math.cos(e.rotation);
      const s = Math.sin(e.rotation);
      dx = o ? { x: o[0]! * c + o[1]! * s, y: o[4]! * c + o[5]! * s, z: o[8]! * c + o[9]! * s } : { x: c, y: s, z: 0 };
    }
    const l = Math.hypot(dx.x, dx.y, dx.z) || 1;
    const ux = { x: dx.x / l, y: dx.y / l, z: dx.z / l };
    const uy = { x: n.y * ux.z - n.z * ux.y, y: n.z * ux.x - n.x * ux.z, z: n.x * ux.y - n.y * ux.x };
    const S = this.scratch;
    const local = S[0]!;
    local[0] = ux.x;
    local[1] = uy.x;
    local[2] = n.x;
    local[3] = e.insert.x;
    local[4] = ux.y;
    local[5] = uy.y;
    local[6] = n.y;
    local[7] = e.insert.y;
    local[8] = ux.z;
    local[9] = uy.z;
    local[10] = n.z;
    local[11] = e.insert.z;
    const m = multiplyInto(S[1]!, ctx.m, local);
    const world = this.planar(m, 0);
    if (lay.background) {
      const [x0, y0, x1, y1] = lay.background;
      const q = [x0, y0, x1, y0, x1, y1, x0, y1];
      const w: number[] = [];
      for (let i = 0; i < 8; i += 2) w.push(world[0] * q[i]! + world[2] * q[i + 1]! + world[4], world[1] * q[i]! + world[3] * q[i + 1]! + world[5]);
      const bgStyle = e.backgroundFlags & 2 || !e.backgroundColor ? this.backgroundStyle(r) : this.styleWithColor(r, e.backgroundColor, ctx);
      this.out.triangle(w[0]!, w[1]!, w[2]!, w[3]!, w[4]!, w[5]!, bgStyle);
      this.out.triangle(w[0]!, w[1]!, w[4]!, w[5]!, w[6]!, w[7]!, bgStyle);
      if (lay.frame) this.out.polyline(w, true, r.style);
    }
    if (this.qtext) return this.qtextBoxes(lay, world, r);
    this.fieldBackground(e, lay, world, r);
    this.emitText(lay, world, r, ctx);
  }

  private insert(e: InsertEntity, ctx: Ctx): void {
    const b = this.doc.blocks.get(tableKey(e.block));
    if (!b) {
      this.warnInc('block.missing');
      return;
    }
    if (ctx.depth >= MAX_DEPTH || ctx.chain.includes(tableKey(e.block))) {
      this.warnInc('block.recursive');
      return;
    }
    const om = this.ocsM(ctx, e.extrusion);
    const sx = e.scale.x || 1;
    const sy = e.scale.y || 1;
    const sz = e.scale.z || 1;
    const rows = Math.max(1, e.rowCount);
    const cols = Math.max(1, e.columnCount);
    for (let rI = 0; rI < rows; rI++)
      for (let cI = 0; cI < cols; cI++) {
        // 같은 계산(multiply 순서)을 임시 행렬로 한다: 블록 참조마다 형식 배열 10개를 만들지 않게. 결과 m만 새 배열
        const S = this.scratch;
        multiplyInto(S[2]!, setTranslation(S[0]!, cI * e.columnSpacing, rI * e.rowSpacing, 0), setScaling(S[1]!, sx, sy, sz));
        multiplyInto(S[3]!, setRotationZ(S[0]!, e.rotation), S[2]!);
        const local = multiplyInto(S[4]!, setTranslation(S[1]!, e.insert.x, e.insert.y, e.insert.z), S[3]!);
        const m = multiply(om, multiplyInto(S[5]!, local, setTranslation(S[0]!, -b.basePoint.x, -b.basePoint.y, -b.basePoint.z)));
        const clip = b.flags & 4 && !b.entities.length ? null : this.xclipPolygon(e, m);
        if (clip) this.out.pushClip(clip.poly, clip.inverted);
        this.blockContents(b, e, m, ctx);
        if (clip) {
          this.out.popClip();
          // 자르기 경계 틀(XCLIPFRAME 1 보이고 출력, 2(기본) 화면에만)
          const xf = this.doc.header.get('$XCLIPFRAME');
          if (clip.frame && (xf === undefined || xf === 1 || xf === 2)) {
            const style = this.resolve(e, ctx).style;
            this.out.polyline(clip.poly, true, xf === 1 ? style : this.noPlotStyle(style));
          }
        }
      }
    // 속성은 블록 참조와 같은 공간에 있다
    if (e.attribs.length) {
      const r = this.resolve(e, ctx);
      const child = this.childCtx(e, ctx, r, ctx.m);
      for (const a of e.attribs) this.text(a as unknown as TextEntity, { ...child, inBlock: false });
    }
  }

  /**
   * XCLIP: 블록 참조의 확장 사전 → ACAD_FILTER → SPATIAL 필터의 경계를 월드 다각형으로.
   * 경계는 클립할 때의 좌표(clipTransform으로 WCS) → inverseBlockTransform으로 블록 좌표 → 지금 변환 m으로 월드.
   */
  private xclipPolygon(e: InsertEntity, m: Mat): { poly: number[]; inverted: boolean; frame: boolean } | null {
    if (!e.xdict) return null;
    const dict = (h: string | undefined) => {
      const o = h ? this.doc.objects.get(h) : undefined;
      return o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT') ? (o as DictionaryObject) : null;
    };
    const entry = (d: DictionaryObject | null, k: string) => {
      if (!d) return undefined;
      for (const [n, h] of d.entries) if (n.toUpperCase() === k) return h;
      return undefined;
    };
    const fd = dict(entry(dict(e.xdict), 'ACAD_FILTER'));
    const sh = entry(fd, 'SPATIAL');
    const sf = sh ? this.doc.objects.get(sh) : undefined;
    if (!sf || sf.type !== 'SPATIAL_FILTER') return null;
    const f = sf as SpatialFilterObject;
    // 그룹 71(displayBoundary)은 자르기 사용 여부다(XCLIP 켜기·끄기). 틀 표시는 $XCLIPFRAME
    if (!f.displayBoundary) return null;
    let pts = f.boundary;
    if (pts.length === 2) {
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
      pts = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    }
    if (pts.length < 3) return null;
    const apply43 = (M: number[], x: number, y: number, z: number) =>
      M.length >= 12 ? { x: M[0]! * x + M[1]! * y + M[2]! * z + M[3]!, y: M[4]! * x + M[5]! * y + M[6]! * z + M[7]!, z: M[8]! * x + M[9]! * y + M[10]! * z + M[11]! } : { x, y, z };
    const poly: number[] = [];
    for (const p of pts) {
      // 경계 평면(원점·법선) → 클립 변환 → 블록 좌표 → 월드
      const om = ocsMatrix(f.normal);
      const w0 = om ? apply(om, p.x, p.y, 0) : { x: p.x, y: p.y, z: 0 };
      w0.x += f.origin.x;
      w0.y += f.origin.y;
      w0.z += f.origin.z;
      const w1 = apply43(f.clipTransform, w0.x, w0.y, w0.z);
      const bp = apply43(f.inverseBlockTransform, w1.x, w1.y, w1.z);
      const q = applyXY(m, bp.x, bp.y, bp.z);
      poly.push(q.x, q.y);
    }
    if (!poly.every(Number.isFinite)) return null;
    return { poly, inverted: !!f.inverted, frame: true };
  }

  private childCtx(parent: Entity, ctx: Ctx, r: Resolved, m: Mat): Ctx {
    const spec = this.styles.specs[r.style]!;
    let lw = ctx.byLineweight;
    if (parent.lineweight === -1) lw = { kind: WidthKind.Layer, value: r.layer };
    else if (parent.lineweight >= 0) lw = { kind: WidthKind.Value, value: parent.lineweight };
    else if (parent.lineweight === -3) lw = { kind: WidthKind.Default, value: 0 };
    return {
      m,
      layer: r.layer,
      byColor: { kind: spec.colorKind, value: spec.color },
      byLinetype: r.linetype,
      byLineweight: lw,
      byAlpha: spec.alpha,
      freeze: this.freezeWith(ctx.freeze, r.layer),
      depth: ctx.depth + 1,
      chain: ctx.chain,
      dimBlock: false,
      inBlock: true,
      z0: ctx.z0,
      z1: ctx.z1,
    };
  }

  private blockContents(b: BlockDef, parent: Entity, m: Mat, ctx: Ctx, dimBlock = false): void {
    if (b.flags & 4 && !b.entities.length) {
      // 외부 참조: 참조 파일의 모형 장면을 이 변환으로 그리도록 인스턴스만 남긴다(파일을 연결했을 때 화면이 그린다)
      const clip = parent.type === 'INSERT' ? this.xclipPolygon(parent, m) : null;
      this.out.xref(tableKey(b.name), [m[0]!, m[4]!, m[1]!, m[5]!, m[3]!, m[7]!], this.resolve(parent, ctx).style, clip ?? undefined);
      this.warnInc('xref.not_loaded');
      return;
    }
    const r = this.resolve(parent, ctx);
    const child = this.childCtx(parent, ctx, r, m);
    child.chain = [...ctx.chain, tableKey(b.name)];
    child.dimBlock = dimBlock;
    this.children(this.ordered(b), child);
  }

  // -------------------------------------------------------------------------
  // 치수·지시선
  // -------------------------------------------------------------------------

  private dimVars(styleName: string, overrides: Record<number, string | number> | undefined): Record<string, number | string> {
    const ds: DimStyle | undefined = this.doc.dimStyles.get(tableKey(styleName)) ?? this.doc.dimStyles.get('STANDARD');
    const out: Record<string, number | string> = { ...DIM_VAR_DEFAULTS };
    for (const [k, v] of this.doc.header) if (k.startsWith('$DIM')) out[k.slice(1)] = v as number | string;
    if (ds) Object.assign(out, ds.vars);
    if (overrides) for (const [code, v] of Object.entries(overrides)) {
      const name = DIM_VAR_CODES[Number(code)];
      if (name) out[name] = v;
    }
    return out;
  }

  private dimension(e: DimensionEntity, ctx: Ctx): void {
    const b = e.block ? this.blockNamed(e.block) : undefined;
    if (b && b.entities.length) {
      if (ctx.chain.includes(tableKey(b.name)) || ctx.depth >= MAX_DEPTH) return;
      // 치수 블록의 내용은 치수의 OCS에 있다.
      let m = withOcs(ctx.m, e.extrusion);
      m = multiply(m, translation(0, 0, e.textMid.z));
      if (e.insertPoint && (e.insertPoint.x || e.insertPoint.y)) m = multiply(translation(e.insertPoint.x, e.insertPoint.y, 0), m);
      this.blockContents(b, e, m, ctx, !!ocsMatrix(e.extrusion));
      return;
    }
    this.warnInc('dimension.generated');
    this.simpleDimension(e, ctx);
  }

  /** 치수 블록이 없는 파일: 정의점으로 간단히 그린다 */
  private simpleDimension(e: DimensionEntity, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const v = this.dimVars(e.dimStyle, e.overrides);
    const scale = num(v.DIMSCALE, 1) || 1;
    const asz = num(v.DIMASZ, 2.5) * scale;
    const txt = num(v.DIMTXT, 2.5) * scale;
    const m = ctx.m;
    const P = (p: Vec3) => applyXY(m, p.x, p.y, p.z);
    const kind = e.dimType & 7;
    const label = (value: number, at: { x: number; y: number }, ang: number) => {
      const dec = num(v.DIMDEC, 2);
      let s = e.text && e.text !== '<>' ? e.text.replace('<>', value.toFixed(dec)) : value.toFixed(dec);
      if (e.text === ' ') s = '';
      const lay = this.opt.text.layoutMText({ text: s, height: txt, width: 0, attachment: 8, lineSpacingStyle: 1, lineSpacingFactor: 1, style: this.doc.textStyles.get(tableKey(String(v.DIMTXSTY || 'Standard'))) });
      let a = ang;
      if (a > Math.PI / 2 + 1e-9 || a < -Math.PI / 2 - 1e-9) a += Math.PI;
      const c = Math.cos(a);
      const s2 = Math.sin(a);
      this.emitText(lay, [c, s2, -s2, c, at.x, at.y], r, ctx);
    };
    const arrow = (tip: { x: number; y: number }, dir: number) => this.arrowAt(String(v.DIMBLK || ''), tip, dir, asz, r, ctx);
    if (kind === 0 || kind === 1) {
      const p1 = P(e.defPoint2);
      const p2 = P(e.defPoint3);
      const d = P(e.defPoint);
      let ang = kind === 0 ? e.rotation : Math.atan2(p2.y - p1.y, p2.x - p1.x);
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      // 치수선: d를 지나고 방향 ang
      const proj = (p: { x: number; y: number }) => {
        const t = (p.x - d.x) * ux + (p.y - d.y) * uy;
        return { x: d.x + ux * t, y: d.y + uy * t };
      };
      const a = proj(p1);
      const bb = proj(p2);
      this.out.segment(p1.x, p1.y, a.x, a.y, r.style);
      this.out.segment(p2.x, p2.y, bb.x, bb.y, r.style);
      this.out.segment(a.x, a.y, bb.x, bb.y, r.style);
      const dir = Math.atan2(bb.y - a.y, bb.x - a.x);
      arrow(a, dir + Math.PI);
      arrow(bb, dir);
      const value = Number.isFinite(e.measurement) ? e.measurement : Math.hypot(bb.x - a.x, bb.y - a.y);
      const mid = { x: (a.x + bb.x) / 2, y: (a.y + bb.y) / 2 };
      const off = txt * 0.6;
      ang = dir;
      label(value * num(v.DIMLFAC, 1), { x: mid.x - Math.sin(ang) * off, y: mid.y + Math.cos(ang) * off }, ang);
      return;
    }
    if (kind === 3 || kind === 4) {
      const c = kind === 4 ? P(e.defPoint) : (() => {
        const a = P(e.defPoint);
        const b2 = P(e.defPoint4);
        return { x: (a.x + b2.x) / 2, y: (a.y + b2.y) / 2 };
      })();
      const q = P(e.defPoint4);
      const from = kind === 3 ? P(e.defPoint) : c;
      this.out.segment(from.x, from.y, q.x, q.y, r.style);
      const dir = Math.atan2(q.y - from.y, q.x - from.x);
      arrow(q, dir);
      if (kind === 3) arrow(from, dir + Math.PI);
      const value = Number.isFinite(e.measurement) ? e.measurement : Math.hypot(q.x - from.x, q.y - from.y);
      label(value, P(e.textMid), dir);
      return;
    }
    // 그 밖: 정의점 사이 선과 문자
    const t = P(e.textMid);
    label(Number.isFinite(e.measurement) ? (kind === 2 || kind === 5 ? (e.measurement * 180) / Math.PI : e.measurement) : 0, t, 0);
  }

  /** 화살촉: 도면의 블록이 있으면 블록, 없으면 기본 모양 */
  private arrowAt(name: string, tip: { x: number; y: number }, dir: number, size: number, r: Resolved, ctx: Ctx, parent?: Entity): void {
    if (!(size > 0)) return;
    // 이름 또는 블록 레코드 핸들(치수 변수 341~344는 핸들이다)
    const blk = name ? (this.blockNamed(name) ?? (/^[0-9A-F]+$/i.test(name) ? this.blockByRecord.get(normalizeHandle(name)) : undefined)) : undefined;
    if (blk) name = blk.name;
    const c = Math.cos(dir) * size;
    const s = Math.sin(dir) * size;
    if (blk && blk.entities.length && parent) {
      const m = multiply(Float64Array.of(c, -s, 0, tip.x, s, c, 0, tip.y, 0, 0, size, 0), translation(-blk.basePoint.x, -blk.basePoint.y, -blk.basePoint.z));
      this.blockContents(blk, parent, m, ctx);
      return;
    }
    const shape = builtinArrow(name) ?? builtinArrow('')!;
    const X = (x: number, y: number) => [tip.x + c * x - s * y, tip.y + s * x + c * y] as const;
    for (const l of shape.lines) {
      const pts: number[] = [];
      for (let i = 0; i < l.length; i += 2) pts.push(...X(l[i]!, l[i + 1]!));
      this.out.polyline(pts, false, r.style);
    }
    for (const f of shape.fills) {
      if (!this.fill) {
        // 채우기를 끄면 채운 화살촉은 바깥 윤곽만
        const pts: number[] = [];
        for (let i = 0; i + 1 < f.length; i += 2) pts.push(...X(f[i]!, f[i + 1]!));
        const e = boundaryEdges(pts);
        for (let i = 0; i + 3 < e.length; i += 4) this.out.segment(e[i]!, e[i + 1]!, e[i + 2]!, e[i + 3]!, r.style);
        continue;
      }
      for (let i = 0; i + 5 < f.length; i += 6) {
        const a = X(f[i]!, f[i + 1]!);
        const b = X(f[i + 2]!, f[i + 3]!);
        const d = X(f[i + 4]!, f[i + 5]!);
        this.out.triangle(a[0], a[1], b[0], b[1], d[0], d[1], r.style);
      }
    }
  }

  private leader(e: LeaderEntity, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const v = this.dimVars(e.dimStyle, e.overrides);
    if (e.vertices.length < 2) return;
    let pts3: number[];
    if (e.pathType === 1 && e.vertices.length > 2) {
      const s = interpolateFitPoints(e.vertices);
      pts3 = nurbsPoints(s.degree, s.knots, s.ctrl, undefined, this.localTol(ctx.m));
    } else pts3 = e.vertices.flatMap((p) => [p.x, p.y, p.z]);
    const pts = this.xf3(ctx.m, pts3);
    let color = e.color;
    if (e.overrides && e.overrides[176] !== undefined) color = { aci: Number(e.overrides[176]) };
    const rr = color !== e.color ? { ...r, style: this.styleWithColor(r, color, ctx) } : r;
    this.stroke(pts, false, rr, ctx);
    if (e.arrowHead) {
      const scale = num(v.DIMSCALE, 1) || 1;
      const asz = num(v.DIMASZ, 2.5) * scale;
      const dir = Math.atan2(pts[1]! - pts[3]!, pts[0]! - pts[2]!);
      const seg = Math.hypot(pts[1]! - pts[3]!, pts[0]! - pts[2]!);
      // DIMLDRBLK가 비어 있으면 DIMBLK가 아니라 닫고 채운 화살촉이다
      if (seg > asz * 2 || seg > 1e-9) this.arrowAt(String(v.DIMLDRBLK || ''), { x: pts[0]!, y: pts[1]! }, dir, asz, rr, ctx, e);
    }
  }

  private mleader(e: MLeaderEntity, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const c = e.context;
    const lineStyle = this.styleWithColor(r, e.leaderLineColor.aci === 0 && e.leaderLineColor.rgb === undefined ? null : e.leaderLineColor, ctx);
    const rl: Resolved = { ...r, style: lineStyle };
    if (e.leaderLineTypeHandle) {
      for (const lt of this.doc.linetypes.values()) if (lt.handle === e.leaderLineTypeHandle) rl.linetype = lt.name;
    }
    const arrowSize = (c.arrowSize || e.arrowSize) * 1;
    const arrowName = e.arrowHeadHandle ? (this.blockByRecord.get(e.arrowHeadHandle)?.name ?? '') : '';
    const m = ctx.m;
    if (e.leaderLineType !== 0) {
      for (const ld of c.leaders) {
        for (const ln of ld.lines) {
          const v3 = [...ln.vertices];
          if (ld.lastLeaderPoint && (ld.hasLastPoint || true)) v3.push(ld.lastLeaderPoint);
          if (v3.length < 2) continue;
          let pts3: number[];
          if (e.leaderLineType === 2 && v3.length > 2) {
            const s = interpolateFitPoints(v3);
            pts3 = nurbsPoints(s.degree, s.knots, s.ctrl, undefined, this.localTol(m));
          } else pts3 = v3.flatMap((p) => [p.x, p.y, p.z]);
          const pts = this.xf3(m, pts3);
          const lnStyle = ln.color && !(ln.color.aci === 0 && ln.color.rgb === undefined) ? { ...rl, style: this.styleWithColor(r, ln.color, ctx) } : rl;
          // 직선 지시선의 끊기(DIMBREAK)는 그 사이를 비운다. 화살촉 방향은 원래 선에서 구한다
          if (e.leaderLineType !== 2 && ln.breaks?.length)
            for (const run of breakRuns(v3, ln.breaks)) this.stroke(this.xf3(m, run.flatMap((p) => [p.x, p.y, p.z])), false, lnStyle, ctx);
          else this.stroke(pts, false, lnStyle, ctx);
          const dir = Math.atan2(pts[1]! - pts[3]!, pts[0]! - pts[2]!);
          this.arrowAt(arrowName, { x: pts[0]!, y: pts[1]! }, dir, arrowSize, lnStyle, ctx, e);
        }
        if (e.dogleg && ld.hasDogleg !== false && ld.lastLeaderPoint && ld.doglegVector && ld.doglegLength > 0) {
          const a = applyXY(m, ld.lastLeaderPoint.x, ld.lastLeaderPoint.y, ld.lastLeaderPoint.z);
          const dv = ld.doglegVector;
          const L = ld.doglegLength;
          const b = applyXY(m, ld.lastLeaderPoint.x + dv.x * L, ld.lastLeaderPoint.y + dv.y * L, ld.lastLeaderPoint.z + dv.z * L);
          this.out.segment(a.x, a.y, b.x, b.y, rl.style);
        }
      }
    }
    if (c.text && (e.contentType === 2 || c.text.text)) {
      const t = c.text;
      const st = (t.styleHandle && this.styleByHandle.get(t.styleHandle)) || (e.textStyleHandle && this.styleByHandle.get(e.textStyleHandle)) || undefined;
      // 171 = 위 왼쪽·가운데·오른쪽 부착(문자 위치가 그 점)
      const att = t.attachment >= 1 && t.attachment <= 3 ? t.attachment : 1;
      const lay = this.opt.text.layoutMText({ text: t.text, height: c.textHeight, width: t.width, attachment: att, lineSpacingStyle: t.lineSpacingStyle, lineSpacingFactor: t.lineSpacingFactor, style: st });
      const d = t.direction;
      const l = Math.hypot(d.x, d.y) || 1;
      const ux = d.x / l;
      const uy = d.y / l;
      const p = applyXY(m, t.location.x, t.location.y, t.location.z);
      const dd = applyDir(m, ux, uy, 0);
      const ndd = applyDir(m, -uy, ux, 0);
      const world: Affine = [dd.x, dd.y, ndd.x, ndd.y, p.x, p.y];
      const textColor = t.color && !(t.color.aci === 0 && t.color.rgb === undefined) ? t.color : e.textColor;
      const rt = textColor && !(textColor.aci === 0 && textColor.rgb === undefined) ? { ...r, style: this.styleWithColor(r, textColor, ctx) } : r;
      this.emitText(lay, world, rt, ctx);
      if (e.textFrame) {
        const g = c.landingGap || 0;
        const box = [lay.minX - g, lay.minY - g, lay.maxX + g, lay.minY - g, lay.maxX + g, lay.maxY + g, lay.minX - g, lay.maxY + g];
        const q: number[] = [];
        for (let i = 0; i < 8; i += 2) q.push(world[0] * box[i]! + world[2] * box[i + 1]! + world[4], world[1] * box[i]! + world[3] * box[i + 1]! + world[5]);
        this.out.polyline(q, true, rt.style);
      }
    }
    if (c.block && (e.contentType === 1 || c.block.blockHandle)) {
      const bd = c.block;
      const blk = (bd.blockHandle && this.blockByRecord.get(bd.blockHandle)) || (e.blockHandle && this.blockByRecord.get(e.blockHandle)) || undefined;
      if (blk && !ctx.chain.includes(tableKey(blk.name))) {
        const local = multiply(translation(bd.location.x, bd.location.y, bd.location.z), multiply(rotationZ(bd.rotation), scaling(bd.scale.x || 1, bd.scale.y || 1, bd.scale.z || 1)));
        const mm = multiply(withOcs(m, bd.normal), multiply(local, translation(-blk.basePoint.x, -blk.basePoint.y, -blk.basePoint.z)));
        const bc = bd.color.aci === 0 && bd.color.rgb === undefined ? null : bd.color;
        const parent = bc ? ({ ...e, color: bc } as Entity) : e;
        this.blockContents(blk, parent, mm, ctx);
      }
    }
  }

  // -------------------------------------------------------------------------

  private hatch(e: HatchEntity, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const m = this.ocsM(ctx, e.extrusion);
    const tol = this.localTol(m);
    const loops = hatchLoops(e, tol);
    if (!loops.length) return;
    const z = e.elevation;
    // 채우기를 끄면(FILLMODE 0) 해치·그라데이션·MPOLYGON은 경계 윤곽만
    if (!this.fill) {
      for (const l of loops) this.out.polyline(this.xf(m, openRing(l), z), true, r.style);
      return;
    }
    if (e.gradient) {
      this.gradient(e, loops, m, z, r, ctx);
      return;
    }
    if (e.solid || e.type === 'MPOLYGON') {
      if (e.type === 'MPOLYGON' && !e.solid) {
        for (const l of loops) this.out.polyline(this.xf(m, l, z), true, r.style);
        if (!e.fillColor) return;
      }
      const tris = triangulateLoops(loops);
      const style = e.type === 'MPOLYGON' && e.fillColor ? this.styleWithColor(r, e.fillColor, ctx) : r.style;
      this.out.triangles(this.xf(m, tris, z), style);
      return;
    }
    let lines = e.patternLines;
    if (!lines.length) lines = userPattern(e);
    const segs = patternSegments(lines, loops, this.opt.hatchLineLimit ?? HATCH_LINE_LIMIT);
    if (!segs) {
      this.warnInc('hatch.pattern_truncated');
      return;
    }
    const w = this.xf(m, segs, z);
    for (let i = 0; i + 3 < w.length; i += 4) this.out.segment(w[i]!, w[i + 1]!, w[i + 2]!, w[i + 3]!, r.style);
  }

  /** 그라데이션: 삼각형을 잘게 나눠 색을 단계로 칠한다 */
  private gradient(e: HatchEntity, loops: number[][], m: Mat, z: number, r: Resolved, ctx: Ctx): void {
    const g = e.gradient!;
    const tris = triangulateLoops(loops);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < tris.length; i += 2) {
      minX = Math.min(minX, tris[i]!);
      maxX = Math.max(maxX, tris[i]!);
      minY = Math.min(minY, tris[i + 1]!);
      maxY = Math.max(maxY, tris[i + 1]!);
    }
    const c1 = colorRgb(g.color1);
    const c2 = g.singleColor ? tint(c1, g.tint) : colorRgb(g.color2);
    const name = g.name.toUpperCase();
    const ang = g.angle;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rad = Math.hypot(maxX - minX, maxY - minY) / 2 || 1;
    // 방향 범위
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const l of loops)
      for (let i = 0; i < l.length; i += 2) {
        const t = (l[i]! - cx) * ux + (l[i + 1]! - cy) * uy;
        tMin = Math.min(tMin, t);
        tMax = Math.max(tMax, t);
      }
    const span = tMax - tMin || 1;
    const fAt = (x: number, y: number): number => {
      const dx = x - cx;
      const dy = y - cy;
      const t = (dx * ux + dy * uy - tMin) / span;
      switch (name) {
        case 'CYLINDER':
          return 1 - Math.abs(t * 2 - 1);
        case 'INVCYLINDER':
          return Math.abs(t * 2 - 1);
        case 'SPHERICAL':
          return 1 - Math.min(1, Math.hypot(dx, dy) / rad);
        case 'INVSPHERICAL':
          return Math.min(1, Math.hypot(dx, dy) / rad);
        case 'HEMISPHERICAL':
          return 1 - Math.min(1, Math.hypot(dx, dy + rad) / (rad * 2));
        case 'INVHEMISPHERICAL':
          return Math.min(1, Math.hypot(dx, dy + rad) / (rad * 2));
        case 'CURVED':
          return Math.sqrt(Math.max(0, t));
        case 'INVCURVED':
          return 1 - Math.sqrt(Math.max(0, 1 - t));
        default:
          return t;
      }
    };
    const LEVELS = 48;
    const styleFor = new Map<number, number>();
    const levelStyle = (f: number) => {
      const k = Math.max(0, Math.min(LEVELS, Math.round(f * LEVELS)));
      let s = styleFor.get(k);
      if (s === undefined) {
        const t = k / LEVELS;
        const rgb = lerpRgb(c1, c2, t);
        s = this.styleWithColor(r, { aci: 256, rgb }, ctx);
        styleFor.set(k, s);
      }
      return s;
    };
    const maxEdge = Math.max(maxX - minX, maxY - minY) / 24;
    const emit = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, depth: number) => {
      const e01 = Math.hypot(x1 - x0, y1 - y0);
      const e12 = Math.hypot(x2 - x1, y2 - y1);
      const e20 = Math.hypot(x0 - x2, y0 - y2);
      const longest = Math.max(e01, e12, e20);
      if (longest > maxEdge && depth < 10) {
        if (longest === e01) {
          const mx = (x0 + x1) / 2;
          const my = (y0 + y1) / 2;
          emit(x0, y0, mx, my, x2, y2, depth + 1);
          emit(mx, my, x1, y1, x2, y2, depth + 1);
        } else if (longest === e12) {
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          emit(x0, y0, x1, y1, mx, my, depth + 1);
          emit(x0, y0, mx, my, x2, y2, depth + 1);
        } else {
          const mx = (x2 + x0) / 2;
          const my = (y2 + y0) / 2;
          emit(x0, y0, x1, y1, mx, my, depth + 1);
          emit(mx, my, x1, y1, x2, y2, depth + 1);
        }
        return;
      }
      const s = levelStyle(fAt((x0 + x1 + x2) / 3, (y0 + y1 + y2) / 3));
      const q = this.xf(m, [x0, y0, x1, y1, x2, y2], z);
      this.out.triangle(q[0]!, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!, s);
    };
    for (let i = 0; i + 5 < tris.length; i += 6) emit(tris[i]!, tris[i + 1]!, tris[i + 2]!, tris[i + 3]!, tris[i + 4]!, tris[i + 5]!, 0);
  }

  private image(e: Extract<Entity, { type: 'IMAGE' | 'WIPEOUT' }>, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    // 경계(픽셀 좌표, 원점은 이미지 왼쪽 위이고 y는 아래로. 모서리 = -0.5)
    let bnd = e.clipBoundary.map((p) => [p.x, p.y]);
    if (!e.clipping || bnd.length < 2) bnd = [
      [-0.5, -0.5],
      [e.imageSize.x - 0.5, -0.5],
      [e.imageSize.x - 0.5, e.imageSize.y - 0.5],
      [-0.5, e.imageSize.y - 0.5],
    ];
    else if (bnd.length === 2) {
      const [a, b] = bnd as [number[], number[]];
      bnd = [
        [a[0]!, a[1]!],
        [b[0]!, a[1]!],
        [b[0]!, b[1]!],
        [a[0]!, b[1]!],
      ];
    }
    // 픽셀 → 월드: insert + (px + 0.5) * u + (H - 0.5 - py) * v (u는 오른쪽, v는 위쪽)
    const u = e.uVector;
    const v = e.vVector;
    const H = e.imageSize.y;
    const pts3: number[] = [];
    for (const [px, py] of bnd) {
      const x = px! + 0.5;
      const y = H - 0.5 - py!;
      pts3.push(e.insert.x + u.x * x + v.x * y, e.insert.y + u.y * x + v.y * y, e.insert.z + u.z * x + v.z * y);
    }
    if (pts3.length >= 6 && pts3[0] === pts3[pts3.length - 3] && pts3[1] === pts3[pts3.length - 2]) pts3.length -= 3;
    const w = this.xf3(ctx.m, pts3);
    if (e.type === 'WIPEOUT') {
      const tris = triangulateLoops([w]);
      this.out.triangles(tris, this.backgroundStyle(r));
      // 테두리: 0 숨김, 1 표시·출력, 2 표시만
      const frame = this.frame('wipeout');
      if (frame === 1 || frame === 2) this.out.polyline(w, true, frame === 2 ? this.noPlotStyle(r.style) : r.style);
      return;
    }
    const key = imageKey(this.doc, e);
    const have = !!key && !!this.opt.images?.has(key);
    if (have && e.displayFlags & 1) {
      // 연결된 파일: 경계를 픽셀 좌표에서 삼각형으로 나눠 위치·UV를 함께 넣는다
      const px: number[] = [];
      for (const [x, y] of bnd) px.push(x!, y!);
      if (px.length >= 6 && px[0] === px[px.length - 2] && px[1] === px[px.length - 1]) px.length -= 2;
      const sx = e.imageSize.x || 1;
      const sy = e.imageSize.y || 1;
      // 반전 자르기(290): 이미지 전체에서 경계 안을 뺀다
      const tri = e.clipping && e.clipInverted ? triangulateLoops([[-0.5, -0.5, sx - 0.5, -0.5, sx - 0.5, sy - 0.5, -0.5, sy - 0.5], px]) : triangulateLoops([px]);
      const out: number[] = [];
      for (let i = 0; i + 1 < tri.length; i += 2) {
        const x = tri[i]! + 0.5;
        const y = H - 0.5 - tri[i + 1]!;
        const q = applyXY(ctx.m, e.insert.x + u.x * x + v.x * y, e.insert.y + u.y * x + v.y * y, e.insert.z + u.z * x + v.z * y);
        out.push(q.x, q.y, x / sx, 1 - y / sy);
      }
      this.out.image(key, out, r.style, { brightness: e.brightness, contrast: e.contrast, fade: e.fade, transparent: (e.displayFlags & 8) !== 0 });
    }
    // 테두리: IMAGEFRAME 0이면 파일이 있을 때 숨기고, 2면 화면에만 보인다
    const frame = this.frame('image');
    if (!have || frame !== 0) this.out.polyline(w, true, have && frame === 2 ? this.noPlotStyle(r.style) : r.style);
    // 파일이 없으면 대각선으로 자리를 표시한다
    if (!have && w.length >= 8) {
      this.out.segment(w[0]!, w[1]!, w[4]!, w[5]!, r.style);
      this.out.segment(w[2]!, w[3]!, w[6]!, w[7]!, r.style);
    }
  }

  /**
   * 언더레이: 지역 좌표(삽입점 기준, 축척 전, PDF는 1 = 1인치, 페이지 왼쪽 아래가 원점)를 삽입·회전·축척으로 놓는다.
   * PDF 파일이 연결됐으면 페이지 그림을 자르기 경계대로 그리고, 아니면 경계만 그린다.
   */
  private underlay(e: UnderlayEntity, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const m = multiply(this.ocsM(ctx, e.extrusion), multiply(translation(e.insert.x, e.insert.y, e.insert.z), multiply(rotationZ(e.rotation), scaling(e.scale.x || 1, e.scale.y || 1, 1))));
    let clip: number[] | null = null;
    if (e.clipBoundary.length >= 2) {
      clip = e.clipBoundary.flatMap((p) => [p.x, p.y]);
      if (clip.length === 4) clip = [clip[0]!, clip[1]!, clip[2]!, clip[1]!, clip[2]!, clip[3]!, clip[0]!, clip[3]!];
      if (clip.length >= 6 && clip[0] === clip[clip.length - 2] && clip[1] === clip[clip.length - 1]) clip.length -= 2;
      if (clip.length < 6) clip = null;
    }
    const clipOn = !!clip && (e.flags & 1) !== 0;
    const key = e.type === 'PDFUNDERLAY' ? pdfUnderlayKey(this.doc, e) : '';
    const page = key ? this.opt.pdfPages?.get(key) : undefined;
    if (!page) {
      if (clip) this.out.polyline(this.xf(m, clip), true, r.style);
      return;
    }
    const [w, h] = page;
    const rect = [0, 0, w, 0, w, h, 0, h];
    if (e.flags & 2) {
      // 그릴 영역: 자르기 안쪽(또는 반전이면 페이지에서 자르기를 뺀 곳)을 페이지 안으로
      const inverted = clipOn && (e.flags & 16) !== 0;
      const tris = clipOn ? triangulateLoops(inverted ? [rect, clip!] : [clip!]) : [0, 0, w, 0, w, h, 0, 0, w, h, 0, h];
      const out: number[] = [];
      for (let i = 0; i + 5 < tris.length; i += 6) {
        let poly = tris.slice(i, i + 6);
        // 반시계로
        if ((poly[2]! - poly[0]!) * (poly[5]! - poly[1]!) - (poly[3]! - poly[1]!) * (poly[4]! - poly[0]!) < 0) poly = [poly[0]!, poly[1]!, poly[4]!, poly[5]!, poly[2]!, poly[3]!];
        if (clipOn) poly = clipConvex(poly, rect);
        for (let k = 2; k * 2 + 1 < poly.length; k++) {
          for (const j of [0, k - 1, k]) {
            const x = poly[j * 2]!;
            const y = poly[j * 2 + 1]!;
            const q = applyXY(m, x, y, 0);
            out.push(q.x, q.y, x / w, 1 - y / h);
          }
        }
      }
      this.out.image(key, out, r.style, { brightness: 50, contrast: 50, fade: Math.max(0, Math.min(80, e.fade || 0)), transparent: true, mono: (e.flags & 4) !== 0, adjust: (e.flags & 8) !== 0 });
    }
    // 테두리: $PDFFRAME 0이면 숨긴다(기본 1)
    if (this.doc.header.get('$PDFFRAME') !== 0) this.out.polyline(this.xf(m, clipOn ? clip! : rect), true, r.style);
  }

  private mline(e: MLineEntity, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const st = (e.styleHandle && this.mlineStyles.get(e.styleHandle)) || this.mlineStyles.get('NAME:' + tableKey(e.styleName));
    if (e.vertices.length < 2) return;
    // 요소 선(끊기 반영)·마구리·연결부·채우기는 편집 명령과 같은 계산을 쓴다
    const d = mlineDrawing(e, st ?? null);
    const z = e.vertices[0]!.position.z;
    const W = (pl: readonly Vec2[]): number[] => {
      const out: number[] = [];
      for (const p of pl) {
        const q = applyXY(ctx.m, p.x, p.y, z);
        out.push(q.x, q.y);
      }
      return out;
    };
    d.elements.forEach((pls, k) => {
      const se = st?.elements[k];
      let er = r;
      if (se) {
        const color = se.color.aci === 256 && se.color.rgb === undefined ? e.color : se.color.aci === 0 && se.color.rgb === undefined ? e.color : se.color;
        er = this.resolve({ layer: e.layer, color, linetype: se.linetype.toUpperCase() === 'BYLAYER' ? e.linetype : se.linetype, lineweight: e.lineweight, ltscale: e.ltscale, transparency: e.transparency }, ctx);
      }
      for (const pl of pls) this.stroke(W(pl), false, er, ctx);
    });
    for (const pl of [...d.caps, ...d.joints]) this.stroke(W(pl), false, r, ctx);
    if (st && d.fill.length && this.fill) this.out.triangles(triangulateLoops(d.fill.map(W)), this.styleWithColor(r, st.fillColor, ctx));
  }
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function colorRgb(c: CadColor): number {
  if (c.rgb !== undefined) return c.rgb;
  return ACI_RGB[c.aci & 255] ?? 0xffffff;
}

function tint(rgb: number, t: number): number {
  // 한 가지 색 그라데이션: 0 = 어둡게(검정), 1 = 밝게(흰색)
  const target = t >= 0.5 ? 0xffffff : 0x000000;
  const k = Math.abs(t - 0.5) * 2;
  return lerpRgb(rgb, target, k);
}

function lerpRgb(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}

/** 문서의 한 공간을 표시 목록으로 */
/** 래스터 이미지 파일 열쇠: IMAGEDEF 파일 이름의 마지막 부분(소문자) */
export function imageKey(doc: CadDocument, e: { imageDef?: string }): string {
  const d = e.imageDef ? doc.objects.get(e.imageDef) : undefined;
  const f = d && d.type === 'IMAGEDEF' ? (d as { fileName: string }).fileName : '';
  return f ? f.replace(/^.*[\\/]/, '').toLowerCase() : '';
}

/** PDF 언더레이 열쇠: 'pdf:' + 정의 파일 이름의 마지막 부분(소문자) + '#' + 페이지 번호 */
export function pdfUnderlayKey(doc: CadDocument, e: { definition?: string }): string {
  const d = e.definition ? doc.objects.get(e.definition) : undefined;
  if (!d || d.type !== 'PDFDEFINITION') return '';
  const def = d as UnderlayDefObject;
  const f = def.fileName.replace(/^.*[\\/]/, '').toLowerCase();
  return f ? `pdf:${f}#${pdfPageNumber(def.name)}` : '';
}

/** 정의 이름(페이지 번호 문자열) → 1부터 세는 페이지 번호 */
export function pdfPageNumber(name: string): number {
  const n = Number.parseInt(name, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** 공간의 범위 대각선(머리말 $EXTMIN·$EXTMAX, 없으면 1000) */
export function spaceExtentSize(doc: CadDocument, blockName: string): number {
  const model = tableKey(blockName) === '*MODEL_SPACE';
  const mn = doc.header.get(model ? '$EXTMIN' : '$PEXTMIN');
  const mx = doc.header.get(model ? '$EXTMAX' : '$PEXTMAX');
  let diag = 0;
  if (mn && mx && typeof mn === 'object' && typeof mx === 'object') {
    diag = Math.hypot(mx.x - mn.x, mx.y - mn.y);
    if (!(diag > 0 && diag < 1e15)) diag = 0;
  }
  return diag || 1000;
}

/** 기본 장면의 곡선 정밀도(도면 단위) */
export function spaceTolerance(doc: CadDocument, blockName: string): number {
  return spaceExtentSize(doc, blockName) * 2e-5;
}

export function buildSpace(doc: CadDocument, blockName: string, opt: BuildOptions): SpaceScene {
  return new SceneBuilder(doc, opt).build(blockName);
}

