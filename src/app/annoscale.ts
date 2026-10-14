/**
 * 주석 축척 명령: SCALELISTEDIT·-SCALELISTEDIT, CANNOSCALE·CANNOSCALEVALUE, OBJECTSCALE·-OBJECTSCALE,
 * AIOBJECTSCALEADD·AIOBJECTSCALEREMOVE, ANNORESET, ANNOUPDATE, ANNOALLVISIBLE, ANNOAUTOSCALE, HIDEXREFSCALES.
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 계산은 src/edit/annoscale, 앱 쪽 일은 annoscale-core.ts.
 */
import type { Entity } from '../core/model';
import type { EditOp } from '../edit/session';
import {
  type AnnoScale,
  ScaleIndex,
  annoState,
  defaultScales,
  findScale,
  fmtNum,
  isMetric,
  isUsed,
  makeAnnotative,
  makeNonAnnotative,
  nameProblem,
  parseRatio,
  readScaleList,
  resetScales,
  textStyleAnnotative,
  usedScales,
  valueOf,
} from '../edit/annoscale';
import { wcmatch } from '../edit/util/wildcard';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import {
  annoAutoscale,
  chooseScale,
  commitOwn,
  currentScaleName,
  ensureScaleList,
  envFor,
  hideXrefScales,
  installAnnoHooks,
  scaleForSpace,
  setAllVisible,
  setAnnoAutoscale,
  setHideXrefScales,
  shownScale,
  tabAllVisible,
} from './annoscale-core';
import { applyObjectScales, applyScaleList, objectScaleDialog, resetList, scaleListDialog } from './annoscale-ui';
import { askKeyword, askText, askYesNo } from './util2-ui';

const unquote = (t: string): string => t.trim().replace(/^"(.*)"$/, '$1').trim();

/** 리스트(없으면 단위의 기본 리스트) */
function listOf(st: DocState): AnnoScale[] {
  const l = readScaleList(st.doc);
  return l.length ? l : defaultScales(isMetric(st.doc));
}

/** 고른 객체 가운데 주석 객체(나머지 수도) */
function annotativeOf(st: DocState, handles: string[]): { list: Entity[]; other: number } {
  const idx = new ScaleIndex(st.doc);
  const list: Entity[] = [];
  let other = 0;
  for (const h of handles) {
    const e = st.doc.entityIndex.get(h);
    const s = e ? annoState(st.doc, e, idx) : null;
    if (e && s && !s.foreign) list.push(e);
    else other++;
  }
  return { list, other };
}

/** 지금 공간의 "현재 주석 축척" 이름(모형 = CANNOSCALE·활성 뷰포트, 배치 = 1:1) */
function currentFor(app: App, st: DocState): AnnoScale | undefined {
  return scaleForSpace(app, st, st.space);
}

export function registerAnnoScaleCommands(app: App): void {
  installAnnoHooks(app);

  // ------------------------------------------------------------- CANNOSCALE
  app.register({
    name: 'CANNOSCALE',
    title: '현재 주석 축척',
    run: async (ctx, arg) => {
      const st = app.active!;
      const sh = shownScale(app);
      if (sh.where === 'paper') {
        ctx.print('도면 공간의 주석 축척은 1:1입니다. 모형 공간이나 뷰포트 안에서 바꾸십시오.');
        return;
      }
      if (sh.where === 'none') {
        ctx.print('블록 편집기에서는 주석 축척을 바꿀 수 없습니다.', 'err');
        return;
      }
      const cur = sh.scale?.name ?? currentScaleName(st);
      const raw = arg ?? (await askText(ctx, `CANNOSCALE에 대한 새 값 입력 <"${cur}">:`, ''));
      const t = unquote(raw);
      if (!t) return;
      const s = findScale(listOf(st), t);
      if (!s) {
        ctx.print(`주석 축척 "${t}"을(를) 찾을 수 없습니다.`, 'err');
        return;
      }
      if (!chooseScale(app, s.name, ctx.group)) return;
    },
  });

  app.register({
    name: 'CANNOSCALEVALUE',
    title: '현재 주석 축척 값',
    transparent: true,
    run: (ctx) => {
      const s = shownScale(app).scale;
      ctx.print(`CANNOSCALEVALUE = ${s ? valueOf(s).toFixed(4) : '1.0000'} (읽기 전용)`);
    },
  });

  // ------------------------------------------------------------- SCALELISTEDIT
  app.register({
    name: 'SCALELISTEDIT',
    title: '도면 축척 편집',
    run: async (ctx) => {
      await scaleListDialog(app, app.active!, ctx.group);
    },
  });

  app.register({
    name: '-SCALELISTEDIT',
    title: '도면 축척 편집(명령행)',
    run: async (ctx) => {
      const st = app.active!;
      for (;;) {
        const k = await askKeyword(
          ctx,
          '옵션 입력[?/추가(A)/삭제(D)/재설정(R)/종료(E)] <추가>:',
          [
            { key: '?', label: '?' },
            { key: 'A', label: '추가' },
            { key: 'D', label: '삭제' },
            { key: 'R', label: '재설정' },
            { key: 'E', label: '종료' },
          ],
          'A',
        );
        const key = typeof k === 'string' ? k : k?.text === '?' ? '?' : null;
        if (key === null) {
          ctx.print('옵션을 입력하십시오.', 'err');
          continue;
        }
        if (key === 'E') return;
        if (key === '?') {
          const pat = unquote(await askText(ctx, '나열할 축척 이름 입력 <*>:', '*')) || '*';
          const cur = currentScaleName(st).toUpperCase();
          for (const s of listOf(st)) if (wcmatch(s.name, pat)) ctx.print(`  ${s.name.toUpperCase() === cur ? '* ' : '  '}${s.name}    ${fmtNum(s.paper)} 용지 단위 = ${fmtNum(s.drawing)} 도면 단위`);
          continue;
        }
        if (key === 'A') {
          const name = unquote(await askText(ctx, '새 축척 이름 입력:', ''));
          if (!name) continue;
          const p = nameProblem(name);
          if (p) {
            ctx.print(p, 'err');
            continue;
          }
          const work = listOf(st).map((s) => ({ ...s }));
          const have = findScale(work, name);
          if (have && !(await askYesNo(ctx, `${have.name}이(가) 이미 있습니다.  축척을 재정의하시겠습니까?`, false))) continue;
          let ratio: { paper: number; drawing: number } | null = null;
          while (!ratio) {
            const t = (await askText(ctx, '축척 비율 입력:', '')).trim();
            if (!t) break;
            ratio = parseRatio(t);
            if (!ratio) ctx.print('축척 비율은 1:50, 1=50, 1/50 또는 숫자로 입력하십시오.', 'err');
          }
          if (!ratio) continue;
          if (have) Object.assign(have, ratio);
          else work.push({ name, paper: ratio.paper, drawing: ratio.drawing, unit: false });
          const current = findScale(work, currentScaleName(st));
          applyScaleList(app, st, work, current, ctx.group, '-SCALELISTEDIT');
          continue;
        }
        if (key === 'D') {
          const t = unquote(await askText(ctx, '삭제할 축척 이름 입력 또는 *사용하지 않는 모든 축척을 삭제할 축척 이름 입력:', ''));
          if (!t) continue;
          const work = listOf(st).map((s) => ({ ...s }));
          const used = usedScales(st.doc);
          const cur = findScale(work, currentScaleName(st));
          const keep = (s: AnnoScale) => s === cur || isUsed(used, s);
          let drop: AnnoScale[];
          if (t === '*') drop = work.filter((s) => !keep(s));
          else {
            const hits = work.filter((s) => wcmatch(s.name, t));
            if (!hits.length) {
              ctx.print(`축척 ${t}을(를) 찾지 못했습니다.`, 'err');
              continue;
            }
            for (const s of hits.filter(keep)) ctx.print(`축척 ${s.name}은(는) ${s === cur ? '현재 주석 축척이므로' : '사용 중이므로'} 삭제할 수 없습니다.`);
            drop = hits.filter((s) => !keep(s));
          }
          if (drop.length >= work.length) drop = drop.slice(0, work.length - 1);
          if (!drop.length) continue;
          const next = work.filter((s) => !drop.includes(s));
          if (applyScaleList(app, st, next, cur, ctx.group, '-SCALELISTEDIT')) ctx.print(`${drop.length}개의 축척을 삭제했습니다.`);
          continue;
        }
        if (key === 'R') {
          if (!(await askYesNo(ctx, '축척 리스트를 기본값으로 재설정하시겠습니까?', false))) continue;
          const work = listOf(st);
          const cur = findScale(work, currentScaleName(st));
          applyScaleList(app, st, resetList(st, work, cur), cur, ctx.group, '-SCALELISTEDIT');
          ctx.print('축척 리스트를 기본값으로 재설정했습니다.');
        }
      }
    },
  });

  // ------------------------------------------------------------- 객체 축척
  app.register({
    name: 'OBJECTSCALE',
    title: '주석 객체 축척',
    run: async (ctx) => {
      const st = app.active!;
      const hs = await ctx.getSelection('주석 객체 선택:');
      if (!hs.length) return;
      const { list, other } = annotativeOf(st, hs);
      if (other) ctx.print(`${other}개는 주석 객체가 아닙니다.`);
      if (!list.length) return;
      await objectScaleDialog(app, st, list.map((e) => e.handle), ctx.group);
    },
  });

  app.register({
    name: '-OBJECTSCALE',
    title: '주석 객체 축척(명령행)',
    run: async (ctx) => {
      const st = app.active!;
      const hs = await ctx.getSelection('주석 객체 선택:');
      if (!hs.length) return;
      const { list, other } = annotativeOf(st, hs);
      if (other) ctx.print(`${other}개는 주석 객체가 아닙니다.`);
      if (!list.length) return;
      const k = await askKeyword(
        ctx,
        '옵션 입력 [추가(A)/삭제(D)/?] <추가>:',
        [
          { key: 'A', label: '추가' },
          { key: 'D', label: '삭제' },
          { key: '?', label: '?' },
        ],
        'A',
      );
      const key = typeof k === 'string' ? k : k?.text === '?' ? '?' : 'A';
      const idx = new ScaleIndex(st.doc);
      const listScales = () => {
        for (const e of list) {
          const s = annoState(st.doc, st.doc.entityIndex.get(e.handle) ?? e, idx);
          if (s) ctx.print(`  ${e.type} ${e.handle}: ${s.scales.map((n) => idx.name(n)?.name ?? n).join(', ')}`);
        }
      };
      if (key === '?') return listScales();
      const add = key === 'A';
      const def = currentFor(app, st)?.name ?? '1:1';
      const names: string[] = [];
      for (;;) {
        const t = unquote(await askText(ctx, `${add ? '추가' : '삭제'}할 명명된 축척 입력 또는 [?] <${names.length ? '종료' : def}>:`, names.length ? '' : def));
        if (!t) break;
        if (t === '?') {
          listScales();
          continue;
        }
        const s = findScale(idx.list, t);
        if (!s) {
          ctx.print(`축척 ${t}을(를) 찾지 못했습니다.`, 'err');
          continue;
        }
        if (!names.includes(s.name)) names.push(s.name);
      }
      if (!names.length) return;
      const r = applyObjectScales(st, list, add ? names : [], add ? [] : names, ctx.group, '-OBJECTSCALE');
      if (r.single) ctx.print(`${r.single}개의 객체는 축척이 하나뿐이어서 삭제하지 않았습니다.`);
      ctx.print(`${r.changed}개의 객체를 업데이트했습니다.`);
    },
  });

  const addRemove = (add: boolean) => async (ctx: CommandContext) => {
    const st = app.active!;
    const hs = await ctx.getSelection('주석 객체 선택:');
    if (!hs.length) return;
    const { list, other } = annotativeOf(st, hs);
    if (other) ctx.print(`${other}개는 주석 객체가 아닙니다.`);
    if (!list.length) return;
    const s = currentFor(app, st);
    if (!s) return;
    const r = applyObjectScales(st, list, add ? [s.name] : [], add ? [] : [s.name], ctx.group, add ? 'AIOBJECTSCALEADD' : 'AIOBJECTSCALEREMOVE');
    if (r.single) ctx.print(`${r.single}개의 객체는 축척이 하나뿐이어서 삭제하지 않았습니다.`);
    ctx.print(`${r.changed}개의 객체가 주석 축척 <${s.name}>을(를) 지원하도록 업데이트되었습니다.`);
  };
  app.register({ name: 'AIOBJECTSCALEADD', title: '현재 축척 추가', run: addRemove(true) });
  app.register({ name: 'AIOBJECTSCALEREMOVE', title: '현재 축척 삭제', run: addRemove(false) });

  app.register({
    name: 'ANNORESET',
    title: '주석 위치 재설정',
    run: async (ctx) => {
      const st = app.active!;
      const hs = await ctx.getSelection('주석 객체 선택:');
      if (!hs.length) return;
      const { list, other } = annotativeOf(st, hs);
      if (other) ctx.print(`${other}개는 주석 객체가 아닙니다.`);
      const env = envFor(st);
      const ops: EditOp[] = [];
      for (const e of list) ops.push(...resetScales(env, e).ops);
      commitOwn(st, 'ANNORESET', ops, ctx.group);
      ctx.print(`${list.length}개의 객체를 재설정했습니다.`);
    },
  });

  app.register({
    name: 'ANNOUPDATE',
    title: '주석 업데이트',
    run: async (ctx) => {
      const st = app.active!;
      const hs = await ctx.getSelection();
      if (!hs.length) return;
      ensureScaleList(st, 'ANNOUPDATE', ctx.group);
      const env = envFor(st);
      const s = currentFor(app, st);
      const ops: EditOp[] = [];
      let n = 0;
      for (const h of hs) {
        const e = st.doc.entityIndex.get(h);
        if (!e || (e.type !== 'TEXT' && e.type !== 'MTEXT')) continue;
        const want = textStyleAnnotative(st.doc, e.style);
        const is = !!annoState(st.doc, e, env.idx);
        if (want === is || (want && !s)) continue;
        const r = want ? makeAnnotative(env, e, s!.name) : makeNonAnnotative(env, e);
        if (r.entity === e && !r.ops.length) continue;
        ops.push(...r.ops);
        if (r.entity !== e) ops.push({ kind: 'modify', block: st.session.ownerOf(e.handle) ?? st.space, before: e, after: r.entity });
        n++;
      }
      commitOwn(st, 'ANNOUPDATE', ops, ctx.group);
      ctx.print(`${n}개의 객체를 업데이트했습니다.`);
    },
  });

  // ------------------------------------------------------------- 시스템 변수
  app.register({
    name: 'ANNOALLVISIBLE',
    title: '주석 객체 표시',
    run: async (ctx, arg) => {
      const st = app.active!;
      const cur = tabAllVisible(st) ? 1 : 0;
      for (;;) {
        const r = arg !== undefined ? { text: arg } : await ctx.getPoint(`ANNOALLVISIBLE에 대한 새 값 입력 <${cur}>:`, { allowText: true, preferNumber: true });
        arg = undefined;
        if ('enter' in r) return;
        const v = 'text' in r ? Number(r.text.trim()) : NaN;
        if (v === 0 || v === 1) {
          setAllVisible(st, v === 1, ctx.group);
          return;
        }
        ctx.print('0 또는 1을 입력하십시오.', 'err');
      }
    },
  });

  app.register({
    name: 'ANNOAUTOSCALE',
    title: '주석 축척 변경 시 축척 추가',
    noDoc: true,
    transparent: true,
    run: async (ctx, arg) => {
      const cur = annoAutoscale();
      for (;;) {
        const r = arg !== undefined ? { text: arg } : await ctx.getPoint(`ANNOAUTOSCALE에 대한 새 값 입력 <${cur}>:`, { allowText: true, preferNumber: true });
        arg = undefined;
        if ('enter' in r) return;
        const v = 'text' in r ? Number(r.text.trim()) : NaN;
        if (Number.isInteger(v) && v >= -4 && v <= 4 && v !== 0) {
          setAnnoAutoscale(v);
          app.ui.refreshStatus();
          return;
        }
        ctx.print('-4에서 4 사이의 0이 아닌 정수가 필요합니다.', 'err');
      }
    },
  });

  app.register({
    name: 'HIDEXREFSCALES',
    title: '외부 참조 축척 숨기기',
    noDoc: true,
    transparent: true,
    run: async (ctx, arg) => {
      const cur = hideXrefScales() ? 1 : 0;
      for (;;) {
        const r = arg !== undefined ? { text: arg } : await ctx.getPoint(`HIDEXREFSCALES에 대한 새 값 입력 <${cur}>:`, { allowText: true, preferNumber: true });
        arg = undefined;
        if ('enter' in r) return;
        const v = 'text' in r ? Number(r.text.trim()) : NaN;
        if (v === 0 || v === 1) {
          setHideXrefScales(v === 1);
          app.ui.refreshStatus();
          return;
        }
        ctx.print('0 또는 1을 입력하십시오.', 'err');
      }
    },
  });
}

