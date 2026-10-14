/**
 * 수정 명령(2): ALIGN, BLEND, COPYM, EXTRIM, OVERKILL, REVERSE, DIVIDE, MEASURE, BOUNDARY, REVCLOUD, WIPEOUT,
 * SCALETEXT, JUSTIFYTEXT, PEDIT·SPLINEDIT(modify2-pedit.ts).
 * 프롬프트와 옵션은 AutoCAD 2026 한국어판을 따른다(Express Tools 명령 COPYM·EXTRIM은 한국어로 옮겼다).
 * 기하 계산은 src/edit/geom(align, blend, measure, markup, overkill, extrim, bpoly, textjust, pedit, splinedit).
 */
import type { Entity, InsertEntity, PointEntity } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { frameSetting } from '../core/framevars';
import { frameSettingOps } from '../edit/framevars';
import { type EditResult, reverseEntity, transformEntity } from '../edit/geom';
import { alignTransform } from '../edit/geom/align';
import { type Continuity, blendEntities, blendPath } from '../edit/geom/blend';
import { boundaryObjects } from '../edit/geom/bpoly';
import { pathBox } from '../edit/geom/curve';
import { extrim, isExtrimEdge } from '../edit/geom/extrim';
import { cloudPolyline, makeWipeout, outlineOf } from '../edit/geom/markup';
import { affScale, affTranslate } from '../edit/geom/math';
import { divideStations, measureStations, nearerToEnd } from '../edit/geom/measure';
import { type OverkillProp, overkill } from '../edit/geom/overkill';
import { entityPath, makeSpline } from '../edit/geom/path';
import { MTEXT_ATTACH, TEXT_JUST, isTextLike, justifyText, scaleBasePoint, textHeightOf } from '../edit/geom/textjust';
import type { HatchPath } from '../core/model';
import { detectBoundary } from '../edit/hatch';
import type { App, CommandContext, Keyword } from './app';
import { addEntities, currentProps } from './draw';
import { Ghost, commitResults } from './modify';
import { askNumber, choose, fmtLen, hnum, memOf, previewOf, propsTemplate, resultPreview, selectEditable, transformList, undoStep, visibleEntities, yesNo } from './modify2-util';
import { registerPeditCommands } from './modify2-pedit';
import { unlockedOnly } from './layers';
import { form } from './ui/dom';
import type { OverlayGeom, Pt } from './view';

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });

/** 자리맞추기 옵션 목록(SCALETEXT·JUSTIFYTEXT) */
const JUST_LABELS: [string, string][] = [
  ['L', '왼쪽'],
  ['A', '정렬'],
  ['F', '맞춤'],
  ['C', '중심'],
  ['M', '중간'],
  ['R', '오른쪽'],
  ['TL', '맨 위 왼쪽'],
  ['TC', '맨 위 중심'],
  ['TR', '맨 위 오른쪽'],
  ['ML', '중간 왼쪽'],
  ['MC', '중간 중심'],
  ['MR', '중간 오른쪽'],
  ['BL', '맨 아래 왼쪽'],
  ['BC', '맨 아래 중심'],
  ['BR', '맨 아래 오른쪽'],
];

function kwList(list: [string, string][]): Keyword[] {
  return list.map(([key, label]) => ({ key, label }));
}

function kwText(list: [string, string][]): string {
  return list.map(([k, l]) => `${l}(${k})`).join('/');
}

export function registerModify2Commands(app: App): void {
  // ------------------------------------------------------------- ALIGN
  app.register({
    name: 'ALIGN',
    aliases: ['AL'],
    title: '정렬',
    async run(ctx) {
      const st = app.active!;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const ghost = new Ghost(app, hs);
      const src: Pt[] = [];
      const dst: Pt[] = [];
      const ord = ['첫 번째', '두 번째', '세 번째'];
      for (let i = 0; i < 3; i++) {
        const prompt = i === 2 ? '세 번째 근원점 지정 또는 <계속>:' : `${ord[i]} 근원점 지정:`;
        const a = await ctx.getPoint(prompt);
        if ('enter' in a && i > 0) break;
        if (!('point' in a)) return;
        const s = a.point;
        const b = await ctx.getPoint(`${ord[i]} 대상점 지정:`, {
          base: s,
          ghost: (p) => {
            const m = alignTransform([...src, s], [...dst, p], false);
            return m ? ghost.at(m) : [];
          },
        });
        if (!('point' in b)) return;
        src.push(s);
        dst.push(b.point);
      }
      const scale = src.length === 2 ? await yesNo(ctx, '정렬 점을 기준으로 객체에 축척을 적용합니까?', false) : false;
      const m = alignTransform(src, dst, scale);
      if (!m) return;
      st.selection.clear();
      commitResults(app, ctx, transformList(st, hs, m, false), 'ALIGN');
      app.refreshSelectionOverlay();
    },
  });

  // ------------------------------------------------------------- BLEND
  app.register({
    name: 'BLEND',
    title: '곡선 혼합',
    async run(ctx) {
      const st = app.active!;
      const m = memOf(st);
      let cont: Continuity = m.blendCon === 'smooth' ? 'smooth' : 'tangent';
      let first: { e: Entity; p: Pt } | null = null;
      while (!first) {
        ctx.print(`연속성 = ${cont === 'tangent' ? '접선' : '부드럽게'}`);
        const r = await ctx.getEntity('첫 번째 객체 선택 또는 [연속성(CON)]:', [{ key: 'CON', label: '연속성' }]);
        if ('enter' in r) return;
        if ('keyword' in r) {
          const k = await choose(ctx, `연속성 입력 [접선(T)/부드럽게(S)] <${cont === 'tangent' ? '접선' : '부드럽게'}>:`, [{ key: 'T', label: '접선' }, { key: 'S', label: '부드럽게' }], cont === 'tangent' ? 'T' : 'S');
          cont = k === 'S' ? 'smooth' : 'tangent';
          m.blendCon = cont;
          continue;
        }
        const e = st.doc.entityIndex.get(r.handle);
        if (!e || !blendPath(e)) {
          ctx.print('선, 호, 타원형 호, 열린 폴리선, 열린 스플라인을 선택하십시오.', 'err');
          continue;
        }
        first = { e, p: r.point };
      }
      for (;;) {
        const r = await ctx.getEntity('두 번째 점 선택:');
        if (!('handle' in r)) return;
        const e2 = st.doc.entityIndex.get(r.handle);
        if (!e2) continue;
        const n = blendEntities(first.e, first.p, e2, r.point, cont);
        if (typeof n === 'string') {
          ctx.print(n, 'err');
          continue;
        }
        const sp = makeSpline(propsTemplate(app), n);
        addEntities(app, ctx, [sp], 'BLEND');
        return;
      }
    },
  });

  // ------------------------------------------------------------- COPYM
  app.register({
    name: 'COPYM',
    title: '여러 번 복사',
    async run(ctx) {
      const st = app.active!;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const b = await ctx.getPoint('기준점 지정:');
      if (!('point' in b)) return;
      const base = b.point;
      const ghost = new Ghost(app, hs);
      const steps: number[] = [];
      const lasts: Pt[] = [];
      let acc: Pt | null = null;
      let last: Pt | null = null;
      const place = (ds: Pt[]) => {
        const res: EditResult[] = [];
        for (const d of ds) res.push(...transformList(st, hs, affTranslate(d.x, d.y), true));
        steps.push(commitResults(app, ctx, res, 'COPYM', { quiet: true }).ops);
      };
      const at = (p: Pt) => ghost.at(affTranslate(p.x - base.x, p.y - base.y));
      for (;;) {
        const r = await ctx.getPoint('두 번째 점 지정 또는 [반복(마지막)(R)/분할(D)/측정(M)/배열(동적)(A)/명령 취소(U)] <종료>:', {
          base,
          ghost: at,
          keywords: [
            { key: 'R', label: '반복(마지막)' },
            { key: 'D', label: '분할' },
            { key: 'M', label: '측정' },
            { key: 'A', label: '배열(동적)' },
            { key: 'U', label: '명령 취소' },
          ],
        });
        if ('enter' in r) return;
        if ('point' in r) {
          const d = sub(r.point, base);
          place([d]);
          lasts.push(d);
          acc = d;
          last = d;
          continue;
        }
        if (!('keyword' in r)) return;
        const k = r.keyword;
        if (k === 'U') {
          if (undoStep(app, ctx, steps)) lasts.pop();
          acc = lasts[lasts.length - 1] ?? null;
          continue;
        }
        if (k === 'R') {
          if (!last || !acc) {
            ctx.print('반복할 복사가 없습니다.', 'err');
            continue;
          }
          acc = { x: acc.x + last.x, y: acc.y + last.y };
          place([acc]);
          lasts.push(acc);
          continue;
        }
        if (k === 'D' || k === 'M') {
          const q = await ctx.getPoint('두 번째 점 지정:', { base, ghost: at });
          if (!('point' in q)) continue;
          const d = sub(q.point, base);
          const L = Math.hypot(d.x, d.y);
          if (!(L > 0)) continue;
          const list: Pt[] = [];
          if (k === 'D') {
            const n = await askNumber(ctx, '분할 수 입력', 2, { int: true, min: 1, max: 10000, distance: false });
            if (typeof n !== 'number') continue;
            for (let i = 1; i <= n; i++) list.push({ x: (d.x * i) / n, y: (d.y * i) / n });
          } else {
            const s = await askNumber(ctx, '간격 거리 지정', null, { positive: true, base });
            if (typeof s !== 'number') continue;
            const n = Math.floor(L / s + 1e-9);
            if (n > 10000) {
              ctx.print('복사본이 너무 많습니다(10000개까지).', 'err');
              continue;
            }
            for (let i = 1; i <= n; i++) list.push({ x: (d.x * s * i) / L, y: (d.y * s * i) / L });
          }
          if (!list.length) continue;
          place(list);
          lasts.push(list[list.length - 1]!);
          acc = list[list.length - 1]!;
          last = list[0]!;
          continue;
        }
        if (k === 'A') {
          const p1 = await ctx.getPoint('첫 번째 구석 지정(단위 간격):', { base, ghost: at });
          if (!('point' in p1)) continue;
          const u = sub(p1.point, base);
          const grid = (p2: Pt): Pt[] => {
            const ext = sub(p2, base);
            const nx = Math.abs(u.x) > 1e-12 && ext.x / u.x > 0 ? Math.floor(ext.x / u.x + 1e-9) : 0;
            const ny = Math.abs(u.y) > 1e-12 && ext.y / u.y > 0 ? Math.floor(ext.y / u.y + 1e-9) : 0;
            const out: Pt[] = [];
            for (let i = 0; i <= nx && out.length <= 10000; i++) for (let j = 0; j <= ny && out.length <= 10000; j++) if (i || j) out.push({ x: u.x * i, y: u.y * j });
            return out;
          };
          const p2 = await ctx.getPoint('두 번째 구석 지정(범위):', {
            base,
            rubber: (q) => [{ pts: [base.x, base.y, q.x, base.y, q.x, q.y, base.x, q.y], closed: true, dashed: true }],
            ghost: (q) => {
              const g = grid(q);
              return g.length <= 200 ? g.flatMap((d) => ghost.at(affTranslate(d.x, d.y))) : [];
            },
          });
          if (!('point' in p2)) continue;
          const list = grid(p2.point);
          if (!list.length) continue;
          if (list.length > 10000) {
            ctx.print('복사본이 너무 많습니다(10000개까지).', 'err');
            continue;
          }
          place(list);
          lasts.push(list[list.length - 1]!);
          acc = list[list.length - 1]!;
          last = null;
          continue;
        }
      }
    },
  });

  // ------------------------------------------------------------- EXTRIM
  app.register({
    name: 'EXTRIM',
    title: '경계로 자르기',
    async run(ctx) {
      const st = app.active!;
      ctx.print('절단 모서리로 사용할 폴리선, 선, 원, 호 또는 타원 선택...');
      let edge: Entity | null = null;
      while (!edge) {
        const r = await ctx.getEntity('객체 선택:');
        if (!('handle' in r)) return;
        const e = st.doc.entityIndex.get(r.handle);
        if (e && isExtrimEdge(e)) edge = e;
        else ctx.print('폴리선, 선, 원, 호, 타원 또는 스플라인을 선택하십시오.', 'err');
      }
      const ep = entityPath(edge)!;
      const b = pathBox(ep);
      const pk = app.picker();
      const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 1e-6;
      const hs = pk ? pk.overlapping([b.minX - pad, b.minY - pad, b.maxX + pad, b.maxY + pad]) : [];
      for (const e of st.doc.blocks.get(st.space)?.entities ?? []) if ((e.type === 'XLINE' || e.type === 'RAY') && !hs.includes(e.handle)) hs.push(e.handle);
      const cands = unlockedOnly(app, hs.filter((h) => h !== edge!.handle))
        .map((h) => st.doc.entityIndex.get(h))
        .filter((e): e is Entity => !!e);
      const e0 = edge;
      const r = await ctx.getPoint('자를 쪽 지정:', { ghost: cands.length <= 300 ? (p) => resultPreview(app, extrim(e0, p, cands, st.doc)) : undefined });
      if (!('point' in r)) return;
      const res = extrim(edge, r.point, cands, st.doc);
      if (!res.replace?.length && !res.add?.length && !res.remove?.length) {
        ctx.print(res.message ?? '자를 객체가 없습니다.');
        return;
      }
      commitResults(app, ctx, [{ ...res, message: undefined }], 'EXTRIM');
    },
  });

  // ------------------------------------------------------------- OVERKILL
  app.register({
    name: 'OVERKILL',
    title: '중복 객체 삭제',
    async run(ctx) {
      const st = app.active!;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const m = memOf(st);
      const saved = (m.overkill as Record<string, number | boolean> | undefined) ?? {};
      const PROPS: [OverkillProp, string][] = [
        ['color', '색상'],
        ['layer', '도면층'],
        ['linetype', '선종류'],
        ['ltscale', '선종류 축척'],
        ['lineweight', '선가중치'],
        ['thickness', '두께'],
        ['transparency', '투명도'],
        ['plotstyle', '플롯 스타일'],
        ['material', '재료'],
      ];
      const v = await form(
        '중복 객체 삭제',
        [
          { key: 'tol', label: '공차', type: 'number', value: Number(saved.tol ?? 0.000001) },
          ...PROPS.map(([k, label]) => ({ key: `ig_${k}`, label: `무시: ${label}`, type: 'check' as const, value: !!saved[`ig_${k}`] })),
          { key: 'opt', label: '폴리선 내의 세그먼트 최적화', type: 'check', value: saved.opt !== false },
          { key: 'overlap', label: '부분 겹침 객체 결합', type: 'check', value: saved.overlap !== false },
          { key: 'end', label: '끝과 끝이 정렬된 동일 선상의 객체 결합', type: 'check', value: saved.end !== false },
        ],
        { ok: '확인', validate: (x) => (Number(x.tol) >= 0 ? null : '공차는 0 이상이어야 합니다.') },
      );
      if (!v) return;
      m.overkill = v;
      const list = hs.map((h) => st.doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
      const r = overkill(list, {
        tolerance: Number(v.tol),
        ignore: PROPS.filter(([k]) => v[`ig_${k}`]).map(([k]) => k),
        optimizePolylines: !!v.opt,
        combineOverlap: !!v.overlap,
        combineEndToEnd: !!v.end,
      });
      st.selection.clear();
      commitResults(app, ctx, [{ ...r.result, message: undefined }], 'OVERKILL');
      app.refreshSelectionOverlay();
      ctx.print(`${r.duplicates}개의 중복 항목 삭제됨`);
      ctx.print(`${r.overlaps}개의 겹치는 객체 또는 세그먼트 삭제됨`);
    },
  });

  // ------------------------------------------------------------- REVERSE
  app.register({
    name: 'REVERSE',
    title: '반전',
    async run(ctx) {
      const st = app.active!;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const res: EditResult[] = [];
      let fail = 0;
      for (const h of hs) {
        const e = st.doc.entityIndex.get(h);
        if (!e) continue;
        const r = reverseEntity(e);
        if (r.replace?.length) res.push(r);
        else fail++;
      }
      if (res.length) commitResults(app, ctx, res, 'REVERSE', { quiet: true });
      ctx.print(`객체 ${res.length}개의 방향이 반전되었습니다.`);
      if (fail) ctx.print(`${fail}개는 선, 폴리선, 스플라인, 나선이 아니어서 건너뛰었습니다.`);
    },
  });

  // ------------------------------------------------------------- DIVIDE·MEASURE
  const divideLike = (mode: 'divide' | 'measure') => async (ctx: CommandContext) => {
    const st = app.active!;
    const doc = st.doc;
    const m = memOf(st);
    let pick: { e: Entity; p: Pt } | null = null;
    while (!pick) {
      const r = await ctx.getEntity(mode === 'divide' ? '등분할 객체 선택:' : '길이 분할 객체 선택:');
      if (!('handle' in r)) return;
      const e = doc.entityIndex.get(r.handle);
      const path = e ? entityPath(e) : null;
      if (!e || !path || e.type === 'XLINE' || e.type === 'RAY') {
        ctx.print(mode === 'divide' ? '이 객체는 등분할할 수 없습니다.' : '이 객체는 길이 분할할 수 없습니다.', 'err');
        continue;
      }
      pick = { e, p: r.point };
    }
    const path = entityPath(pick.e)!;
    let block: string | null = null;
    let align = true;
    const askBlock = async (): Promise<boolean> => {
      for (;;) {
        const r = await ctx.getPoint('삽입할 블록의 이름 입력:', { allowText: true });
        if (!('text' in r)) return false;
        const def = doc.blocks.get(tableKey(r.text.trim()));
        if (!def || r.text.trim().startsWith('*')) {
          ctx.print(`블록 "${r.text.trim()}"을(를) 찾을 수 없습니다.`, 'err');
          continue;
        }
        block = def.name;
        align = await yesNo(ctx, '블록을 객체에 정렬하시겠습니까?', true);
        return true;
      }
    };
    let stations;
    if (mode === 'divide') {
      let n = await askNumber(ctx, '세그먼트의 개수 입력 또는 [블록(B)]', null, { int: true, min: 2, max: 32767, keywords: [{ key: 'B', label: '블록' }], distance: false });
      if (typeof n !== 'number') {
        if (!(await askBlock())) return;
        n = await askNumber(ctx, '세그먼트의 개수 입력', null, { int: true, min: 2, max: 32767, distance: false });
        if (typeof n !== 'number') return;
      }
      stations = divideStations(path, n);
    } else {
      const def = typeof m.measureLen === 'number' ? m.measureLen : null;
      let L = await askNumber(ctx, '세그먼트의 길이 지정 또는 [블록(B)]', def, { positive: true, keywords: [{ key: 'B', label: '블록' }] });
      if (typeof L !== 'number') {
        if (!(await askBlock())) return;
        L = await askNumber(ctx, '세그먼트의 길이 지정', def, { positive: true });
        if (typeof L !== 'number') return;
      }
      m.measureLen = L;
      const list = measureStations(path, L, nearerToEnd(path, pick.p), 32768);
      if (list.length >= 32768) {
        ctx.print('세그먼트가 너무 많습니다. 길이를 늘리십시오.', 'err');
        return;
      }
      stations = list;
    }
    if (!stations.length) {
      ctx.print('놓을 점이 없습니다.');
      return;
    }
    const props = currentProps(app);
    const z = path.z;
    const ents: Entity[] = stations.map((s) => {
      if (block) {
        const ins: InsertEntity = {
          ...entityDefaults(),
          ...props,
          type: 'INSERT',
          handle: '',
          block,
          insert: { x: s.p.x, y: s.p.y, z },
          scale: { x: 1, y: 1, z: 1 },
          rotation: align ? s.angle : 0,
          columnCount: 1,
          rowCount: 1,
          columnSpacing: 0,
          rowSpacing: 0,
          attribs: [],
        };
        return ins;
      }
      const pt: PointEntity = { ...entityDefaults(), ...props, type: 'POINT', handle: '', position: { x: s.p.x, y: s.p.y, z }, angle: 0 };
      return pt;
    });
    const added = addEntities(app, ctx, ents, mode === 'divide' ? 'DIVIDE' : 'MEASURE');
    app.lastSelection = added;
    app.lastCreated = added;
    ctx.print(`${block ? `블록 "${block}"` : '점'} ${added.length}개를 놓았습니다.`);
    const pd = hnum(doc, '$PDMODE', 0);
    if (!block && (pd === 0 || pd === 1)) ctx.print('점이 잘 보이지 않으면 SETVAR로 PDMODE(예: 3)를 바꾸십시오.');
  };
  app.register({ name: 'DIVIDE', aliases: ['DIV'], title: '등분할', run: divideLike('divide') });
  app.register({ name: 'MEASURE', aliases: ['ME'], title: '길이 분할', run: divideLike('measure') });

  // ------------------------------------------------------------- BOUNDARY
  app.register({
    name: 'BOUNDARY',
    aliases: ['BO', 'BPOLY'],
    title: '경계',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const m = memOf(st);
      let islands = m.boIslands !== false;
      const paths: HatchPath[] = [];
      const props = { ...currentProps(app), handle: '' };
      const preview = (): OverlayGeom[] => previewOf(app, boundaryObjects(paths, props));
      ctx.print(`섬 검출 = ${islands ? '예' : '아니오'}`);
      for (;;) {
        const r = await ctx.getPoint('내부 점 선택 또는 [고급 옵션(A)]:', { keywords: [{ key: 'A', label: '고급 옵션' }], ghost: () => preview() });
        if ('enter' in r) break;
        if ('keyword' in r) {
          const k = await choose(ctx, '옵션 입력 [섬 검출(I)] <종료>:', [{ key: 'I', label: '섬 검출' }], 'X');
          if (k === 'I') {
            islands = await yesNo(ctx, '섬 검출 여부', islands);
            m.boIslands = islands;
            ctx.print(`섬 검출 = ${islands ? '예' : '아니오'}`);
          }
          continue;
        }
        if (!('point' in r)) return;
        ctx.print('모든 것 선택 중... 경계 분석 중...');
        const res = detectBoundary(doc, visibleEntities(st), r.point, { islands: islands ? 'normal' : 'ignore' });
        if (!res || !res.paths.length) {
          ctx.print('유효한 경계를 찾을 수 없습니다. 닫힌 영역 안을 선택하십시오.', 'err');
          continue;
        }
        paths.push(...res.paths);
        app.view.overlay.ghost = preview();
        app.view.requestOverlay();
      }
      if (!paths.length) return;
      const objs = boundaryObjects(paths, props);
      if (!objs.length) return;
      addEntities(app, ctx, objs, 'BOUNDARY');
      const nPl = objs.filter((o) => o.type !== 'SPLINE').length;
      const nSp = objs.length - nPl;
      ctx.print(nSp ? `BOUNDARY이(가) 폴리선 ${nPl}개, 스플라인 ${nSp}개를 작성함` : `BOUNDARY이(가) 폴리선 ${nPl}개를 작성함`);
    },
  });

  // ------------------------------------------------------------- REVCLOUD
  app.register({
    name: 'REVCLOUD',
    title: '구름형 리비전',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const m = memOf(st);
      const unit = (hnum(doc, '$MEASUREMENT', 0) === 1 ? 15 : 0.5) * (hnum(doc, '$DIMSCALE', 1) || 1);
      let minArc = typeof m.rcMin === 'number' ? m.rcMin : unit;
      let maxArc = typeof m.rcMax === 'number' ? m.rcMax : unit;
      let calligraphy = m.rcStyle === 'C';
      let type = typeof m.rcType === 'string' ? (m.rcType as string) : 'R';
      const typeName = () => (type === 'R' ? '직사각형' : type === 'P' ? '폴리곤' : '프리핸드');
      const opts = () => ({ minArc, maxArc, calligraphy });
      const props = { ...currentProps(app), handle: '' };
      /** 호가 너무 많지 않게 호 길이를 늘린다 */
      const fitOpts = (pts: Pt[], closed: boolean) => {
        let total = 0;
        for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
        if (closed && pts.length > 1) total += Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y);
        const o = opts();
        const avg = (o.minArc + o.maxArc) / 2;
        if (total / avg > 5000) {
          const k = total / avg / 5000;
          return { ...o, minArc: o.minArc * k, maxArc: o.maxArc * k, scaled: true };
        }
        return { ...o, scaled: false };
      };
      const cloudOf = (pts: Pt[], closed: boolean, reverse = false, from?: Entity) => {
        const o = fitOpts(pts, closed);
        const base = from ? { ...props, layer: from.layer, color: { ...from.color }, linetype: from.linetype, lineweight: from.lineweight, ltscale: from.ltscale, transparency: from.transparency } : props;
        return { e: cloudPolyline(base, pts, closed, { ...o, reverse }), scaled: o.scaled };
      };
      /** from: 구름으로 바꾼 원본(특성을 잇는다). remove면 원본을 지운다(DELOBJ) */
      const finish = (pts: Pt[], closed: boolean, reverse = false, from?: Entity, remove = false): void => {
        const c = cloudOf(pts, closed, reverse, from);
        if (!c.e) {
          ctx.print('구름형 리비전을 만들 수 없습니다.', 'err');
          return;
        }
        if (c.scaled) ctx.print('호가 너무 많아 호 길이를 늘렸습니다.');
        if (from && remove) commitResults(app, ctx, [{ add: [c.e], remove: [from.handle] }], 'REVCLOUD', { quiet: true });
        else addEntities(app, ctx, [c.e], 'REVCLOUD');
        ctx.print('구름형 리비전을 완료했습니다.');
      };
      for (;;) {
        ctx.print(`최소 호 길이: ${fmtLen(app, minArc)}   최대 호 길이: ${fmtLen(app, maxArc)}   스타일: ${calligraphy ? '컬리그래피' : '일반'}   유형: ${typeName()}`);
        const first = type === 'R' ? '첫 번째 구석점 지정' : type === 'P' ? '시작점 지정' : '첫 번째 점 지정';
        const r = await ctx.getPoint(`${first} 또는 [호 길이(A)/객체(O)/직사각형(R)/폴리곤(P)/프리핸드(F)/스타일(S)] <객체>:`, {
          keywords: [
            { key: 'A', label: '호 길이' },
            { key: 'O', label: '객체' },
            { key: 'R', label: '직사각형' },
            { key: 'P', label: '폴리곤' },
            { key: 'F', label: '프리핸드' },
            { key: 'S', label: '스타일' },
          ],
        });
        if ('keyword' in r && r.keyword !== 'O') {
          const k = r.keyword;
          if (k === 'A') {
            const a = await askNumber(ctx, '최소 호 길이 지정', minArc, { positive: true });
            if (typeof a !== 'number') continue;
            for (;;) {
              const b = await askNumber(ctx, '최대 호 길이 지정', Math.max(a, Math.min(maxArc, a * 3)), { positive: true });
              if (typeof b !== 'number') break;
              if (b < a || b > a * 3) {
                ctx.print('최대 호 길이는 최소 호 길이 이상, 최소 호 길이의 3배 이하여야 합니다.', 'err');
                continue;
              }
              minArc = a;
              maxArc = b;
              m.rcMin = a;
              m.rcMax = b;
              break;
            }
          } else if (k === 'S') {
            const s = await choose(ctx, `호 스타일 선택 [일반(N)/컬리그래피(C)] <${calligraphy ? '컬리그래피' : '일반'}>:`, [{ key: 'N', label: '일반' }, { key: 'C', label: '컬리그래피' }], calligraphy ? 'C' : 'N');
            calligraphy = s === 'C';
            m.rcStyle = s;
          } else {
            type = k;
            m.rcType = k;
          }
          continue;
        }
        if ('enter' in r || 'keyword' in r) {
          // 객체
          const o = await ctx.getEntity('객체 선택:');
          if (!('handle' in o)) return;
          const e = st.doc.entityIndex.get(o.handle);
          const out = e ? outlineOf(e) : null;
          if (!e || !out || out.pts.length < 2 || !unlockedOnly(app, [o.handle]).length) {
            ctx.print('선, 호, 원, 타원, 폴리선, 스플라인을 선택하십시오.', 'err');
            continue;
          }
          const reverse = await yesNo(ctx, '방향 반전', false);
          const keep = hnum(doc, '$DELOBJ', 3) === 0;
          finish(out.pts, out.closed, reverse, e, !keep);
          return;
        }
        if (!('point' in r)) return;
        const p0 = r.point;
        if (type === 'R') {
          const corners = (q: Pt): Pt[] => [p0, { x: q.x, y: p0.y }, q, { x: p0.x, y: q.y }];
          const q = await ctx.getPoint('반대 구석 지정:', {
            base: p0,
            rubber: (q) => [{ pts: corners(q).flatMap((c) => [c.x, c.y]), closed: true, dashed: true }],
            ghost: (q) => (Math.abs(q.x - p0.x) > 0 && Math.abs(q.y - p0.y) > 0 ? previewOf(app, [cloudOf(corners(q), true).e]) : []),
          });
          if (!('point' in q)) return;
          if (!(Math.abs(q.point.x - p0.x) > 0 && Math.abs(q.point.y - p0.y) > 0)) {
            ctx.print('직사각형의 폭과 높이는 0보다 커야 합니다.', 'err');
            return;
          }
          finish(corners(q.point), true);
          return;
        }
        // 폴리곤·프리핸드: 점을 차례로
        const pts: Pt[] = [p0];
        let closed = true;
        for (;;) {
          const free = type === 'F';
          const q = await ctx.getPoint(pts.length < 2 ? '다음 점 지정:' : '다음 점 지정 또는 [명령 취소(U)]:', {
            base: pts[pts.length - 1]!,
            keywords: pts.length >= 2 ? [{ key: 'U', label: '명령 취소' }] : [],
            rubber: (c) => [{ pts: [...pts, c].flatMap((v) => [v.x, v.y]), closed: !free, dashed: true }],
            ghost: (c) => (pts.length >= 2 ? previewOf(app, [cloudOf([...pts, c], !free).e]) : []),
          });
          if ('keyword' in q) {
            if (pts.length > 1) pts.pop();
            continue;
          }
          if ('enter' in q) break;
          if (!('point' in q)) return;
          // 프리핸드: 시작점 가까이 돌아오면 닫고 끝낸다
          if (free && pts.length >= 3 && Math.hypot(q.point.x - p0.x, q.point.y - p0.y) <= maxArc) break;
          pts.push(q.point);
        }
        if (type === 'F') {
          const last = pts[pts.length - 1]!;
          closed = pts.length >= 3 && Math.hypot(last.x - p0.x, last.y - p0.y) <= maxArc * 2;
          if (!closed && pts.length >= 2) {
            const rev = await yesNo(ctx, '방향 반전', false);
            finish(pts, false, rev);
            return;
          }
        }
        if (pts.length < (closed ? 3 : 2)) {
          ctx.print('점이 부족합니다.', 'err');
          return;
        }
        finish(pts, closed);
        return;
      }
    },
  });

  // ------------------------------------------------------------- WIPEOUT
  app.register({
    name: 'WIPEOUT',
    title: '가리기',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const r = await ctx.getPoint('첫 번째 점 지정 또는 [프레임(F)/폴리선(P)] <폴리선>:', {
        keywords: [
          { key: 'F', label: '프레임' },
          { key: 'P', label: '폴리선' },
        ],
      });
      const props = { ...currentProps(app), handle: '' };
      if ('keyword' in r && r.keyword === 'F') {
        const cur = frameSetting(doc, 'wipeout');
        const def = cur === 0 ? 'OFF' : cur === 2 ? 'D' : 'ON';
        const k = await choose(ctx, `모드 입력 [켜기(ON)/끄기(OFF)/표시하지만 플롯 안 함(D)] <${cur === 0 ? '끄기' : cur === 2 ? '표시하지만 플롯 안 함' : '켜기'}>:`, [{ key: 'ON', label: '켜기' }, { key: 'OFF', label: '끄기' }, { key: 'D', label: '표시하지만 플롯 안 함' }], def);
        const v = k === 'OFF' ? 0 : k === 'D' ? 2 : 1;
        if (v === cur) return;
        // 변수 객체(ACAD_WIPEOUT_VARS)가 바뀌면 편집 관리자가 화면을 다시 만든다
        const ops = frameSettingOps(doc, 'wipeout', v, () => st.session.newHandle());
        if (!ops) {
          ctx.print('이 도면에는 이름 있는 객체 사전이 없어 프레임 설정을 저장할 수 없습니다.', 'err');
          return;
        }
        st.session.commit({ label: 'WIPEOUT', ops, group: ctx.group });
        ctx.print(`가리기 프레임 = ${v === 0 ? '끄기' : v === 2 ? '표시하지만 플롯 안 함' : '켜기'}`);
        return;
      }
      if ('enter' in r || 'keyword' in r) {
        for (;;) {
          const o = await ctx.getEntity('닫힌 폴리선 선택:');
          if (!('handle' in o)) return;
          const e = doc.entityIndex.get(o.handle);
          const closed = e && (e.type === 'LWPOLYLINE' ? e.closed : e.type === 'POLYLINE' && e.kind === '2d' && (e.flags & 1) !== 0);
          const out = closed ? outlineOf(e!) : null;
          if (!e || !out || out.pts.length < 3) {
            ctx.print('닫힌 폴리선을 선택하십시오.', 'err');
            continue;
          }
          const w = makeWipeout(props, out.pts, entityPath(e)?.z ?? 0);
          if (!w) {
            ctx.print('넓이가 없는 폴리선입니다.', 'err');
            continue;
          }
          const del = unlockedOnly(app, [e.handle]).length > 0 && (await yesNo(ctx, '폴리선을 지우시겠습니까?', false));
          commitResults(app, ctx, [{ add: [w], ...(del ? { remove: [e.handle] } : {}) }], 'WIPEOUT', { quiet: true });
          return;
        }
      }
      if (!('point' in r)) return;
      const pts: Pt[] = [r.point];
      for (;;) {
        const kws: Keyword[] = [...(pts.length >= 3 ? [{ key: 'C', label: '닫기' }] : []), ...(pts.length >= 2 ? [{ key: 'U', label: '명령 취소' }] : [])];
        const prompt = pts.length >= 3 ? '다음 점 지정 또는 [닫기(C)/명령 취소(U)]:' : pts.length >= 2 ? '다음 점 지정 또는 [명령 취소(U)]:' : '다음 점 지정:';
        const q = await ctx.getPoint(prompt, {
          base: pts[pts.length - 1]!,
          keywords: kws,
          rubber: (c) => [{ pts: [...pts, c].flatMap((v) => [v.x, v.y]), closed: true, fill: true }],
        });
        if ('enter' in q || ('keyword' in q && q.keyword === 'C')) break;
        if ('keyword' in q) {
          if (pts.length > 1) pts.pop();
          continue;
        }
        if (!('point' in q)) return;
        pts.push(q.point);
      }
      const w = makeWipeout(props, pts);
      if (!w) {
        ctx.print('세 점 이상으로 넓이가 있는 영역을 지정하십시오.', 'err');
        return;
      }
      addEntities(app, ctx, [w], 'WIPEOUT');
    },
  });

  // ------------------------------------------------------------- IMAGEFRAME·WIPEOUTFRAME
  for (const [name, kind, label] of [
    ['IMAGEFRAME', 'image', '이미지 테두리'],
    ['WIPEOUTFRAME', 'wipeout', '가리기 테두리'],
  ] as const) {
    app.register({
      name,
      title: label,
      transparent: true,
      async run(ctx) {
        const st = app.active!;
        const cur = frameSetting(st.doc, kind);
        const v = await askNumber(ctx, `${name}에 대한 새 값 입력(0 숨김, 1 표시·플롯, 2 표시하지만 플롯 안 함)`, cur, { int: true, min: 0, max: 2 });
        if (typeof v !== 'number' || v === cur) return;
        const ops = frameSettingOps(st.doc, kind, v, () => st.session.newHandle());
        if (!ops) {
          ctx.print('이 도면에는 이름 있는 객체 사전이 없어 설정을 저장할 수 없습니다.', 'err');
          return;
        }
        st.session.commit({ label: name, ops, group: ctx.group });
      },
    });
  }

  // ------------------------------------------------------------- SCALETEXT·JUSTIFYTEXT
  const textOnly = (hs: string[]): Entity[] => {
    const st = app.active!;
    return hs.map((h) => st.doc.entityIndex.get(h)).filter((e): e is Entity => !!e && (isTextLike(e) || e.type === 'MTEXT'));
  };
  app.register({
    name: 'SCALETEXT',
    title: '문자 축척',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const m = memOf(st);
      const list = textOnly(await selectEditable(app, ctx));
      if (!list.length) {
        ctx.print('문자 객체가 선택되지 않았습니다.');
        return;
      }
      const baseKws: [string, string][] = [['E', '기존'], ...JUST_LABELS.filter(([k]) => k !== 'A' && k !== 'F')];
      const key = await choose(ctx, `축척에 대한 기준점 옵션 입력 [${kwText(baseKws)}] <${String(m.stBaseLabel ?? '기존')}>:`, kwList(baseKws), String(m.stBase ?? 'E'));
      m.stBase = key;
      m.stBaseLabel = baseKws.find(([k]) => k === key)?.[1] ?? '기존';
      let height: number | null = null;
      let factor: number | null = null;
      const lastH = typeof m.stHeight === 'number' ? m.stHeight : (textHeightOf(list[0]!, doc) ?? 2.5);
      for (;;) {
        const r = await askNumber(ctx, '새 모형 높이 지정 또는 [도면 높이(P)/객체 일치(M)/축척 비율(S)]', lastH, {
          positive: true,
          keywords: [
            { key: 'P', label: '도면 높이' },
            { key: 'M', label: '객체 일치' },
            { key: 'S', label: '축척 비율' },
          ],
        });
        if (typeof r === 'number') {
          height = r;
          break;
        }
        if (r.keyword === 'P') {
          const h = await askNumber(ctx, '새 도면 높이 지정', lastH, { positive: true });
          if (typeof h !== 'number') continue;
          height = h;
          break;
        }
        if (r.keyword === 'M') {
          const o = await ctx.getEntity('높이가 일치하는 객체 선택:');
          if (!('handle' in o)) continue;
          const e = doc.entityIndex.get(o.handle);
          const h = e ? textHeightOf(e, doc) : null;
          if (!h) {
            ctx.print('문자 객체를 선택하십시오.', 'err');
            continue;
          }
          ctx.print(`높이=${fmtLen(app, h)}`);
          height = h;
          break;
        }
        const s = await askNumber(ctx, '축척 비율 지정 또는 [참조(R)]', typeof m.stFactor === 'number' ? m.stFactor : 2, { positive: true, keywords: [{ key: 'R', label: '참조' }], text: (v) => String(+v.toFixed(4)) });
        if (typeof s === 'number') {
          factor = s;
          m.stFactor = s;
          break;
        }
        const ref = await askNumber(ctx, '참조 길이 지정', 1, { positive: true });
        if (typeof ref !== 'number') continue;
        const nl = await askNumber(ctx, '새 길이 지정', null, { positive: true });
        if (typeof nl !== 'number') continue;
        factor = nl / ref;
        break;
      }
      if (height !== null) m.stHeight = height;
      const res: EditResult[] = [];
      for (const e of list) {
        const h = textHeightOf(e, doc);
        const k = factor ?? (h ? height! / h : 1);
        if (!(k > 0) || Math.abs(k - 1) < 1e-12) continue;
        const p = scaleBasePoint(e, key, doc);
        if (!p) continue;
        res.push(transformEntity(e, affScale(k, k, p), doc));
      }
      st.selection.clear();
      commitResults(app, ctx, res, 'SCALETEXT', { quiet: true });
      app.refreshSelectionOverlay();
      ctx.print(`문자 객체 ${res.length}개를 축척했습니다.`);
    },
  });

  app.register({
    name: 'JUSTIFYTEXT',
    title: '문자 자리맞추기',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const list = textOnly(await selectEditable(app, ctx));
      if (!list.length) {
        ctx.print('문자 객체가 선택되지 않았습니다.');
        return;
      }
      // 기본값: 첫 문자의 지금 자리맞추기
      const e0 = list[0]!;
      let defKey = 'L';
      if (isTextLike(e0)) defKey = Object.entries(TEXT_JUST).find(([, j]) => j.ha === e0.halign && j.va === e0.valign)?.[0] ?? 'L';
      else if (e0.type === 'MTEXT') defKey = Object.entries(MTEXT_ATTACH).find(([k, a]) => a === e0.attachment && k.length === 2)?.[0] ?? 'TL';
      const defLabel = JUST_LABELS.find(([k]) => k === defKey)?.[1] ?? '왼쪽';
      const key = await choose(ctx, `자리맞추기 옵션 입력 [${kwText(JUST_LABELS)}] <${defLabel}>:`, kwList(JUST_LABELS), defKey);
      const res: EditResult[] = [];
      for (const e of list) {
        const o = justifyText(e, key, doc);
        if (o) res.push({ replace: [o] });
      }
      if (res.length) commitResults(app, ctx, res, 'JUSTIFYTEXT', { quiet: true });
      ctx.print(`문자 객체 ${res.length}개의 자리맞추기를 바꿨습니다.`);
    },
  });

  registerPeditCommands(app);
}
