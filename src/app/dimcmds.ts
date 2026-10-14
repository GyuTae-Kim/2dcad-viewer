/**
 * 치수 작성: DIMLINEAR, DIMALIGNED, DIMANGULAR, DIMRADIUS, DIMDIAMETER, DIMORDINATE, DIMARC
 * 치수 그림(익명 *D 블록)은 src/edit/dim의 생성기가 치수 스타일대로 만든다.
 * DIMASSOC가 2이면 객체 스냅으로 찍은 점·고른 객체에 치수를 연관시킨다(dimassoc.ts), 0이면 분해된 치수를 만든다.
 * 프롬프트와 옵션은 AutoCAD 2026 한국어판을 따른다.
 */
import type { BlockDef, BlockRecord, CadDocument, DimensionEntity, Entity, Layer, Vec3 } from '../core/model';
import { tableKey } from '../core/model';
import { formatLength } from '../core/units';
import {
  createAlignedDimension,
  createAngular2LineDimension,
  createAngularDimension,
  createArcLengthDimension,
  createDiameterDimension,
  createLinearDimension,
  createOrdinateDimension,
  createRadialDimension,
  dimensionText,
  generateDimensionGeometry,
  nextDimBlockName,
  rawDimVars,
} from '../edit/dim';
import type { DimKindName } from '../edit/dim/format';
import { OSNAP, type PointRef, circlePointRef } from '../edit/dim/assoc';
import type { EditOp } from '../edit/session';
import type { App, CommandContext, Keyword } from './app';
import { finishNewDimension, inheritedRef, newDimensionAssocOps, objectRef, pointRef, snapNewDimension } from './dimassoc';
import type { DocState } from './docstate';
import { textDialog } from './draw';
import type { OverlayGeom, Pt } from './view';

const v3 = (p: Pt): Vec3 => ({ x: p.x, y: p.y, z: 0 });

/** 블록 이름이 이 치수 하나만 쓰는 익명 블록인지 */
function ownBlock(doc: CadDocument, dim: DimensionEntity): boolean {
  if (!/^\*D/i.test(dim.block)) return false;
  let n = 0;
  for (const b of doc.blocks.values())
    for (const e of b.entities) if (e.type === 'DIMENSION' && tableKey(e.block) === tableKey(dim.block) && e.handle !== dim.handle) n++;
  return n === 0;
}

/**
 * 치수 객체의 그림을 (다시) 만들어 블록 작업과 함께 돌려준다.
 * reuse가 참이면 이 치수만 쓰는 블록을 그대로 바꾸고, 아니면 새 *D 블록을 만든다.
 * 치수 객체의 block·textMid·measurement는 여기서 채운다(객체 자체를 넣는 작업은 부르는 쪽이 만든다).
 */
export function dimensionBlockOps(st: DocState, dim: DimensionEntity, reuse: boolean, extraNames: Set<string> = new Set()): EditOp[] {
  const doc = st.doc;
  const s = st.session;
  const g = generateDimensionGeometry(doc, dim);
  dim.textMid = g.textMid;
  dim.measurement = g.measurement;
  const ops: EditOp[] = [];
  // 기본 화살촉 블록, 정의점 도면층
  for (const ab of g.arrowBlocks) {
    const key = tableKey(ab.name);
    if (doc.blocks.has(key) || extraNames.has(key)) continue;
    extraNames.add(key);
    const rec: BlockRecord = { name: ab.name, handle: s.newHandle(), flags: 0, insertUnits: 0, explodable: true, scalable: true };
    for (const e of ab.entities) {
      e.handle = s.newHandle();
      e.owner = rec.handle;
    }
    ops.push({ kind: 'blockRecord', key, before: null, after: rec }, { kind: 'blockDef', key, before: null, after: { name: ab.name, handle: s.newHandle(), recordHandle: rec.handle, basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: ab.entities, endHandle: s.newHandle() } });
  }
  const dl = tableKey(g.defpointsLayer);
  if (g.defpointsLayer && !doc.layers.has(dl) && !extraNames.has(`layer:${dl}`)) {
    extraNames.add(`layer:${dl}`);
    const l0 = doc.layers.get('0');
    const layer: Layer = { name: g.defpointsLayer, handle: s.newHandle(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: false, transparency: 255, plotStyle: l0?.plotStyle };
    ops.push({ kind: 'layer', key: dl, before: null, after: layer });
  }
  // 치수 블록
  const before = reuse && dim.block && ownBlock(doc, dim) ? doc.blocks.get(tableKey(dim.block)) : undefined;
  let name = before?.name ?? '';
  if (!name) {
    name = nextDimBlockName(doc);
    while (extraNames.has(tableKey(name))) name = `*D${Number(name.slice(2)) + 1}`;
    extraNames.add(tableKey(name));
  }
  const key = tableKey(name);
  let recordHandle = before?.recordHandle ?? doc.blockRecords.get(key)?.handle;
  if (!recordHandle) {
    recordHandle = s.newHandle();
    ops.push({ kind: 'blockRecord', key, before: null, after: { name, handle: recordHandle, flags: 1, insertUnits: 0, explodable: true, scalable: true } });
  }
  for (const e of g.entities) {
    e.handle = s.newHandle();
    e.owner = recordHandle;
  }
  const def: BlockDef = { name, handle: before?.handle ?? s.newHandle(), recordHandle, basePoint: { x: 0, y: 0, z: 0 }, flags: 1, entities: g.entities, endHandle: before?.endHandle ?? s.newHandle() };
  ops.push({ kind: 'blockDef', key, before: before ?? null, after: def });
  dim.block = name;
  return ops;
}

/**
 * 새 치수를 지금 공간에 넣는다. refs는 점 참조 번호 차례의 연관 참조(DIMASSOC 2일 때만 쓴다).
 * 넣은 작업 수를 돌려준다(명령 안의 명령 취소용).
 */
function addDimension(app: App, ctx: CommandContext, dim: DimensionEntity, label: string, refs: readonly (PointRef | null)[] = []): number {
  const st = app.active!;
  const assoc = snapNewDimension(app, dim, refs);
  const blockOps = dimensionBlockOps(st, dim, false);
  const space = st.doc.blocks.get(st.space);
  dim.handle = st.session.newHandle();
  if (space?.recordHandle) dim.owner = space.recordHandle;
  dim.paperSpace = /^\*PAPER_SPACE/i.test(st.space) ? true : undefined;
  const assocOps = assoc ? newDimensionAssocOps(app, dim, refs) : [];
  const ops: EditOp[] = [...blockOps, { kind: 'add', block: st.space, entity: dim }, ...assocOps];
  st.session.commit({ label, ops, group: ctx.group });
  const shownDim = { ...dim };
  const n = ops.length + finishNewDimension(app, ctx, dim.handle, label);
  printDimText(app, ctx, shownDim);
  return n;
}

/** 치수 문자 안내 */
function printDimText(app: App, ctx: CommandContext, dim: DimensionEntity): void {
  const st = app.active!;
  const t = dim.dimType & 7;
  const kind: DimKindName = dim.subtype === 'ARC_DIMENSION' ? 'arc' : t === 2 || t === 5 ? 'angular' : t === 3 ? 'diameter' : t === 4 ? 'radius' : t === 6 ? 'ordinate' : 'linear';
  let shown: string;
  try {
    shown = dimensionText(rawDimVars(st.doc, dim), kind, dim.measurement, '').measured;
  } catch {
    shown = formatLength(dim.measurement, st.units);
  }
  ctx.print(`치수 문자 = ${dim.text && dim.text !== '<>' ? dim.text.replace('<>', shown) : shown}`);
}

/** 원·호 객체(연관 참조용) */
function circleEntity(e: Entity | undefined): Entity | undefined {
  return e && (e.type === 'CIRCLE' || e.type === 'ARC') ? e : undefined;
}

/** 문서 기본 치수 스타일 옵션(문자 재지정) */
interface DimOpts {
  text?: string;
}

/** 미리보기 형상 */
function preview(app: App, make: (p: Pt) => DimensionEntity | null): (p: Pt) => OverlayGeom[] {
  return (p) => {
    const pk = app.picker();
    const d = make(p);
    if (!pk || !d) return [];
    try {
      const g = generateDimensionGeometry(app.active!.doc, d);
      return [pk.geometryOf(g.entities)];
    } catch {
      return [];
    }
  };
}

/** 문자(T)·여러 줄 문자(M) 옵션 처리. 계속하면 true */
async function textOption(ctx: CommandContext, key: string, o: DimOpts): Promise<boolean> {
  if (key === 'T') {
    const r = await ctx.getPoint(`치수 문자를 입력 <${o.text ? o.text : '<>'}>:`, { allowText: true });
    if ('text' in r) o.text = r.text;
    return true;
  }
  if (key === 'M') {
    const t = await textDialog('치수 문자(<>는 측정값)', o.text || '<>', 0);
    if (t) o.text = t.text.replace(/\r?\n/g, '\\P');
    return true;
  }
  return false;
}

/** 선택한 객체에서 두 치수보조선 원점(선·폴리선 세그먼트·호) */
function originsFromEntity(e: Entity | undefined, pick: Pt): [Pt, Pt] | null {
  if (!e) return null;
  if (e.type === 'LINE') return [e.start, e.end];
  if (e.type === 'ARC') {
    const a = { x: e.center.x + e.radius * Math.cos(e.startAngle), y: e.center.y + e.radius * Math.sin(e.startAngle) };
    const b = { x: e.center.x + e.radius * Math.cos(e.endAngle), y: e.center.y + e.radius * Math.sin(e.endAngle) };
    return [a, b];
  }
  if (e.type === 'LWPOLYLINE' && e.vertices.length >= 2) {
    const vs = e.vertices;
    const n = e.closed ? vs.length : vs.length - 1;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const a = vs[i]!;
      const b = vs[(i + 1) % vs.length]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((pick.x - a.x) * dx + (pick.y - a.y) * dy) / L));
      const d = Math.hypot(a.x + dx * t - pick.x, a.y + dy * t - pick.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const a = vs[best]!;
    const b = vs[(best + 1) % vs.length]!;
    return [a, b];
  }
  return null;
}

/** 호·원에서 중심·반지름(폴리선 볼록 세그먼트 포함) */
function circleOf(e: Entity | undefined): { c: Pt; r: number; a0?: number; a1?: number } | null {
  if (!e) return null;
  if (e.type === 'CIRCLE') return { c: e.center, r: e.radius };
  if (e.type === 'ARC') return { c: e.center, r: e.radius, a0: e.startAngle, a1: e.endAngle };
  return null;
}

export function registerDimCommands(app: App): void {
  // ------------------------------------------------------------- DIMLINEAR·DIMALIGNED
  const linear = (aligned: boolean) => async (ctx: CommandContext) => {
    const st = app.active!;
    const doc = st.doc;
    let p1: Pt;
    let p2: Pt;
    let refs: (PointRef | null)[] = [];
    const r1 = await ctx.getPoint('첫 번째 치수보조선 원점 지정 또는 <객체 선택>:');
    if ('enter' in r1) {
      const pick = await ctx.getEntity('치수기입할 객체 선택:');
      if (!('handle' in pick)) return;
      const picked = doc.entityIndex.get(pick.handle);
      const o = originsFromEntity(picked, pick.point);
      if (!o) {
        ctx.print('선, 호, 폴리선 세그먼트를 선택하십시오.', 'err');
        return;
      }
      [p1, p2] = o;
      refs = [objectRef(app, picked, OSNAP.END, p1), objectRef(app, picked, OSNAP.END, p2)];
    } else if ('point' in r1) {
      p1 = r1.point;
      const ref1 = pointRef(app, r1);
      const r2 = await ctx.getPoint('두 번째 치수보조선 원점 지정:', { base: p1 });
      if (!('point' in r2)) return;
      p2 = r2.point;
      refs = [ref1, pointRef(app, r2)];
    } else return;
    const o: DimOpts = {};
    let rotation: number | undefined;
    for (;;) {
      const make = (p: Pt) =>
        aligned
          ? createAlignedDimension(doc, v3(p1), v3(p2), v3(p), { text: o.text })
          : createLinearDimension(doc, v3(p1), v3(p2), v3(p), { text: o.text, rotation });
      const kws: Keyword[] = [{ key: 'M', label: '여러 줄 문자' }, { key: 'T', label: '문자' }];
      if (!aligned) kws.push({ key: 'H', label: '수평' }, { key: 'V', label: '수직' }, { key: 'R', label: '회전' });
      const r = await ctx.getPoint(`치수선의 위치 지정 또는 [${kws.map((k) => `${k.label}(${k.key})`).join('/')}]:`, { keywords: kws, ghost: preview(app, make) });
      if ('point' in r) {
        addDimension(app, ctx, make(r.point), aligned ? 'DIMALIGNED' : 'DIMLINEAR', refs);
        return;
      }
      if (!('keyword' in r)) return;
      if (await textOption(ctx, r.keyword, o)) continue;
      if (r.keyword === 'H') rotation = 0;
      else if (r.keyword === 'V') rotation = Math.PI / 2;
      else if (r.keyword === 'R') {
        const a = await ctx.getPoint('치수선의 각도 지정 <0>:', { preferNumber: true });
        rotation = 'text' in a ? ((Number(a.text) || 0) * Math.PI) / 180 : 0;
      }
    }
  };
  app.register({ name: 'DIMLINEAR', aliases: ['DLI', 'DIMLIN'], title: '선형 치수', run: linear(false) });
  app.register({ name: 'DIMALIGNED', aliases: ['DAL', 'DIMALI'], title: '정렬 치수', run: linear(true) });

  // ------------------------------------------------------------- DIMANGULAR
  app.register({
    name: 'DIMANGULAR',
    aliases: ['DAN', 'DIMANG'],
    title: '각도 치수',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const o: DimOpts = {};
      let make: ((p: Pt) => DimensionEntity) | null = null;
      // 점 참조 번호 차례: 3점 각도 [13, 14, 15(정점)], 두 선 각도 [13, 14, 15, 10]
      let refs: (PointRef | null)[] = [];
      const r = await ctx.getEntity('호, 원, 선을 선택하거나 <정점 지정>:');
      if ('enter' in r) {
        const v = await ctx.getPoint('각도 정점 지정:');
        if (!('point' in v)) return;
        const rv = pointRef(app, v);
        const a = await ctx.getPoint('첫 번째 각도 끝점 지정:', { base: v.point });
        if (!('point' in a)) return;
        const ra = pointRef(app, a);
        const b = await ctx.getPoint('두 번째 각도 끝점 지정:', { base: v.point });
        if (!('point' in b)) return;
        refs = [ra, pointRef(app, b), rv];
        make = (p) => createAngularDimension(doc, v3(v.point), v3(a.point), v3(b.point), v3(p), { text: o.text });
      } else if ('handle' in r) {
        const e = doc.entityIndex.get(r.handle);
        if (e?.type === 'LINE') {
          const r2 = await ctx.getEntity('두 번째 선 선택:');
          if (!('handle' in r2)) return;
          const e2 = doc.entityIndex.get(r2.handle);
          if (e2?.type !== 'LINE') {
            ctx.print('선을 선택하십시오.', 'err');
            return;
          }
          refs = [objectRef(app, e, OSNAP.END, e.start), objectRef(app, e, OSNAP.END, e.end), objectRef(app, e2, OSNAP.END, e2.start), objectRef(app, e2, OSNAP.END, e2.end)];
          make = (p) => createAngular2LineDimension(doc, e.start, e.end, e2.start, e2.end, v3(p), { text: o.text });
        } else if (e?.type === 'ARC') {
          const a = { x: e.center.x + e.radius * Math.cos(e.startAngle), y: e.center.y + e.radius * Math.sin(e.startAngle), z: 0 };
          const b = { x: e.center.x + e.radius * Math.cos(e.endAngle), y: e.center.y + e.radius * Math.sin(e.endAngle), z: 0 };
          refs = [objectRef(app, e, OSNAP.END, a), objectRef(app, e, OSNAP.END, b), objectRef(app, e, OSNAP.CEN, e.center)];
          make = (p) => createAngularDimension(doc, e.center, a, b, v3(p), { text: o.text });
        } else if (e?.type === 'CIRCLE') {
          const first = r.point;
          const b = await ctx.getPoint('각도의 두 번째 끝점 지정:', { base: e.center });
          if (!('point' in b)) return;
          refs = [circlePointRef(e, first), pointRef(app, b), objectRef(app, e, OSNAP.CEN, e.center)];
          make = (p) => createAngularDimension(doc, e.center, v3(first), v3(b.point), v3(p), { text: o.text });
        } else {
          ctx.print('호, 원, 선을 선택하십시오.', 'err');
          return;
        }
      } else return;
      for (;;) {
        const kws: Keyword[] = [{ key: 'M', label: '여러 줄 문자' }, { key: 'T', label: '문자' }];
        const p = await ctx.getPoint('치수 호 선 위치 지정 또는 [여러 줄 문자(M)/문자(T)]:', { keywords: kws, ghost: preview(app, make) });
        if ('point' in p) {
          addDimension(app, ctx, make(p.point), 'DIMANGULAR', refs);
          return;
        }
        if (!('keyword' in p) || !(await textOption(ctx, p.keyword, o))) return;
      }
    },
  });

  // ------------------------------------------------------------- DIMRADIUS·DIMDIAMETER·DIMARC
  const radial = (kind: 'radius' | 'diameter' | 'arc') => async (ctx: CommandContext) => {
    const st = app.active!;
    const doc = st.doc;
    const r = await ctx.getEntity(kind === 'arc' ? '호 또는 폴리선 호 세그먼트 선택:' : '호 또는 원 선택:');
    if (!('handle' in r)) return;
    const picked = circleEntity(doc.entityIndex.get(r.handle));
    const c = circleOf(picked);
    if (!c || (kind === 'arc' && c.a0 === undefined)) {
      ctx.print(kind === 'arc' ? '호를 선택하십시오.' : '호 또는 원을 선택하십시오.', 'err');
      return;
    }
    const o: DimOpts = {};
    const center = v3(c.c);
    const make = (p: Pt): DimensionEntity => {
      if (kind === 'arc') return createArcLengthDimension(doc, center, c.r, c.a0!, c.a1!, v3(p), { text: o.text });
      const a = Math.atan2(p.y - c.c.y, p.x - c.c.x);
      const on = { x: c.c.x + c.r * Math.cos(a), y: c.c.y + c.r * Math.sin(a), z: 0 };
      const d = kind === 'radius' ? createRadialDimension(doc, center, c.r, on, { text: o.text }) : createDiameterDimension(doc, center, c.r, on, { text: o.text });
      // 문자 위치는 커서(사용자 위치)
      d.textMid = v3(p);
      d.dimType |= 128;
      return d;
    };
    const what = kind === 'arc' ? '호 길이 치수 위치 지정' : '치수선의 위치 지정';
    for (;;) {
      const p = await ctx.getPoint(`${what} 또는 [여러 줄 문자(M)/문자(T)]:`, { keywords: [{ key: 'M', label: '여러 줄 문자' }, { key: 'T', label: '문자' }], ghost: preview(app, make) });
      if ('point' in p) {
        const d = make(p.point);
        // 반지름 [15 현 위 점, 10 중심], 지름 [15, 10 반대쪽 현 위 점], 호 길이 [13 시작, 14 끝, 15 중심]
        let refs: (PointRef | null)[] = [];
        if (picked) {
          if (kind === 'arc') refs = [objectRef(app, picked, OSNAP.END, d.defPoint2), objectRef(app, picked, OSNAP.END, d.defPoint3), objectRef(app, picked, OSNAP.CEN, d.defPoint4)];
          else if (kind === 'radius') refs = [circlePointRef(picked, d.defPoint4), objectRef(app, picked, OSNAP.CEN, d.defPoint)];
          else refs = [circlePointRef(picked, d.defPoint4), circlePointRef(picked, d.defPoint)];
        }
        addDimension(app, ctx, d, kind === 'radius' ? 'DIMRADIUS' : kind === 'diameter' ? 'DIMDIAMETER' : 'DIMARC', refs);
        return;
      }
      if (!('keyword' in p) || !(await textOption(ctx, p.keyword, o))) return;
    }
  };
  app.register({ name: 'DIMRADIUS', aliases: ['DRA', 'DIMRAD'], title: '반지름 치수', run: radial('radius') });
  app.register({ name: 'DIMDIAMETER', aliases: ['DDI', 'DIMDIA'], title: '지름 치수', run: radial('diameter') });
  app.register({ name: 'DIMARC', aliases: ['DAR'], title: '호 길이 치수', run: radial('arc') });

  // ------------------------------------------------------------- DIMCONTINUE·DIMBASELINE
  /** 직전에 만든(또는 고른) 선형·정렬·세로좌표 치수 */
  const lastDim = (): DimensionEntity | null => {
    const st = app.active!;
    for (let i = app.lastCreated.length - 1; i >= 0; i--) {
      const e = st.doc.entityIndex.get(app.lastCreated[i]!);
      if (e?.type === 'DIMENSION' && [0, 1, 6].includes(e.dimType & 7) && !e.subtype) return e;
    }
    return null;
  };
  const chain = (baseline: boolean) => async (ctx: CommandContext) => {
    const st = app.active!;
    const doc = st.doc;
    let base = lastDim();
    const pickBase = async (): Promise<DimensionEntity | null> => {
      const r = await ctx.getEntity(baseline ? '기준 치수 선택:' : '연속된 치수 선택:');
      if (!('handle' in r)) return null;
      const e = doc.entityIndex.get(r.handle);
      if (e?.type !== 'DIMENSION' || ![0, 1, 6].includes(e.dimType & 7) || e.subtype) {
        ctx.print('선형·정렬·세로좌표 치수를 선택하십시오.', 'err');
        return null;
      }
      return e;
    };
    if (!base) base = await pickBase();
    if (!base) return;
    // 기준선: 치수선 사이 간격 = DIMDLI × DIMSCALE
    const raw = rawDimVars(doc, base) as Record<string, number | string>;
    const scale = Number(raw.DIMSCALE) > 0 ? Number(raw.DIMSCALE) : 1;
    const step = (Number(raw.DIMDLI) || 0) * scale;
    let prev = base;
    let origin = baseline ? base.defPoint2 : base.defPoint3;
    const steps: number[] = [];
    for (;;) {
      const make = (p: Pt): DimensionEntity => {
        const t = prev.dimType & 7;
        if (t === 6) {
          // 세로좌표: 같은 축, 지시선 끝은 앞 치수와 같은 높이·폭
          const xAxis = (prev.dimType & 64) !== 0;
          const end = xAxis ? { x: p.x, y: prev.defPoint3.y, z: 0 } : { x: prev.defPoint3.x, y: p.y, z: 0 };
          return createOrdinateDimension(doc, v3(p), end, { xAxis, style: prev.dimStyle });
        }
        const rot = t === 1 ? Math.atan2(prev.defPoint3.y - prev.defPoint2.y, prev.defPoint3.x - prev.defPoint2.x) : prev.rotation;
        let line = prev.defPoint;
        if (baseline) {
          // 앞 치수선에서 원점 반대쪽으로 한 칸
          const ux = Math.cos(rot);
          const uy = Math.sin(rot);
          const nx = -uy;
          const ny = ux;
          const side = Math.sign((prev.defPoint.x - prev.defPoint2.x) * nx + (prev.defPoint.y - prev.defPoint2.y) * ny) || 1;
          line = { x: prev.defPoint.x + nx * side * step, y: prev.defPoint.y + ny * side * step, z: 0 };
        }
        return createLinearDimension(doc, origin, v3(p), line, { rotation: rot, style: prev.dimStyle });
      };
      const r = await ctx.getPoint('두 번째 치수보조선 원점 지정 또는 [선택(S)/명령 취소(U)] <선택>:', {
        keywords: [{ key: 'S', label: '선택' }, { key: 'U', label: '명령 취소' }],
        ghost: preview(app, make),
      });
      if ('point' in r) {
        const d = make(r.point);
        // 연관: 원점은 기준 치수의 같은 점 연관을 이어받는다(세로좌표는 피쳐 위치만)
        const refs: (PointRef | null)[] = (prev.dimType & 7) === 6 ? [null, pointRef(app, r)] : [baseline ? inheritedRef(app, base, 'defPoint2') : inheritedRef(app, prev, 'defPoint3'), pointRef(app, r)];
        const label = baseline ? 'DIMBASELINE' : 'DIMCONTINUE';
        const n = addDimension(app, ctx, d, label, refs);
        steps.push(n);
        prev = d;
        if (!baseline) origin = d.defPoint3;
        continue;
      }
      if ('keyword' in r && r.keyword === 'U') {
        const n = steps.pop();
        if (n) st.session.undoLastStep(ctx.group, n);
        continue;
      }
      if ('enter' in r || ('keyword' in r && r.keyword === 'S')) {
        if ('enter' in r && steps.length) return;
        const b = await pickBase();
        if (!b) return;
        base = b;
        prev = b;
        origin = baseline ? b.defPoint2 : b.defPoint3;
        continue;
      }
      return;
    }
  };
  app.register({ name: 'DIMCONTINUE', aliases: ['DCO', 'DIMCONT'], title: '연속 치수', run: chain(false) });
  app.register({ name: 'DIMBASELINE', aliases: ['DBA', 'DIMBASE'], title: '기준선 치수', run: chain(true) });

  // ------------------------------------------------------------- DIMORDINATE
  app.register({
    name: 'DIMORDINATE',
    aliases: ['DOR', 'DIMORD'],
    title: '세로좌표 치수',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const f = await ctx.getPoint('피쳐 위치 지정:');
      if (!('point' in f)) return;
      const fr = pointRef(app, f);
      const o: DimOpts = {};
      let xAxis: boolean | undefined;
      for (;;) {
        const make = (p: Pt) => createOrdinateDimension(doc, v3(f.point), v3(p), { text: o.text, xAxis });
        const p = await ctx.getPoint('지시선 끝점을 지정 또는 [X데이텀(X)/Y데이텀(Y)/여러 줄 문자(M)/문자(T)]:', {
          base: f.point,
          keywords: [{ key: 'X', label: 'X데이텀' }, { key: 'Y', label: 'Y데이텀' }, { key: 'M', label: '여러 줄 문자' }, { key: 'T', label: '문자' }],
          ghost: preview(app, make),
        });
        if ('point' in p) {
          addDimension(app, ctx, make(p.point), 'DIMORDINATE', [null, fr]);
          return;
        }
        if (!('keyword' in p)) return;
        if (p.keyword === 'X') xAxis = true;
        else if (p.keyword === 'Y') xAxis = false;
        else if (!(await textOption(ctx, p.keyword, o))) return;
      }
    },
  });
}
