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
  TextEntity,
  TextStyle,
  Vec3,
} from '../core/model';
import { BYBLOCK, BYLAYER, tableKey } from '../core/model';
import { DIM_VAR_CODES, DIM_VAR_DEFAULTS } from '../core/dimvars';
import { ACI_RGB } from '../core/color';
import {
  type Mat,
  applyDir,
  applyXY,
  identity,
  multiply,
  ocsMatrix,
  planarScale,
  rotationZ,
  scaling,
  translation,
  withOcs,
} from '../geom/matrix';
import { TAU, arcPoints, bulgePoints, ccwSweep, interpolateFitPoints, nurbsPoints } from '../geom/curves';
import { type DashPattern, dashPolyline } from './linetype';
import { DisplayListBuilder, type DisplayList } from './displaylist';
import { ColorKind, type LayerState, StyleTable, WidthKind, hiddenStyleSpec, layerStates } from './styles';
import { HATCH_LINE_LIMIT, hatchLoops, patternSegments, triangulateLoops, userPattern } from './hatch';
import { builtinArrow } from './arrows';
import { type Affine, type TextEngine, type TextLayout, affMul } from '../text/layout';

export interface BuildOptions {
  text: TextEngine;
  /** 곡선 정밀도(도면 단위). 없으면 도면 범위로 정한다 */
  tolerance?: number;
  /** 해치 무늬 선 상한 */
  hatchLineLimit?: number;
}

export interface SpaceScene {
  list: DisplayList;
  styles: StyleTable;
  layers: LayerState[];
  layerIndex: Map<string, number>;
  warnings: { code: string; count: number; detail?: Record<string, unknown> }[];
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
  private fill = true;
  private extentSize = 100;

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
    this.ltscale = num('$LTSCALE', 1) || 1;
    this.pdmode = num('$PDMODE', 0);
    this.pdsize = num('$PDSIZE', 0);
    this.fill = num('$FILLMODE', 1) !== 0;
  }

  private warnInc(code: string, n = 1): void {
    this.warn.set(code, (this.warn.get(code) ?? 0) + n);
  }

  private layerOf(name: string): number {
    const i = this.layerIndex.get(tableKey(name));
    if (i !== undefined) return i;
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

  private resolve(e: Entity | { layer: string; color: CadColor; linetype: string; lineweight: number; ltscale: number; transparency: number }, ctx: Ctx, override?: { color?: CadColor; flags?: number }): Resolved {
    const layer = this.effLayer(e, ctx);
    const col = this.colorSpec(override?.color ?? e.color, layer, ctx);
    let lw: { kind: WidthKind; value: number };
    if (e.lineweight === -1) lw = { kind: WidthKind.Layer, value: layer };
    else if (e.lineweight === -2) lw = ctx.byLineweight;
    else if (e.lineweight === -3 || e.lineweight < 0) lw = { kind: WidthKind.Default, value: 0 };
    else lw = { kind: WidthKind.Value, value: e.lineweight };
    let alpha = e.transparency;
    if (alpha === -2) alpha = ctx.byAlpha;
    let lt = e.linetype || 'ByLayer';
    const ltu = lt.toUpperCase();
    if (ltu === 'BYLAYER') lt = this.layers[layer] ? this.doc.layers.get(tableKey(this.layers[layer]!.name))?.linetype ?? 'Continuous' : 'Continuous';
    else if (ltu === 'BYBLOCK') lt = ctx.byLinetype;
    const style = this.styles.intern({
      colorKind: col.kind,
      color: col.value,
      layer,
      freezeLayers: ctx.freeze,
      widthKind: lw.kind,
      width: lw.value,
      alpha,
      flags: override?.flags ?? 0,
    });
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

  private patternCache = new Map<string, DashPattern | null>();

  private pattern(lt: string, scale: number): DashPattern | null {
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
    dashPolyline(
      pts,
      closed,
      pat,
      (x0, y0, x1, y1) => this.out.segment(x0, y0, x1, y1, r.style),
      (x, y, ang, t) => {
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
    for (const g of lay.glyphs) {
      const m = affMul(world, g.m);
      const style = g.color ? this.styleWithColor(r, g.color, ctx) : r.style;
      const geom = g.geom;
      const bbox = [geom.minX, geom.minY, geom.maxX, geom.maxY] as const;
      if (geom.segs) {
        if (geom.segs.length) this.out.glyph(geom, 1, geom.segs, m, bbox, style);
      } else if (geom.tris && geom.tris.length) this.out.glyph(geom, 0, geom.tris, m, bbox, style);
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

  /** 공간의 곡선 정밀도를 정한다(도면 범위 대각선 × 2e-5) */
  prepare(blockName: string): void {
    let ext = this.opt.tolerance;
    if (!ext) {
      const mn = this.doc.header.get(tableKey(blockName) === '*MODEL_SPACE' ? '$EXTMIN' : '$PEXTMIN');
      const mx = this.doc.header.get(tableKey(blockName) === '*MODEL_SPACE' ? '$EXTMAX' : '$PEXTMAX');
      let diag = 0;
      if (mn && mx && typeof mn === 'object' && typeof mx === 'object') {
        diag = Math.hypot(mx.x - mn.x, mx.y - mn.y);
        if (!(diag > 0 && diag < 1e15)) diag = 0;
      }
      if (!diag) diag = 1000;
      this.extentSize = diag;
      ext = diag * 2e-5;
    }
    this.tol = ext;
  }

  build(blockName: string): SpaceScene {
    this.out = new DisplayListBuilder((s) => this.styles.isTransparent(s, this.layers));
    const block = this.doc.blocks.get(tableKey(blockName));
    const ents = block ? this.ordered(block).filter((e) => e.type !== 'VIEWPORT' || (e.id !== 1 && e.status !== 1)) : [];
    this.prepare(blockName);
    const N = ents.length;
    for (let i = 0; i < N; i++) {
      const e = ents[i]!;
      const z1 = 1 - (i + 1) / (N + 2);
      const z0 = 1 - (i + 2) / (N + 2);
      const ctx: Ctx = {
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
        z0,
        z1,
      };
      this.out.setDepth(z1);
      try {
        this.entity(e, ctx);
      } catch (err) {
        this.warnInc('entity.failed');
        void err;
      }
      this.out.endEntity(e.handle);
    }
    const warnings = [...this.warn.entries()].map(([code, count]) => ({ code, count }));
    return { list: this.out.finish(), styles: this.styles, layers: this.layers, layerIndex: this.layerIndex, warnings };
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
      case 'TOLERANCE': {
        const r = this.resolve(e, ctx);
        const dv = this.dimVars(e.dimStyle, undefined);
        const h = num(dv.DIMTXT, 2.5) * (num(dv.DIMSCALE, 1) || 1);
        const ang = Math.atan2(e.direction.y, e.direction.x);
        const plain = e.text.replace(/\{\\F[^;]*;([^}]*)\}/g, '$1').replace(/%%v/gi, ' | ').replace(/\^J/g, '\\P');
        const lay = this.opt.text.layoutMText({ text: plain, height: h, width: 0, attachment: 4, lineSpacingStyle: 1, lineSpacingFactor: 1, style: this.doc.textStyles.get(tableKey(String(dv.DIMTXSTY || 'Standard'))) });
        const m = this.ocsM(ctx, e.extrusion);
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const p = this.planar(m, e.insert.z);
        const world = affMul(p, [ca, sa, -sa, ca, e.insert.x, e.insert.y]);
        this.emitText(lay, world, r, ctx);
        const g = h * 0.5;
        const box = [lay.minX - g, lay.minY - g, lay.maxX + g, lay.minY - g, lay.maxX + g, lay.maxY + g, lay.minX - g, lay.maxY + g];
        const q: number[] = [];
        for (let i = 0; i < box.length; i += 2) q.push(world[0] * box[i]! + world[2] * box[i + 1]! + world[4], world[1] * box[i]! + world[3] * box[i + 1]! + world[5]);
        this.out.polyline(q, true, r.style);
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
      case 'DGNUNDERLAY': {
        if (e.clipBoundary.length < 2) return;
        const r = this.resolve(e, ctx);
        let pts = e.clipBoundary.flatMap((p) => [p.x, p.y]);
        if (pts.length === 4) pts = [pts[0]!, pts[1]!, pts[2]!, pts[1]!, pts[2]!, pts[3]!, pts[0]!, pts[3]!];
        const m = multiply(this.ocsM(ctx, e.extrusion), multiply(translation(e.insert.x, e.insert.y, e.insert.z), multiply(rotationZ(e.rotation), scaling(e.scale.x, e.scale.y, 1))));
        this.out.polyline(this.xf(m, pts), true, r.style);
        return;
      }
      case 'SHAPE':
        this.warnInc('shape.unsupported');
        return;
      case 'UNKNOWN':
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
    const vs = e.vertices;
    if (!vs.length) return;
    const wide = e.constantWidth > 0 || vs.some((v) => v.startWidth > 0 || v.endWidth > 0);
    this.polyCommon(
      vs.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge, sw: v.startWidth || e.constantWidth, ew: v.endWidth || e.constantWidth })),
      e.closed,
      e.plinegen,
      wide,
      m,
      e.elevation,
      r,
      ctx,
    );
  }

  private polyCommon(
    vs: { x: number; y: number; bulge: number; sw: number; ew: number }[],
    closed: boolean,
    plinegen: boolean,
    wide: boolean,
    m: Mat,
    z: number,
    r: Resolved,
    ctx: Ctx,
  ): void {
    const tol = this.localTol(m);
    const n = vs.length;
    if (n === 1) {
      const p = applyXY(m, vs[0]!.x, vs[0]!.y, z);
      this.out.segment(p.x, p.y, p.x, p.y, r.style);
      return;
    }
    const segCount = closed ? n : n - 1;
    if (wide && this.fill) {
      for (let i = 0; i < segCount; i++) {
        const a = vs[i]!;
        const b = vs[(i + 1) % n]!;
        const pts: number[] = [a.x, a.y];
        bulgePoints(a.x, a.y, b.x, b.y, a.bulge, tol, pts);
        this.wideStrip(pts, a.sw, a.ew, m, z, r);
      }
      return;
    }
    if (plinegen || !this.pattern(r.linetype, 1)) {
      const pts: number[] = [vs[0]!.x, vs[0]!.y];
      for (let i = 0; i < segCount; i++) {
        const a = vs[i]!;
        const b = vs[(i + 1) % n]!;
        bulgePoints(a.x, a.y, b.x, b.y, a.bulge, tol, pts);
      }
      if (closed) pts.length -= 2;
      this.stroke(this.xf(m, pts, z), closed, r, ctx);
      return;
    }
    // PLINEGEN이 없으면 무늬가 정점마다 다시 시작한다.
    for (let i = 0; i < segCount; i++) {
      const a = vs[i]!;
      const b = vs[(i + 1) % n]!;
      const pts: number[] = [a.x, a.y];
      bulgePoints(a.x, a.y, b.x, b.y, a.bulge, tol, pts);
      this.stroke(this.xf(m, pts, z), false, r, ctx);
    }
  }

  /** 폭 있는 선분(로컬 점 배열, 시작·끝 폭) → 삼각형 띠 */
  private wideStrip(pts: number[], sw: number, ew: number, m: Mat, z: number, r: Resolved): void {
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
      const curveFit = (e.flags & 2) !== 0;
      this.polyCommon(
        vs.map((v) => ({ x: v.location.x, y: v.location.y, bulge: curveFit ? 0 : v.bulge, sw: v.startWidth, ew: v.endWidth })),
        (e.flags & 1) !== 0,
        (e.flags & 128) !== 0,
        wide,
        m,
        e.elevation,
        r,
        ctx,
      );
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
    if (e.type === 'ATTRIB' && (e as { attFlags?: number }).attFlags! & 1) return;
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
    this.emitText(lay, this.planar(m, e.insert.z), r, ctx);
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
    const local: Mat = Float64Array.of(ux.x, uy.x, n.x, e.insert.x, ux.y, uy.y, n.y, e.insert.y, ux.z, uy.z, n.z, e.insert.z);
    const m = multiply(ctx.dimBlock ? ctx.m : ctx.m, local);
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
        const local = multiply(
          translation(e.insert.x, e.insert.y, e.insert.z),
          multiply(rotationZ(e.rotation), multiply(translation(cI * e.columnSpacing, rI * e.rowSpacing, 0), scaling(sx, sy, sz))),
        );
        const m = multiply(om, multiply(local, translation(-b.basePoint.x, -b.basePoint.y, -b.basePoint.z)));
        this.blockContents(b, e, m, ctx);
      }
    // 속성은 블록 참조와 같은 공간에 있다
    if (e.attribs.length) {
      const r = this.resolve(e, ctx);
      const child = this.childCtx(e, ctx, r, ctx.m);
      for (const a of e.attribs) this.text(a as unknown as TextEntity, { ...child, inBlock: false });
    }
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
      freeze: ctx.freeze.includes(r.layer) ? ctx.freeze : [...ctx.freeze, r.layer],
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
    const b = e.block ? this.doc.blocks.get(tableKey(e.block)) : undefined;
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
    const blk = name ? this.doc.blocks.get(tableKey(name)) : undefined;
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
      if (seg > asz * 2 || seg > 1e-9) this.arrowAt(String(v.DIMLDRBLK || v.DIMBLK || ''), { x: pts[0]!, y: pts[1]! }, dir, asz, rr, ctx, e);
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
          this.stroke(pts, false, lnStyle, ctx);
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
    // 경계(픽셀 좌표, 이미지 왼쪽 아래 = -0.5, -0.5)
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
    // 픽셀 → 월드: insert + (px + 0.5) * u + (py + 0.5) * v (WIPEOUT·IMAGE 모두 v는 위쪽)
    const u = e.uVector;
    const v = e.vVector;
    const pts3: number[] = [];
    for (const [px, py] of bnd) {
      const x = px! + 0.5;
      const y = py! + 0.5;
      pts3.push(e.insert.x + u.x * x + v.x * y, e.insert.y + u.y * x + v.y * y, e.insert.z + u.z * x + v.z * y);
    }
    if (pts3.length >= 6 && pts3[0] === pts3[pts3.length - 3] && pts3[1] === pts3[pts3.length - 2]) pts3.length -= 3;
    const w = this.xf3(ctx.m, pts3);
    if (e.type === 'WIPEOUT') {
      const tris = triangulateLoops([w]);
      this.out.triangles(tris, this.backgroundStyle(r));
      const frame = this.doc.header.get('$WIPEOUTFRAME');
      if (frame === 1) this.out.polyline(w, true, r.style);
      return;
    }
    this.out.polyline(w, true, r.style);
    // 이미지 파일은 없으므로 대각선으로 자리를 표시한다
    if (w.length >= 8) {
      this.out.segment(w[0]!, w[1]!, w[4]!, w[5]!, r.style);
      this.out.segment(w[2]!, w[3]!, w[6]!, w[7]!, r.style);
    }
  }

  private mline(e: MLineEntity, ctx: Ctx): void {
    const r = this.resolve(e, ctx);
    const st = (e.styleHandle && this.mlineStyles.get(e.styleHandle)) || this.mlineStyles.get('NAME:' + tableKey(e.styleName));
    const nEl = e.elementCount || e.vertices[0]?.elements.length || 0;
    const closed = (e.flags & 2) !== 0;
    const m = ctx.m;
    const vs = e.vertices;
    if (vs.length < 2) return;
    const elemPts: number[][] = [];
    for (let k = 0; k < nEl; k++) {
      const pts: number[] = [];
      for (const v of vs) {
        const el = v.elements[k];
        const d = el?.params[0] ?? 0;
        const p = applyXY(m, v.position.x + v.miter.x * d, v.position.y + v.miter.y * d, v.position.z + v.miter.z * d);
        pts.push(p.x, p.y);
      }
      elemPts.push(pts);
      const se = st?.elements[k];
      let er = r;
      if (se) {
        const color = se.color.aci === 256 && se.color.rgb === undefined ? e.color : se.color.aci === 0 && se.color.rgb === undefined ? e.color : se.color;
        er = this.resolve({ layer: e.layer, color, linetype: se.linetype.toUpperCase() === 'BYLAYER' ? e.linetype : se.linetype, lineweight: e.lineweight, ltscale: e.ltscale, transparency: e.transparency }, ctx);
      }
      this.stroke(pts, closed, er, ctx);
    }
    if (st && !closed && elemPts.length >= 2) {
      const first = elemPts[0]!;
      const last = elemPts[elemPts.length - 1]!;
      if (st.flags & 16) this.out.segment(first[0]!, first[1]!, last[0]!, last[1]!, r.style);
      const n = first.length;
      if (st.flags & 256) this.out.segment(first[n - 2]!, first[n - 1]!, last[n - 2]!, last[n - 1]!, r.style);
      if (st.flags & 1) {
        const ring = [...first];
        for (let i = last.length - 2; i >= 0; i -= 2) ring.push(last[i]!, last[i + 1]!);
        const tris = triangulateLoops([ring]);
        this.out.triangles(tris, this.styleWithColor(r, st.fillColor, ctx));
      }
    }
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
export function buildSpace(doc: CadDocument, blockName: string, opt: BuildOptions): SpaceScene {
  return new SceneBuilder(doc, opt).build(blockName);
}

