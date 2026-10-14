/**
 * 유틸리티 명령(util2): OOPS, RENAME(REN)·-RENAME, AUDIT, STATUS, QUICKCALC(QC)·CAL, LIMITS, MULTIPLE, REDRAW
 */
import type { CadColor, HeaderValue, Vec2 } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import { formatLength } from '../core/units';
import type { EditOp } from '../edit/session';
import { AUDIT_PHASES, auditDocument, docStats } from '../edit/util/audit';
import { CalcError, INSUNITS_MM, LENGTH_UNITS, calcAnswer, calculate, evaluateCalc, formatCalc, prepareCalc, type CalcValue } from '../edit/util/calc';
import { RENAME_KINDS, lockedReason, namesOf, renameOps, renameProblem, type RenameKind } from '../edit/util/rename';
import { hasWildcard, wildRename } from '../edit/util/wildcard';
import type { App, CommandContext } from './app';
import { SNAP_NAMES } from './snap';
import type { SnapKind } from './view';
import { h } from './ui/dom';
import { askKeyword, askText, button, feedPrompt, isNested, listBox, loadPref, modal, padWide, savePref, select, takeErased, textInput, rememberErased, type ErasedItem } from './util2-ui';

// ---------------------------------------------------------------------------
// OOPS: ERASE를 감싸 지운 객체를 기억한다
// ---------------------------------------------------------------------------

function wrapErase(app: App): void {
  const erase = app.findCommand('ERASE');
  if (!erase || (erase as { u2Wrapped?: boolean }).u2Wrapped) return;
  app.register({
    ...erase,
    u2Wrapped: true,
    async run(ctx, arg) {
      const st = app.active;
      const snap: ErasedItem[] = [];
      const wrapped: CommandContext = {
        ...ctx,
        getSelection: async (prompt, opt) => {
          const hs = await ctx.getSelection(prompt, opt);
          if (st) {
            for (const x of hs) {
              const e = st.doc.entityIndex.get(x);
              const block = st.session.ownerOf(x);
              if (e && block) snap.push({ block, entity: e, index: st.doc.blocks.get(block)!.entities.indexOf(e) });
            }
          }
          return hs;
        },
      };
      await erase.run(wrapped, arg);
      if (!st) return;
      const gone = snap.filter((x) => st.doc.entityIndex.get(x.entity.handle) !== x.entity);
      rememberErased(st, gone);
    },
  } as typeof erase & { u2Wrapped: boolean });
}

// ---------------------------------------------------------------------------
// STATUS 도우미
// ---------------------------------------------------------------------------

const ACI_NAMES: Record<number, string> = { 1: '빨간색', 2: '노란색', 3: '초록색', 4: '하늘색', 5: '파란색', 6: '선홍색', 7: '흰색' };

function colorName(c: number | CadColor | undefined): string {
  const aci = typeof c === 'number' ? c : (c?.aci ?? 256);
  if (aci === 256) return 'BYLAYER';
  if (aci === 0) return 'BYBLOCK';
  return `${aci}${ACI_NAMES[aci] ? ` (${ACI_NAMES[aci]})` : ''}`;
}

function v2of(v: HeaderValue | undefined, def: Vec2): Vec2 {
  return v && typeof v === 'object' ? { x: v.x, y: v.y } : def;
}

export function registerUtil2MiscCommands(app: App): void {
  // ------------------------------------------------------------- OOPS
  wrapErase(app);
  app.register({
    name: 'OOPS',
    title: '지운 객체 복원',
    run(ctx) {
      const st = app.active!;
      const list = takeErased(st);
      if (!list?.length) {
        ctx.print('복원할 지운 객체가 없습니다.');
        return;
      }
      const ok = list.filter((x) => st.doc.blocks.has(x.block) && !st.doc.entityIndex.has(x.entity.handle)).sort((a, b) => a.index - b.index);
      if (!ok.length) {
        ctx.print('지운 객체가 이미 복원되었습니다.');
        return;
      }
      const ops: EditOp[] = ok.map((x) => ({ kind: 'add', block: x.block, entity: x.entity, index: x.index }));
      st.session.commit({ label: 'OOPS', ops, group: ctx.group });
      ctx.print(`객체 ${ok.length}개를 복원했습니다.`);
    },
  });

  // ------------------------------------------------------------- RENAME
  app.register({
    name: 'RENAME',
    aliases: ['REN', 'DDRENAME'],
    title: '이름 바꾸기',
    async run(ctx) {
      const st = app.active!;
      let kind: RenameKind = 'layer';
      /** 종류별 원래 이름(대문자) → 바뀐 이름 */
      const pending = new Map<RenameKind, Map<string, { orig: string; now: string }>>();
      const pend = (k: RenameKind) => {
        let m = pending.get(k);
        if (!m) {
          m = new Map();
          pending.set(k, m);
        }
        return m;
      };
      /** 대화상자에 보이는 이름(바꿀 수 있는 것만) */
      const shown = (k: RenameKind) => {
        const m = pend(k);
        return namesOf(st.doc, k)
          .filter((n) => !lockedReason(st.doc, k, n))
          .map((n) => ({ orig: n, now: m.get(tableKey(n))?.now ?? n }))
          .sort((a, b) => a.now.localeCompare(b.now, 'ko'));
      };
      const oldIn = textInput('', '기존 이름(* ? 와일드카드)');
      const newIn = textInput('', '새 이름');
      const err = h('div', { class: 'u2-err' });
      const items = listBox([], null, (v) => {
        oldIn.value = v;
        newIn.focus();
      });
      const renderItems = () => items.set(shown(kind).map((x) => ({ value: x.now, label: x.now })), null);
      const kinds = listBox(
        RENAME_KINDS.map((k) => ({ value: k.kind, label: k.label })),
        kind,
        (v) => {
          kind = v as RenameKind;
          oldIn.value = '';
          err.textContent = '';
          renderItems();
        },
      );
      const doRename = () => {
        err.textContent = '';
        const oldName = oldIn.value.trim();
        const newName = newIn.value.trim();
        if (!oldName) {
          err.textContent = '기존 이름을 고르거나 입력하십시오.';
          return;
        }
        const list = shown(kind);
        const m = pend(kind);
        // 이 종류에서 쓰였거나 쓰일 이름(원래 이름 모두 + 지금 이름)
        const takenFor = (orig: string) => {
          const t = new Set<string>();
          for (const n of namesOf(st.doc, kind)) if (tableKey(n) !== tableKey(orig)) t.add(tableKey(n));
          for (const x of m.values()) if (tableKey(x.orig) !== tableKey(orig)) t.add(tableKey(x.now));
          return t;
        };
        let targets: { orig: string; now: string; next: string }[];
        if (hasWildcard(oldName) && /[*?]/.test(oldName)) {
          targets = list.flatMap((x) => {
            const n = wildRename(x.now, oldName, newName);
            return n === null ? [] : [{ orig: x.orig, now: x.now, next: n }];
          });
          if (!targets.length) {
            err.textContent = `"${oldName}"에 맞는 이름이 없습니다.`;
            return;
          }
        } else {
          if (/[*?]/.test(newName)) {
            err.textContent = '기존 이름에 와일드카드가 없으면 새 이름에도 쓸 수 없습니다.';
            return;
          }
          const hit = list.find((x) => tableKey(x.now) === tableKey(oldName));
          if (!hit) {
            err.textContent = lockedReason(st.doc, kind, oldName) ?? `"${oldName}"을(를) 찾을 수 없습니다.`;
            return;
          }
          targets = [{ orig: hit.orig, now: hit.now, next: newName }];
        }
        // 묶음 안의 이름끼리 겹치는지
        const nextKeys = new Set<string>();
        for (const t of targets) {
          const bad = renameProblem(st.doc, kind, t.orig, t.next, takenFor(t.orig));
          if (bad || nextKeys.has(tableKey(t.next))) {
            err.textContent = `${t.now}: ${bad ?? `${t.next}은(는) 이미 있는 이름입니다.`}`;
            return;
          }
          nextKeys.add(tableKey(t.next));
        }
        for (const t of targets) m.set(tableKey(t.orig), { orig: t.orig, now: t.next });
        oldIn.value = '';
        newIn.value = '';
        renderItems();
      };
      newIn.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ev.stopPropagation();
          doRename();
        }
      });
      renderItems();
      const body = h(
        'div',
        {},
        h('div', { class: 'u2-grid2' }, h('div', {}, h('div', { class: 'u2-note' }, '명명된 객체(N)'), kinds.el), h('div', {}, h('div', { class: 'u2-note' }, '항목(I)'), items.el)),
        h('div', { class: 'form-row', style: 'margin-top:10px;grid-template-columns:190px 1fr' }, h('span', {}, '기존 이름(O):'), oldIn),
        h('div', { class: 'form-row', style: 'grid-template-columns:190px 1fr' }, button('다음으로 이름 바꾸기(R):', doRename), newIn),
        h('div', { class: 'u2-note' }, '확인을 누르면 대화상자에서 바꾼 이름을 모두 한 번에 적용합니다(명령 취소 한 번으로 되돌림). * ?로 여러 이름을 바꿀 수 있습니다(STAIR$* → S_*).'),
        err,
      );
      const res = await modal<'ok' | 'cancel'>('이름 바꾸기', body, [
        { label: '취소', value: 'cancel' },
        { label: '확인', primary: true, value: 'ok' },
      ], 'mid').done;
      if (res !== 'ok') return;
      let n = 0;
      for (const [k, m] of pending)
        for (const x of m.values()) {
          if (x.now === x.orig) continue;
          const ops = renameOps(st.doc, k, x.orig, x.now);
          if (!ops.length) {
            ctx.print(`${x.orig} → ${x.now}: ${renameProblem(st.doc, k, x.orig, x.now) ?? '바꿀 수 없습니다.'}`, 'err');
            continue;
          }
          st.session.commit({ label: 'RENAME', ops, group: ctx.group });
          ctx.print(`${RENAME_KINDS.find((y) => y.kind === k)!.label} ${x.orig} → ${x.now}`);
          n++;
        }
      if (n) {
        app.ui.refreshLayouts();
        ctx.print(`이름 ${n}개를 바꿨습니다.`);
      }
    },
  });

  app.register({
    name: '-RENAME',
    aliases: ['-REN'],
    title: '이름 바꾸기(명령행)',
    async run(ctx) {
      const st = app.active!;
      const r = await askKeyword(
        ctx,
        `이름을 바꿀 객체 유형 입력 [${RENAME_KINDS.map((k) => `${k.label}(${k.key})`).join('/')}]:`,
        RENAME_KINDS.map((k) => ({ key: k.key, label: k.label })),
      );
      const kd = RENAME_KINDS.find((k) => k.key === r);
      if (!kd) return;
      const oldName = (await askText(ctx, `이전 ${kd.label} 이름 입력:`)).trim();
      if (!oldName) return;
      const real = namesOf(st.doc, kd.kind).find((n) => tableKey(n) === tableKey(oldName));
      if (!real) {
        ctx.print(`${kd.label} "${oldName}"을(를) 찾을 수 없습니다.`, 'err');
        return;
      }
      const lock = lockedReason(st.doc, kd.kind, real);
      if (lock) {
        ctx.print(lock, 'err');
        return;
      }
      const newName = (await askText(ctx, `새 ${kd.label} 이름 입력:`)).trim();
      const bad = renameProblem(st.doc, kd.kind, real, newName);
      if (bad) {
        ctx.print(bad, 'err');
        return;
      }
      st.session.commit({ label: 'RENAME', ops: renameOps(st.doc, kd.kind, real, newName), group: ctx.group });
      app.ui.refreshLayouts();
    },
  });

  // ------------------------------------------------------------- AUDIT
  app.register({
    name: 'AUDIT',
    title: '감사',
    async run(ctx) {
      const st = app.active!;
      const fix = (await askKeyword(
        ctx,
        '검출된 오류를 수정하시겠습니까? [예(Y)/아니오(N)] <N>:',
        [
          { key: 'Y', label: '예' },
          { key: 'N', label: '아니오' },
        ],
        'N',
      )) === 'Y';
      const rep = auditDocument(st.doc);
      let shown = 0;
      for (const ph of AUDIT_PHASES) {
        ctx.print(ph.label);
        for (const i of rep.issues.filter((x) => x.phase === ph.phase)) {
          if (shown++ >= 200) continue;
          ctx.print(`  ${i.target}  ${i.message}  ${fix ? `→ ${i.fix}` : '수정 안 함'}`, 'err');
        }
      }
      if (shown > 200) ctx.print(`  … 외 ${shown - 200}개`);
      let fixed = 0;
      let erased = 0;
      if (fix && rep.issues.length) {
        const r = rep.fix(() => st.session.newHandle());
        if (r.ops.length) st.session.commit({ label: 'AUDIT', ops: r.ops, group: ctx.group });
        fixed = rep.issues.length;
        erased = r.erased;
      }
      ctx.print(`총 ${rep.issues.length}개 오류 발견, ${fixed}개 수정됨`, 'res');
      ctx.print(`${erased}개 객체 삭제됨`, 'res');
    },
  });

  // ------------------------------------------------------------- STATUS
  app.register({
    name: 'STATUS',
    title: '도면 상태',
    run(ctx) {
      const st = app.active!;
      const d = st.doc;
      const L = (v: number) => formatLength(v, st.units).padStart(12);
      const out = (s: string) => ctx.print(s, 'res');
      const stats = docStats(d);
      const isModel = st.space === MODEL_SPACE;
      const layout = st.layoutFor(st.space);
      out(`${st.saveName} — ${d.format.toUpperCase()} ${d.version}`);
      out(`도면에 있는 객체 ${stats.total}개 (${stats.bySpace.map((s) => `${s.name} ${s.count}`).join(', ')})`);
      const lmin = isModel ? v2of(d.header.get('$LIMMIN'), { x: 0, y: 0 }) : (layout?.limitsMin ?? v2of(d.header.get('$PLIMMIN'), { x: 0, y: 0 }));
      const lmax = isModel ? v2of(d.header.get('$LIMMAX'), { x: 420, y: 297 }) : (layout?.limitsMax ?? v2of(d.header.get('$PLIMMAX'), { x: 420, y: 297 }));
      const limOn = Number(d.header.get(isModel ? '$LIMCHECK' : '$PLIMCHECK') ?? 0) === 1;
      const spaceName = isModel ? '모형 공간' : '도면 공간';
      out(`${padWide(`${spaceName} 한계`, 16)} X:${L(lmin.x)}  Y:${L(lmin.y)}  (${limOn ? '켜기' : '끄기'})`);
      out(`${padWide('', 16)} X:${L(lmax.x)}  Y:${L(lmax.y)}`);
      const b = st.scenes.get(st.space)?.bounds;
      if (b) {
        const over = limOn && (b.minX < lmin.x || b.minY < lmin.y || b.maxX > lmax.x || b.maxY > lmax.y);
        out(`${padWide(`${spaceName} 사용`, 16)} X:${L(b.minX)}  Y:${L(b.minY)}${over ? '  **한계 초과' : ''}`);
        out(`${padWide('', 16)} X:${L(b.maxX)}  Y:${L(b.maxY)}`);
      } else out(`${padWide(`${spaceName} 사용`, 16)} *없음*`);
      const a = app.view.screenToWorld(0, app.view.height);
      const c = app.view.screenToWorld(app.view.width, 0);
      out(`${padWide('화면 표시', 16)} X:${L(a.x)}  Y:${L(a.y)}`);
      out(`${padWide('', 16)} X:${L(c.x)}  Y:${L(c.y)}`);
      const ib = d.header.get(isModel ? '$INSBASE' : '$PINSBASE');
      const ibv = ib && typeof ib === 'object' ? (ib as { x: number; y: number; z?: number }) : { x: 0, y: 0, z: 0 };
      out(`${padWide('삽입 기준점은', 16)} X:${L(ibv.x)}  Y:${L(ibv.y)}  Z:${L(ibv.z ?? 0)}`);
      const vp = d.vports.find((v) => v.name.toUpperCase() === '*ACTIVE');
      if (vp) {
        out(`${padWide('스냅 해상도는', 16)} X:${L(vp.snapSpacing.x)}  Y:${L(vp.snapSpacing.y)}`);
        out(`${padWide('그리드 간격은', 16)} X:${L(vp.gridSpacing.x)}  Y:${L(vp.gridSpacing.y)}`);
      }
      out(`${padWide('현재 공간:', 16)} ${spaceName}${st.blockEdit ? ` (블록 편집기: ${st.blockEdit.name})` : ''}`);
      out(`${padWide('현재 배치:', 16)} ${layout?.name ?? 'Model'}`);
      const hs = (n: string, def: string) => {
        const v = d.header.get(n);
        return typeof v === 'string' && v ? v : def;
      };
      out(`${padWide('현재 도면층:', 16)} "${hs('$CLAYER', '0')}"`);
      const cl = d.layers.get(tableKey(hs('$CLAYER', '0')));
      const cecolor = d.header.get('$CECOLOR');
      out(`${padWide('현재 색상:', 16)} ${colorName(typeof cecolor === 'number' ? cecolor : 256)}${(typeof cecolor !== 'number' || cecolor === 256) && cl ? ` -- ${colorName(cl.color)}` : ''}`);
      const celt = hs('$CELTYPE', 'ByLayer');
      out(`${padWide('현재 선종류:', 16)} ${celt.toUpperCase()}${/^bylayer$/i.test(celt) && cl ? ` -- "${cl.linetype}"` : ''}`);
      const celw = Number(d.header.get('$CELWEIGHT') ?? -1);
      out(`${padWide('현재 선가중치:', 16)} ${celw === -1 ? 'BYLAYER' : celw === -2 ? 'BYBLOCK' : celw === -3 ? '기본값' : `${(celw / 100).toFixed(2)} mm`}`);
      out(`${padWide('현재 고도:', 16)} ${formatLength(Number(d.header.get('$ELEVATION') ?? 0), st.units)}  두께: ${formatLength(Number(d.header.get('$THICKNESS') ?? 0), st.units)}`);
      const on = (b2: boolean) => (b2 ? '켜기' : '끄기');
      out(`채우기 ${on(Number(d.header.get('$FILLMODE') ?? 1) === 1)}  직교 ${on(app.orthoOn)}  극좌표 ${on(app.polarOn)}  Qtext ${on(Number(d.header.get('$QTEXTMODE') ?? 0) === 1)}  객체 스냅 ${on(app.osnapOn)}  동적 입력 ${on(app.dynOn)}`);
      out(`${padWide('객체 스냅 모드:', 16)} ${[...app.snapModes].map((k) => SNAP_NAMES[k] ?? k).join(', ') || '없음'}`);
      out(`블록 ${stats.blocks}개, 도면층 ${stats.layers}개, 선종류 ${stats.linetypes}개, 문자 스타일 ${stats.textStyles}개, 치수 스타일 ${stats.dimStyles}개, 그룹 ${stats.groups}개`);
      const top = [...stats.byType].sort((x, y) => y[1] - x[1]).slice(0, 8);
      if (top.length) out(`객체 종류: ${top.map(([t, n]) => `${t} ${n}`).join(', ')}`);
      if (st.session.dirty) out('저장하지 않은 변경이 있습니다.');
    },
  });

  // ------------------------------------------------------------- QUICKCALC·CAL
  const QC_KEY = 'opencad.quickcalc.v1';
  const unitMm = () => {
    const u = Number(app.active?.doc.header.get('$INSUNITS') ?? 0);
    return INSUNITS_MM[u] ?? 1;
  };
  const getvar = (name: string): CalcValue | undefined => {
    const d = app.active?.doc;
    const v = d?.header.get(`$${name.toUpperCase().replace(/^\$/, '')}`);
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object') return { x: v.x, y: v.y, z: 'z' in v ? (v as { z: number }).z : 0 };
    return undefined;
  };
  const SNAP_FOR: Record<string, SnapKind | null> = { cur: null, end: 'end', mid: 'mid', cen: 'cen', int: 'int', nea: 'nea', qua: 'qua', per: 'per', ins: 'ins', nod: 'nod', tan: 'tan', app: 'app' };
  /** 점 고르기 함수의 점을 묻는다(그 스냅만 잠시 켠다) */
  const pickPoints = async (ctx: CommandContext, kinds: string[]): Promise<{ x: number; y: number }[] | null> => {
    const out: { x: number; y: number }[] = [];
    for (const k of kinds) {
      const snap = SNAP_FOR[k] ?? null;
      const prevModes = [...app.snapModes];
      const prevOn = app.osnapOn;
      if (snap) {
        app.snapModes.clear();
        app.snapModes.add(snap);
        app.osnapOn = true;
      }
      try {
        const r = await ctx.getPoint(snap ? `>> ${SNAP_NAMES[snap] ?? k} 선택:` : '>> 점 지정:');
        if (!('point' in r)) return null;
        out.push(r.point);
      } finally {
        if (snap) {
          app.snapModes.clear();
          for (const m of prevModes) app.snapModes.add(m);
          app.osnapOn = prevOn;
        }
      }
    }
    return out;
  };

  app.register({
    name: 'CAL',
    title: '계산기(명령행)',
    transparent: true,
    noDoc: true,
    async run(ctx, arg) {
      const nested = isNested(app, 'CAL');
      const text = arg?.trim() || (await askText(ctx, '>> 표현식:')).trim();
      if (!text) return;
      try {
        const expr = prepareCalc(text, getvar);
        const points = expr.picks.length ? await pickPoints(ctx, expr.picks) : [];
        if (points === null) return;
        const v = evaluateCalc(expr, { unitMm: unitMm(), points, vars: qcVars() });
        ctx.print(formatCalc(v), 'res');
        pushHistory(text, v);
        if (nested) feedPrompt(app, calcAnswer(v));
      } catch (e) {
        ctx.print(e instanceof CalcError ? `CAL: ${e.message}` : `CAL: 식을 계산하지 못했습니다(${e instanceof Error ? e.message : String(e)}).`, 'err');
      }
    },
  });

  const qcState = () => loadPref<{ history: { expr: string; result: string }[]; vars: Record<string, number> }>(QC_KEY, { history: [], vars: {} });
  const qcVars = () => new Map<string, CalcValue>(Object.entries(qcState().vars ?? {}).map(([k, v]) => [k, v]));
  const pushHistory = (expr: string, v: CalcValue) => {
    const s = qcState();
    const history = [{ expr, result: formatCalc(v) }, ...(s.history ?? []).filter((x) => x.expr !== expr)].slice(0, 50);
    savePref(QC_KEY, { ...s, history });
  };

  app.register({
    name: 'QUICKCALC',
    aliases: ['QC'],
    title: '계산기',
    transparent: true,
    noDoc: true,
    async run(ctx) {
      const nested = isNested(app, 'QUICKCALC');
      let last: CalcValue | null = null;
      const input = textInput('', '식 입력 — 예: (12+3)*2, sin(30), 25mm+1in, dist([0,0],[3,4])');
      input.style.width = '100%';
      const result = h('div', { class: 'u2-result' }, '0');
      const err = h('div', { class: 'u2-err' });
      const hist = listBox([], null, (v) => {
        input.value = v;
        input.focus();
      });
      const renderHist = () => hist.set((qcState().history ?? []).map((x) => ({ value: x.expr, label: `${x.expr} = ${x.result}` })), null);
      const run = () => {
        err.textContent = '';
        const t = input.value.trim();
        if (!t) return;
        try {
          const v = calculate(t, { unitMm: unitMm(), vars: qcVars(), getvar });
          last = v;
          result.textContent = formatCalc(v);
          pushHistory(t, v);
          renderHist();
        } catch (e) {
          err.textContent = e instanceof CalcError ? e.message : '식을 계산하지 못했습니다.';
        }
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ev.stopPropagation();
          run();
        }
      });
      const ins = (s: string) => () => {
        const a = input.selectionStart ?? input.value.length;
        const b = input.selectionEnd ?? a;
        input.value = input.value.slice(0, a) + s + input.value.slice(b);
        input.focus();
        input.setSelectionRange(a + s.length, a + s.length);
      };
      const keys = ['sin(', 'cos(', 'tan(', 'sqrt(', '^', 'pi', 'asin(', 'acos(', 'atan(', 'abs(', '(', ')', 'r2d(', 'd2r(', 'ln(', 'log(', '[', ']'].map((k) => button(k, ins(k)));
      // 단위 변환
      const units = Object.keys(LENGTH_UNITS).filter((u) => /^[a-z]{1,2}$/.test(u));
      const uFrom = select(units.map((u) => ({ value: u, label: u })), 'mm');
      const uTo = select(units.map((u) => ({ value: u, label: u })), 'in');
      const uVal = textInput('1');
      const uOut = h('span', { class: 'u2-note' });
      const conv = () => {
        const v = Number(uVal.value);
        uOut.textContent = Number.isFinite(v) ? `= ${formatCalc((v * LENGTH_UNITS[uFrom.value]!) / LENGTH_UNITS[uTo.value]!)} ${uTo.value}` : '';
      };
      for (const el of [uFrom, uTo]) el.addEventListener('change', conv);
      uVal.addEventListener('input', conv);
      conv();
      // 변수
      const varName = textInput('', '변수 이름');
      varName.style.width = '110px';
      const saveVar = button('결과를 변수로 저장', () => {
        const n = varName.value.trim();
        if (!/^[A-Za-z_][\w]*$/.test(n) || last === null || typeof last !== 'number') {
          err.textContent = '수 결과와 영문 변수 이름이 필요합니다.';
          return;
        }
        const s = qcState();
        savePref(QC_KEY, { ...s, vars: { ...(s.vars ?? {}), [n]: last } });
        err.textContent = '';
        ctx.print(`QuickCalc 변수 ${n} = ${formatCalc(last)}`);
      });
      renderHist();
      const body = h(
        'div',
        {},
        input,
        h('div', { style: 'height:6px' }),
        result,
        err,
        h('div', { class: 'u2-keys' }, ...keys),
        h('fieldset', { style: 'margin-top:8px' }, h('legend', {}, '기록'), hist.el),
        h('fieldset', {}, h('legend', {}, '단위 변환(길이)'), h('div', { class: 'u2-row' }, uVal, uFrom, h('span', {}, '→'), uTo, uOut)),
        h('div', { class: 'u2-row' }, varName, saveVar, h('span', { class: 'u2-note' }, `변수: ${Object.keys(qcState().vars ?? {}).join(', ') || '없음'}`)),
        h('div', { class: 'u2-note' }, '삼각 함수는 도 단위, 단위 붙은 수(25mm, 2ft)는 도면 단위로 바뀝니다.'),
      );
      const m = modal<'apply' | 'close'>(
        'QuickCalc',
        body,
        [
          { label: '기록 지우기', value: () => (savePref(QC_KEY, { ...qcState(), history: [] }), renderHist(), undefined) },
          { label: '=', value: () => (run(), undefined) },
          ...(nested ? [{ label: '적용', primary: true, value: () => (run(), last === null ? undefined : ('apply' as const)) }] : [{ label: '닫기', primary: true, value: 'close' as const }]),
        ],
        'mid',
      );
      setTimeout(() => input.focus());
      const r = await m.done;
      if (r === 'apply' && last !== null) feedPrompt(app, calcAnswer(last));
      else if (last !== null) ctx.print(`QuickCalc: ${formatCalc(last)}`);
    },
  });

  // ------------------------------------------------------------- LIMITS
  app.register({
    name: 'LIMITS',
    title: '도면 한계',
    transparent: true,
    async run(ctx) {
      const st = app.active!;
      const d = st.doc;
      const isModel = st.space === MODEL_SPACE;
      const layout = st.layoutFor(st.space);
      const kMin = isModel ? '$LIMMIN' : '$PLIMMIN';
      const kMax = isModel ? '$LIMMAX' : '$PLIMMAX';
      const kChk = isModel ? '$LIMCHECK' : '$PLIMCHECK';
      const curMin = isModel ? v2of(d.header.get(kMin), { x: 0, y: 0 }) : (layout?.limitsMin ?? v2of(d.header.get(kMin), { x: 0, y: 0 }));
      const curMax = isModel ? v2of(d.header.get(kMax), { x: 420, y: 297 }) : (layout?.limitsMax ?? v2of(d.header.get(kMax), { x: 420, y: 297 }));
      const P = (p: Vec2) => `${formatLength(p.x, st.units)},${formatLength(p.y, st.units)}`;
      ctx.print(isModel ? '모형 공간 한계 재설정:' : '도면 공간 한계 재설정:');
      const r = await ctx.getPoint(`왼쪽 아래 구석 지정 또는 [켜기(ON)/끄기(OFF)] <${P(curMin)}>:`, {
        keywords: [
          { key: 'ON', label: '켜기' },
          { key: 'OFF', label: '끄기' },
        ],
      });
      const ops: EditOp[] = [];
      const setH = (name: string, after: HeaderValue) => {
        const before = d.header.get(name);
        if (JSON.stringify(before) !== JSON.stringify(after)) ops.push({ kind: 'header', name, before, after });
      };
      if ('keyword' in r) {
        setH(kChk, r.keyword === 'ON' ? 1 : 0);
        if (ops.length) st.session.commit({ label: 'LIMITS', ops, group: ctx.group });
        return;
      }
      const lo = 'point' in r ? { x: r.point.x, y: r.point.y } : curMin;
      const r2 = await ctx.getPoint(`오른쪽 위 구석 지정 <${P(curMax)}>:`, { base: lo, rubber: (p) => [{ pts: [lo.x, lo.y, p.x, lo.y, p.x, p.y, lo.x, p.y], closed: true, dashed: true }] });
      const hi = 'point' in r2 ? { x: r2.point.x, y: r2.point.y } : curMax;
      if (!(hi.x > lo.x && hi.y > lo.y)) {
        ctx.print('**한계가 잘못되었습니다.', 'err');
        return;
      }
      setH(kMin, lo);
      setH(kMax, hi);
      if (!isModel && layout) {
        const after = { ...layout, limitsMin: lo, limitsMax: hi };
        if (JSON.stringify(after) !== JSON.stringify(layout)) ops.push({ kind: 'layout', key: tableKey(layout.blockName), before: layout, after });
      }
      if (ops.length) st.session.commit({ label: 'LIMITS', ops, group: ctx.group });
    },
  });

  // ------------------------------------------------------------- MULTIPLE
  app.register({
    name: 'MULTIPLE',
    title: '명령 반복',
    async run(ctx, arg) {
      const name = arg?.trim() || (await askText(ctx, '반복할 명령 이름 입력:')).trim();
      if (!name) return;
      const c = app.findCommand(name);
      if (!c) {
        ctx.print(`알 수 없는 명령 "${name}".`, 'err');
        return;
      }
      if (c.name === 'MULTIPLE') return;
      let stop = false;
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') stop = true;
      };
      window.addEventListener('keydown', onKey, true);
      const doc = app.active;
      const lastLine = () => app.cmd.el.querySelector('.cmd-history')?.lastElementChild?.textContent ?? '';
      let quick = 0;
      try {
        for (let n = 0; n < 10000 && !stop; n++) {
          const t0 = performance.now();
          await app.run(c.name);
          if (stop || app.active !== doc || app.busyCommand || lastLine() === '*취소*') break;
          // 입력을 기다리지 않고 끝나는 명령은 한없이 돌지 않게 한다
          if (performance.now() - t0 < 120) {
            if (++quick >= 2) {
              app.cmd.print(`${c.name}은(는) 입력 없이 끝나는 명령이라 반복을 멈춥니다.`);
              break;
            }
          } else quick = 0;
        }
      } finally {
        window.removeEventListener('keydown', onKey, true);
      }
    },
  });

  // ------------------------------------------------------------- REDRAW
  app.register({
    name: 'REDRAW',
    aliases: ['R', 'REDRAWALL', 'RA'],
    title: '다시 그리기',
    transparent: true,
    run() {
      const o = app.view.overlay;
      o.marks = [];
      o.hover = null;
      app.refreshSelectionOverlay();
      app.view.requestRender();
      app.view.requestOverlay();
    },
  });
}

