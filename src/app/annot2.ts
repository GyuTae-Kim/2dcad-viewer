/**
 * 치수·지시선·주석 편집 명령(2): DIMEDIT, DIMTEDIT, DIMSPACE, DIMBREAK, DIMJOGGED, DIMJOGLINE, DIMOVERRIDE
 * 그리고 같은 묶음의 QDIM·TOLERANCE·CENTERMARK·CENTERLINE(annot2-misc), QLEADER·MLEADEREDIT·MLEADERALIGN·
 * MLEADERCOLLECT·MLEADERSTYLE(annot2-leader)을 함께 등록한다.
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 계산은 src/edit/annot·src/edit/dim(extras·jogged).
 */
import type { BlockDef, DimensionEntity, Entity, LeaderEntity, MLeaderEntity, Vec3 } from '../core/model';
import { tableKey } from '../core/model';
import { formatLength } from '../core/units';
import { builtinArrowBlock, dimensionText, generateDimensionGeometry, moveDimensionText, rawDimVars } from '../edit/dim';
import { BREAKER_TYPES, type DimBreak, breakSize, breakerPieces, dimFrame, readBreaks, readJogLine, toFrame, writeBreaks, writeJogLine, defaultJogPoint } from '../edit/dim/extras';
import { autoSpacing, dimHome, dimJustify, dimNewText, dimOblique, dimRotateText, isAngularDim, isLinearDim, linearFeetW, spaceDimensions } from '../edit/annot/dimedit';
import { createJoggedDimension } from '../edit/annot/create';
import { mleaderBreakPairs, mleaderManualBreak } from '../edit/annot/mleader';
import { DIM_VAR_BY_NAME, type Overrides, applyOverrides, formatVarValue, parseVarValue } from '../edit/annot/override';
import { intersectAll } from '../edit/geom/intersect';
import type { Piece } from '../edit/geom/curve';
import type { App, Keyword } from './app';
import { OSNAP, circlePointRef } from '../edit/dim/assoc';
import { attachAssociation, finishNewDimension, objectRef } from './dimassoc';
import { textDialog } from './draw';
import { unlockedOnly } from './layers';
import { commitResults } from './modify';
import type { Pt } from './view';
import { askAngle, commitChanged, dimGhost } from './annot2-common';
import { registerAnnot2Leader } from './annot2-leader';
import { registerAnnot2Misc } from './annot2-misc';

const v3 = (p: Pt, z = 0): Vec3 => ({ x: p.x, y: p.y, z });

/** 고른 객체 중 치수 */
function dimsOf(app: App, handles: string[]): DimensionEntity[] {
  const doc = app.active!.doc;
  return unlockedOnly(app, handles)
    .map((h) => doc.entityIndex.get(h))
    .filter((e): e is DimensionEntity => e?.type === 'DIMENSION');
}

/** 측정값 문자(명령행 안내) */
function shownText(app: App, d: DimensionEntity): string {
  const st = app.active!;
  try {
    return dimensionText(rawDimVars(st.doc, d), 'radius', d.measurement, '').measured;
  } catch {
    return formatLength(d.measurement, st.units);
  }
}

/** AutoCAD 기본 화살촉 블록 이름(도면에 없으면 만든다) */
const BUILTIN_ARROWS = ['_ClosedBlank', '_Closed', '_Dot', '_ArchTick', '_Oblique', '_Open', '_Origin', '_Origin2', '_Open90', '_Open30', '_DotSmall', '_DotBlank', '_Small', '_BoxBlank', '_BoxFilled', '_DatumBlank', '_DatumFilled', '_Integral', '_None'];

function builtinArrowName(name: string): string | null {
  const k = name.replace(/^_/, '').toUpperCase();
  return BUILTIN_ARROWS.find((n) => n.slice(1).toUpperCase() === k) ?? null;
}

export function registerAnnot2Commands(app: App): void {
  // ------------------------------------------------------------- DIMEDIT
  app.register({
    name: 'DIMEDIT',
    aliases: ['DED', 'DIMED'],
    title: '치수 편집',
    async run(ctx) {
      const st = app.active!;
      const kws: Keyword[] = [
        { key: 'H', label: '홈' },
        { key: 'N', label: '새로 만들기' },
        { key: 'R', label: '회전' },
        { key: 'O', label: '기울기' },
      ];
      const r = await ctx.getPoint('치수 편집의 유형 입력 [홈(H)/새로 만들기(N)/회전(R)/기울기(O)] <홈(H)>:', { keywords: kws });
      let kind = 'H';
      if ('keyword' in r) kind = r.keyword;
      else if (!('enter' in r)) {
        ctx.print('옵션을 입력하십시오.', 'err');
        return;
      }
      let text = '';
      let angle = 0;
      if (kind === 'N') {
        const t = await textDialog('치수 문자(<>는 측정값)', '<>', 0, { app, ctx });
        if (!t) return;
        text = t.text;
      } else if (kind === 'R') {
        const a = await askAngle(ctx, '치수 문자의 각도 지정:', 0);
        angle = a ?? 0;
      }
      const dims = dimsOf(app, await ctx.getSelection('객체 선택:'));
      if (!dims.length) return;
      app.clearSelection();
      if (kind === 'O') {
        const a = await askAngle(ctx, '기울기 각도 입력 (없는 경우 ENTER 키 누름):', 0);
        angle = a ?? 0;
      }
      const out: DimensionEntity[] = [];
      let bad = 0;
      for (const d of dims) {
        const c = kind === 'H' ? dimHome(d, true) : kind === 'N' ? dimNewText(d, text) : kind === 'R' ? dimRotateText(d, angle) : dimOblique(d, angle);
        if (c) out.push(c);
        else bad++;
      }
      if (bad) ctx.print(`기울기를 적용할 수 없는 치수 ${bad}개는 건너뛰었습니다(선형·정렬 치수만, 치수선과 나란한 각은 안 됩니다).`);
      commitChanged(app, ctx, out, 'DIMEDIT');
      void st;
    },
  });

  // ------------------------------------------------------------- DIMTEDIT
  app.register({
    name: 'DIMTEDIT',
    aliases: ['DIMTED'],
    title: '치수 문자 편집',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      let dim: DimensionEntity | null = null;
      if (st.selection.size === 1) {
        const e = doc.entityIndex.get([...st.selection][0]!);
        if (e?.type === 'DIMENSION') dim = e;
      }
      while (!dim) {
        const r = await ctx.getEntity('치수 선택:');
        if (!('handle' in r)) return;
        const e = doc.entityIndex.get(r.handle);
        if (e?.type === 'DIMENSION') dim = e;
        else ctx.print('치수가 아닙니다.', 'err');
      }
      app.clearSelection();
      const d0 = dim;
      const kws: Keyword[] = [
        { key: 'L', label: '왼쪽' },
        { key: 'R', label: '오른쪽' },
        { key: 'C', label: '중심' },
        { key: 'H', label: '홈' },
        { key: 'A', label: '각도' },
      ];
      const r = await ctx.getPoint('치수 문자에 대한 새 위치 지정 또는 [왼쪽(L)/오른쪽(R)/중심(C)/홈(H)/각도(A)]:', {
        keywords: kws,
        ghost: dimGhost(app, (p) => moveDimensionText(doc, d0, v3(p, d0.textMid.z))),
      });
      let c: DimensionEntity | null = null;
      if ('point' in r) c = moveDimensionText(doc, d0, v3(r.point, d0.textMid.z));
      else if ('keyword' in r) {
        const k = r.keyword;
        if (k === 'L' || k === 'R' || k === 'C') {
          c = dimJustify(d0, k);
          if (!c) {
            ctx.print('왼쪽·오른쪽·중심은 선형·정렬 치수에만 쓸 수 있습니다.', 'err');
            return;
          }
        } else if (k === 'H') c = dimHome(d0, false);
        else if (k === 'A') {
          const a = await askAngle(ctx, '치수 문자의 각도 지정:', 0);
          c = dimRotateText(d0, a ?? 0);
        }
      }
      if (c) commitChanged(app, ctx, [c], 'DIMTEDIT');
    },
  });

  // ------------------------------------------------------------- DIMSPACE
  app.register({
    name: 'DIMSPACE',
    title: '치수 간격 조정',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      let base: DimensionEntity | null = null;
      while (!base) {
        const r = await ctx.getEntity('기준 치수 선택:');
        if (!('handle' in r)) return;
        const e = doc.entityIndex.get(r.handle);
        if (e?.type === 'DIMENSION' && (isLinearDim(e) || isAngularDim(e))) base = e;
        else ctx.print('선형 치수 또는 각도 치수를 선택하십시오.', 'err');
      }
      app.clearSelection();
      const others = dimsOf(app, await ctx.getSelection('간격을 둘 치수 선택:', { noPickfirst: true })).filter((d) => d.handle !== base.handle);
      app.clearSelection();
      if (!others.length) return;
      let spacing = autoSpacing(doc, base);
      for (;;) {
        const r = await ctx.getPoint('값 입력 또는 [자동(A)] <자동(A)>:', { keywords: [{ key: 'A', label: '자동' }], preferNumber: true });
        if ('text' in r) {
          const n = Number(r.text);
          if (!Number.isFinite(n) || n < 0) {
            ctx.print('0 또는 양수를 입력하십시오.', 'err');
            continue;
          }
          spacing = n;
        } else if ('point' in r) continue;
        break;
      }
      const { changed, skipped } = spaceDimensions(base, others, spacing);
      if (skipped.length) ctx.print(`기준 치수와 나란하지 않거나 꼭짓점이 다른 치수 ${skipped.length}개는 건너뛰었습니다.`);
      commitChanged(app, ctx, changed, 'DIMSPACE');
    },
  });

  // ------------------------------------------------------------- DIMBREAK
  app.register({
    name: 'DIMBREAK',
    title: '치수 끊기',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const kwM: Keyword = { key: 'M', label: '다중' };
      const r = await ctx.getEntity('끊기를 추가/제거할 치수 선택 또는 [다중(M)]:', [kwM]);
      const targets: (DimensionEntity | MLeaderEntity)[] = [];
      let multi = false;
      const accept = (e: Entity | undefined): e is DimensionEntity | MLeaderEntity => {
        if (e?.type === 'DIMENSION') return true;
        if (e?.type === 'MULTILEADER') {
          if (e.leaderLineType === 2) {
            ctx.print('스플라인 다중 지시선은 끊을 수 없습니다.', 'err');
            return false;
          }
          return true;
        }
        return false;
      };
      if ('keyword' in r) {
        multi = true;
        const hs = unlockedOnly(app, await ctx.getSelection('치수 선택:'));
        for (const h of hs) {
          const e = doc.entityIndex.get(h);
          if (accept(e)) targets.push(e);
        }
      } else if ('handle' in r) {
        const e = doc.entityIndex.get(r.handle);
        if (e?.type === 'LEADER') {
          ctx.print('지시선(LEADER)은 끊을 수 없습니다.', 'err');
          return;
        }
        if (!accept(e)) {
          ctx.print('치수 또는 다중 지시선을 선택하십시오.', 'err');
          return;
        }
        targets.push(e);
      } else return;
      app.clearSelection();
      if (!targets.length) return;
      // 방법
      let mode: 'A' | 'M' | 'R' | 'O' = 'A';
      const objs: string[] = [];
      let manual: [Pt, Pt] | null = null;
      if (multi) {
        const k = await ctx.getPoint('치수를 끊을 객체 선택 또는 [자동(A)/제거(R)] <자동(A)>:', {
          keywords: [
            { key: 'A', label: '자동' },
            { key: 'R', label: '제거' },
          ],
        });
        if ('keyword' in k && k.keyword === 'R') mode = 'R';
      } else {
        const k = await ctx.getEntity('치수를 끊을 객체 선택 또는 [자동(A)/수동(M)/제거(R)] <자동(A)>:', [
          { key: 'A', label: '자동' },
          { key: 'M', label: '수동' },
          { key: 'R', label: '제거' },
        ]);
        if ('keyword' in k) mode = k.keyword as 'A' | 'M' | 'R';
        else if ('handle' in k) {
          mode = 'O';
          objs.push(k.handle);
          for (;;) {
            const k2 = await ctx.getEntity('치수를 끊을 객체 선택:');
            if (!('handle' in k2)) break;
            if (!objs.includes(k2.handle)) objs.push(k2.handle);
          }
        }
        if (mode === 'M') {
          const a = await ctx.getPoint('첫 번째 끊기점 지정:');
          if (!('point' in a)) return;
          const b = await ctx.getPoint('두 번째 끊기점 지정:', { base: a.point });
          if (!('point' in b)) return;
          manual = [a.point, b.point];
        }
      }
      const out: Entity[] = [];
      for (const t of targets) {
        const c = t.type === 'DIMENSION' ? breakDimension(app, t, mode, objs, manual) : breakMLeader(app, t, mode, objs, manual);
        if (c) out.push(c);
      }
      commitChanged(app, ctx, out, 'DIMBREAK');
      ctx.print(`${out.length}개의 객체 수정됨`);
    },
  });

  // ------------------------------------------------------------- DIMJOGLINE
  app.register({
    name: 'DIMJOGLINE',
    aliases: ['DJL'],
    title: '꺾어진 선형',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const r = await ctx.getEntity('꺾기를 추가할 치수 선택 또는 [제거(R)]:', [{ key: 'R', label: '제거' }]);
      if ('keyword' in r) {
        const r2 = await ctx.getEntity('제거할 꺾기 선택:');
        if (!('handle' in r2)) return;
        const e = doc.entityIndex.get(r2.handle);
        if (e?.type !== 'DIMENSION' || !readJogLine(e)?.on) {
          ctx.print('꺾기가 있는 치수가 아닙니다.', 'err');
          return;
        }
        const c = structuredClone(e);
        const x = writeJogLine(e, 'remove');
        if (x) c.xdata = x;
        else delete c.xdata;
        commitChanged(app, ctx, [c], 'DIMJOGLINE');
        return;
      }
      if (!('handle' in r)) return;
      const e = doc.entityIndex.get(r.handle);
      if (e?.type !== 'DIMENSION' || !isLinearDim(e)) {
        ctx.print('선형 치수 또는 정렬 치수를 선택하십시오.', 'err');
        return;
      }
      app.clearSelection();
      const make = (p: Pt | null): DimensionEntity => {
        const c = structuredClone(e);
        const { d1, d2 } = linearFeetW(e);
        const len = Math.hypot(d2.x - d1.x, d2.y - d1.y) || 1;
        const ux = { x: (d2.x - d1.x) / len, y: (d2.y - d1.y) / len };
        let at: Pt | null = null;
        if (p) {
          const t = (p.x - d1.x) * ux.x + (p.y - d1.y) * ux.y;
          at = { x: d1.x + ux.x * t, y: d1.y + ux.y * t };
        }
        const x = writeJogLine(e, { point: at, defaultPoint: defaultJogPoint(d1, d2, ux, e.textMid) });
        if (x) c.xdata = x;
        return c;
      };
      const p = await ctx.getPoint('꺾기 위치 지정(또는 ENTER 키 누르기):', { ghost: dimGhost(app, (q) => make(q)) });
      if ('point' in p) commitChanged(app, ctx, [make(p.point)], 'DIMJOGLINE');
      else if ('enter' in p) commitChanged(app, ctx, [make(null)], 'DIMJOGLINE');
    },
  });

  // ------------------------------------------------------------- DIMJOGGED
  app.register({
    name: 'DIMJOGGED',
    aliases: ['DJO', 'JOG'],
    title: '꺾기 반지름 치수',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const r = await ctx.getEntity('호 또는 원 선택:');
      if (!('handle' in r)) return;
      const e = doc.entityIndex.get(r.handle);
      if (e?.type !== 'CIRCLE' && e?.type !== 'ARC') {
        ctx.print('호 또는 원을 선택하십시오.', 'err');
        return;
      }
      app.clearSelection();
      const center = e.center;
      const radius = e.radius;
      const oc = await ctx.getPoint('중심 위치 재지정 지정:');
      if (!('point' in oc)) return;
      const ovr = v3(oc.point, center.z);
      const o: { text?: string; rot?: number } = {};
      const build = (tp: Pt, jog: Pt | null): DimensionEntity => {
        const a = Math.atan2(tp.y - center.y, tp.x - center.x);
        const chord = { x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) };
        // 꺾기를 아직 안 정했으면 재지정 중심과 호 사이 가운데
        const t = (ovr.x - chord.x) * Math.cos(a) + (ovr.y - chord.y) * Math.sin(a);
        const j = jog ?? { x: chord.x + (Math.cos(a) * t) / 2, y: chord.y + (Math.sin(a) * t) / 2 };
        const d = createJoggedDimension(doc, center, radius, v3(tp, center.z), ovr, v3(j, center.z), { text: o.text, jogAngle: undefined });
        if (o.rot) d.textRotation = o.rot;
        return d;
      };
      ctx.print(`치수 문자 = ${shownText(app, build({ x: center.x + radius, y: center.y }, null))}`);
      let tp: Pt | null = null;
      for (;;) {
        const p = await ctx.getPoint('치수선 위치 지정 또는 [여러 줄 문자(M)/문자(T)/각도(A)]:', {
          keywords: [
            { key: 'M', label: '여러 줄 문자' },
            { key: 'T', label: '문자' },
            { key: 'A', label: '각도' },
          ],
          ghost: dimGhost(app, (q) => build(q, null)),
        });
        if ('point' in p) {
          tp = p.point;
          break;
        }
        if (!('keyword' in p)) return;
        if (p.keyword === 'T') {
          const t = await ctx.getPoint(`치수 문자를 입력 <${o.text || '<>'}>:`, { allowText: true });
          if ('text' in t) o.text = t.text;
        } else if (p.keyword === 'M') {
          const t = await textDialog('치수 문자(<>는 측정값)', o.text || '<>', 0, { app, ctx });
          if (t) o.text = t.text;
        } else if (p.keyword === 'A') {
          const a = await askAngle(ctx, '치수 문자의 각도를 지정:', 0);
          o.rot = a ?? 0;
        }
      }
      const tp0 = tp;
      const j = await ctx.getPoint('꺾기 위치 지정:', { ghost: dimGhost(app, (q) => build(tp0, q)) });
      if (!('point' in j)) return;
      const a = commitResults(app, ctx, [{ add: [build(tp0, j.point)] }], 'DIMJOGGED', { quiet: true });
      // 연관: [15 현 위 점, 10 중심] — 재지정 중심·꺾기 점은 중심을 따라 옮긴다
      const h = a.added[0];
      const d = h ? doc.entityIndex.get(h) : undefined;
      if (h && d?.type === 'DIMENSION') attachAssociation(app, ctx, h, [circlePointRef(e, d.defPoint4), objectRef(app, e, OSNAP.CEN, d.defPoint), null, null], 'DIMJOGGED');
      if (h) finishNewDimension(app, ctx, h, 'DIMJOGGED');
    },
  });

  // ------------------------------------------------------------- DIMOVERRIDE
  app.register({
    name: 'DIMOVERRIDE',
    aliases: ['DOV', 'DIMOVER'],
    title: '치수 재지정',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const changes: Overrides = {};
      const newBlocks: BlockDef[] = [];
      let clear = false;
      const curStyle = String(doc.header.get('$DIMSTYLE') ?? 'Standard');
      const cur = rawDimVars(doc, { dimStyle: curStyle });
      for (;;) {
        const first = !Object.keys(changes).length;
        const r = await ctx.getPoint(first ? '재지정할 치수 변수 이름 입력 또는 [재지정 지우기(C)]:' : '재지정할 치수 변수 이름 입력:', {
          keywords: first ? [{ key: 'C', label: '재지정 지우기' }] : [],
          allowText: true,
        });
        if ('enter' in r) break;
        if ('keyword' in r) {
          clear = true;
          break;
        }
        if (!('text' in r)) continue;
        let name = r.text.trim().toUpperCase();
        if (!DIM_VAR_BY_NAME.has(name) && DIM_VAR_BY_NAME.has(`DIM${name}`)) name = `DIM${name}`;
        const code = DIM_VAR_BY_NAME.get(name);
        if (code === undefined) {
          ctx.print('알 수 없는 치수 변수 이름입니다.', 'err');
          continue;
        }
        const shown = formatVarValue(doc, name, changes[code] !== undefined && code !== 342 && code < 340 ? changes[code] : cur[name]);
        const v = await ctx.getPoint(`치수 변수에 대한 새 값 입력 <${shown}>:`, { allowText: true, preferNumber: true });
        if (!('text' in v)) continue;
        const pv = parseVarValue(doc, code, v.text);
        if (pv.error) {
          ctx.print(pv.error, 'err');
          continue;
        }
        if (pv.needBlock) {
          const bn = builtinArrowName(pv.needBlock);
          const made = bn ? newBlocks.find((b) => b.name === bn) : undefined;
          if (made) changes[code] = made.recordHandle;
          else if (bn) {
            const def: BlockDef = { name: bn, handle: '', recordHandle: st.session.newHandle(), basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: builtinArrowBlock(bn) };
            newBlocks.push(def);
            changes[code] = def.recordHandle;
          } else {
            ctx.print(`블록 ${pv.needBlock}을(를) 찾을 수 없습니다.`, 'err');
            continue;
          }
        } else changes[code] = pv.value!;
      }
      if (!clear && !Object.keys(changes).length) return;
      const hs = unlockedOnly(app, await ctx.getSelection('객체 선택:'));
      app.clearSelection();
      const out: Entity[] = [];
      for (const h of hs) {
        const e = doc.entityIndex.get(h);
        if (e?.type !== 'DIMENSION' && e?.type !== 'LEADER') continue;
        if (clear && !e.overrides && !e.xdata?.some((x) => x.app.toUpperCase() === 'ACAD')) continue;
        out.push(applyOverrides(e as DimensionEntity | LeaderEntity, clear ? null : changes) as Entity);
      }
      if (!out.length) return;
      commitResults(app, ctx, [{ replace: out, blocks: newBlocks.length ? newBlocks : undefined }], 'DIMOVERRIDE', { quiet: true });
    },
  });

  registerAnnot2Misc(app);
  registerAnnot2Leader(app);
}

// ---------------------------------------------------------------------------
// 끊기
// ---------------------------------------------------------------------------

/** 치수 블록 내용의 선·호 조각(WCS, 돌출 방향이 기본일 때) */
function piecesOf(ents: readonly Entity[]): Piece[] {
  const out: Piece[] = [];
  for (const e of ents) {
    if (e.type === 'LINE') out.push({ k: 'line', a: { x: e.start.x, y: e.start.y }, b: { x: e.end.x, y: e.end.y } });
    else if (e.type === 'ARC') {
      let sw = e.endAngle - e.startAngle;
      while (sw <= 0) sw += 2 * Math.PI;
      out.push({ k: 'arc', c: { x: e.center.x, y: e.center.y }, r: e.radius, a0: e.startAngle, sw });
    }
  }
  return out;
}

/** 범위가 겹치고 실제로 만나는 끊는 객체 후보 */
function autoBreakers(app: App, self: Entity, own: Piece[]): string[] {
  const st = app.active!;
  const pk = app.picker();
  if (!pk || !own.length) return [];
  const g = pk.geometry(self.handle);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < g.segs.length; i += 2) {
    minX = Math.min(minX, g.segs[i]!);
    maxX = Math.max(maxX, g.segs[i]!);
    minY = Math.min(minY, g.segs[i + 1]!);
    maxY = Math.max(maxY, g.segs[i + 1]!);
  }
  if (!Number.isFinite(minX)) return [];
  const out: string[] = [];
  for (const h of pk.overlapping([minX, minY, maxX, maxY])) {
    if (h === self.handle) continue;
    const e = st.doc.entityIndex.get(h);
    if (!e || !BREAKER_TYPES.has(e.type)) continue;
    const l = st.doc.layers.get(tableKey(e.layer));
    if (l && (l.off || l.frozen)) continue;
    const pcs = breakerPieces(st.doc, e);
    if (pcs.length && intersectAll(own, pcs).length) out.push(h);
  }
  return out;
}

function breakDimension(app: App, d: DimensionEntity, mode: 'A' | 'M' | 'R' | 'O', objs: string[], manual: [Pt, Pt] | null): DimensionEntity | null {
  const prev = readBreaks(d);
  let next: DimBreak[];
  if (mode === 'R') {
    if (!prev.length) return null;
    next = [];
  } else if (mode === 'M' && manual) {
    const f = dimFrame(d);
    next = [...prev, { kind: 'manual', a: toFrame(f, manual[0]), b: toFrame(f, manual[1]) }];
  } else {
    // 끊기 전 선으로 만나는 객체를 찾는다
    const clean = structuredClone(d);
    const x = writeBreaks(clean, []);
    if (x) clean.xdata = x;
    else delete clean.xdata;
    const own = piecesOf(generateDimensionGeometry(app.active!.doc, clean).entities);
    const hs = mode === 'O' ? objs.filter((h) => h !== d.handle && BREAKER_TYPES.has(app.active!.doc.entityIndex.get(h)?.type ?? '')) : autoBreakers(app, d, own);
    if (!hs.length) return null;
    next = [...prev.filter((b) => b.kind === 'manual' || !hs.includes(b.handle)), ...hs.map((handle): DimBreak => ({ kind: 'object', handle }))];
  }
  const c = structuredClone(d);
  const x = writeBreaks(d, next);
  if (x) c.xdata = x;
  else delete c.xdata;
  return c;
}

function breakMLeader(app: App, e: MLeaderEntity, mode: 'A' | 'M' | 'R' | 'O', objs: string[], manual: [Pt, Pt] | null): MLeaderEntity | null {
  const st = app.active!;
  const c = structuredClone(e);
  const lines = c.context.leaders.flatMap((ld) => ld.lines);
  if (mode === 'R') {
    if (!lines.some((l) => l.breaks?.length)) return null;
    for (const l of lines) delete l.breaks;
    return c;
  }
  if (mode === 'M' && manual) {
    const r = mleaderManualBreak(c, manual[0], manual[1]);
    if (!r) return null;
    const ln = c.context.leaders[r.leader]!.lines[r.line]!;
    (ln.breaks ??= []).push(r.pair);
    return c;
  }
  const own: Piece[] = [];
  for (const ld of c.context.leaders)
    for (const ln of ld.lines) {
      const pts = [...ln.vertices, ...(ld.lastLeaderPoint ? [ld.lastLeaderPoint] : [])];
      for (let i = 0; i + 1 < pts.length; i++) own.push({ k: 'line', a: { x: pts[i]!.x, y: pts[i]!.y }, b: { x: pts[i + 1]!.x, y: pts[i + 1]!.y } });
    }
  const hs = mode === 'O' ? objs.filter((h) => h !== e.handle) : autoBreakers(app, e, own);
  const cutters: Piece[] = [];
  for (const h of hs) {
    const o = st.doc.entityIndex.get(h);
    if (o) cutters.push(...breakerPieces(st.doc, o));
  }
  if (!cutters.length) return null;
  const size = mleaderBreakGap(app, c);
  const pairs = mleaderBreakPairs(c, cutters, size);
  if (!pairs.size) return null;
  c.context.leaders.forEach((ld, i) =>
    ld.lines.forEach((ln, j) => {
      const p = pairs.get(`${i}:${j}`);
      if (p) ln.breaks = [...(ln.breaks ?? []), ...p];
    }),
  );
  return c;
}

/** 다중 지시선 끊기 크기: 스타일의 끊기 간격(143) × 축척, 없으면 미터법 3.75·영국식 0.125 */
function mleaderBreakGap(app: App, e: MLeaderEntity): number {
  const doc = app.active!.doc;
  const style = e.styleHandle ? doc.objects.get(e.styleHandle) : undefined;
  const raw = style?.type === 'MLEADERSTYLE' ? style.raw : undefined;
  const v = Number(raw?.find((t) => t.code === 143)?.value);
  const metric = Number(doc.header.get('$MEASUREMENT') ?? 1) === 1;
  const g = Number.isFinite(v) && v > 0 ? v : breakSize(doc, { dimStyle: 'Standard', xdata: undefined }, 1) || (metric ? 3.75 : 0.125);
  return g * (e.scale > 0 ? e.scale : 1);
}
