/**
 * 명령행 도면층 -LAYER(스크립트용): `현재 도면층: "0"` → `옵션 입력 [?/만들기(M)/설정(S)/…/조정(E)]:`을 Enter까지 되풀이한다.
 * 이름 리스트는 쉼표로 나누고 와일드카드(*, ?, #, @, ., [...], ~)를 받는다. 옵션 하나가 명령 취소 한 단계다.
 * 재료(MAT)는 3D 렌더링 특성이라 안내만 하고, 상태(A)는 이 웹 버전에 도면층 상태 기능이 아직 없어 안내만 한다.
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 값 해석은 src/edit/layercmd.
 */
import type { CadColor, Layer } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import {
  DASH_LAYER_OPTIONS,
  dashLayerPrompt,
  layerColorText,
  layerStateText,
  lineweightText,
  matchNameList,
  opacityFromPercent,
  parseLayerColor,
  parseLineweight,
  parseTransparency,
  parseTrueColor,
  percentFromOpacity,
  resolveDashLayerOption,
  splitNameList,
  unquote,
} from '../edit/layercmd';
import type { App, CommandContext, Keyword } from './app';
import { currentLayer, renameLayer, setCurrentLayer, validLayerName } from './layers';
import { askText, padWide } from './util2-ui';

const OPTION_KEYWORDS: Keyword[] = DASH_LAYER_OPTIONS.map((o) => ({ key: o.key, label: o.label }));

/** 글 입력(공백은 Enter — 스크립트와 같다). Enter면 null. 점으로 해석된 입력은 `x,y` 글로 돌린다 */
async function askWord(ctx: CommandContext, prompt: string): Promise<string | null> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { allowText: true, preferNumber: true });
    if ('text' in r) return r.text.trim();
    if ('enter' in r) return null;
    if ('point' in r) return `${+r.point.x.toPrecision(12)},${+r.point.y.toPrecision(12)}`;
    if ('keyword' in r) return r.keyword;
  }
}

export function registerDashLayerCommand(app: App): void {
  app.register({
    name: '-LAYER',
    aliases: ['-LA'],
    title: '도면층(명령행)',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const layerNames = () => [...doc.layers.values()].map((l) => l.name);
      const cur = () => currentLayer(app);
      /** 도면층 표 고치기(한 옵션 = 명령 취소 한 단계) */
      const commitLayers = (label: string, changes: [Layer, Partial<Layer>][]): number => {
        const ops: EditOp[] = [];
        for (const [before, patch] of changes) {
          const after: Layer = { ...structuredClone(before), ...structuredClone(patch) };
          if (JSON.stringify(after) === JSON.stringify(before)) continue;
          ops.push({ kind: 'layer', key: tableKey(before.name), before, after });
        }
        if (ops.length) st.session.commit({ label, ops });
        return ops.length;
      };
      /** 이름 리스트 → 도면층(맞지 않는 패턴은 알린다) */
      const layersOf = (list: string): Layer[] => {
        const m = matchNameList(layerNames(), list);
        if (m.unmatched.length) ctx.print(`일치하는 도면층 이름을 찾지 못함: ${m.unmatched.join(', ')}`);
        return m.names.map((n) => doc.layers.get(tableKey(n))!).filter(Boolean);
      };
      /** 고른 객체의 도면층 */
      const pickLayers = async (): Promise<Layer[]> => {
        const hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
        app.clearSelection();
        const keys = new Set<string>();
        for (const h of hs) {
          const e = doc.entityIndex.get(h);
          if (e) keys.add(tableKey(e.layer));
        }
        return [...keys].map((k) => doc.layers.get(k)).filter((l): l is Layer => !!l);
      };
      /** `…의 이름 리스트 입력 [또는 <객체 선택>] [<현재>]` */
      const askLayers = async (prompt: string, opt: { select?: boolean; current?: boolean } = {}): Promise<Layer[]> => {
        const tail = opt.select ? ' 또는 <객체 선택>' : opt.current ? ` <${cur()}>` : '';
        const t = await askWord(ctx, `${prompt}${tail}:`);
        if (t === null) {
          if (opt.select) return pickLayers();
          if (opt.current) return layersOf(cur());
          return [];
        }
        return layersOf(t);
      };

      ctx.print(`현재 도면층: "${cur()}"`);
      for (;;) {
        const r = await ctx.getPoint(dashLayerPrompt(), { keywords: OPTION_KEYWORDS, allowText: true });
        if ('enter' in r) return;
        if ('point' in r) continue;
        const key = 'keyword' in r ? r.keyword : resolveDashLayerOption(r.text);
        if (!key) {
          ctx.print('옵션 키워드가 잘못되었습니다.', 'err');
          continue;
        }
        switch (key) {
          case '?': {
            const t = (await askWord(ctx, '나열할 도면층 이름(들) 입력 <*>:')) ?? '*';
            const list = matchNameList(layerNames(), t || '*').names.map((n) => doc.layers.get(tableKey(n))!);
            const rows = list
              .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
              .map((l) => [`"${l.name}"`, layerStateText(l), layerColorText(l.color), l.linetype || 'Continuous', lineweightText(l.lineweight), String(percentFromOpacity(l.transparency ?? 255)), l.plot ? '플롯' : '플롯 안 함', l.description ?? '']);
            const head = ['도면층 이름', '상태', '색상', '선종류', '선가중치', '투명도', '플롯', '설명'];
            const widths = head.map((h, i) => Math.min(32, Math.max(h.length * 2, ...rows.map((x) => x[i]!.length + 2))));
            ctx.print(head.map((h, i) => padWide(h, widths[i]!)).join(' '));
            for (const x of rows) ctx.print(x.map((v, i) => padWide(v, widths[i]!)).join(' '));
            ctx.print(`현재 도면층: "${cur()}"`);
            break;
          }
          case 'M': {
            const t = await askWord(ctx, `새 도면층에 대한 이름 입력 (현재 도면층으로 함 ) <${cur()}>:`);
            const name = unquote(t ?? cur());
            if (!name) break;
            const key0 = tableKey(name);
            const existing = doc.layers.get(key0);
            if (!existing) {
              const err = validLayerName(name);
              if (err) {
                ctx.print(`"${name}"은(는) 유효하지 않은 도면층 이름임.`, 'err');
                break;
              }
              // 새 도면층과 현재 도면층 바꾸기를 한 단계로
              const layer = newLayer(st.session.newHandle(), name);
              const before = doc.header.get('$CLAYER');
              st.session.commit({
                label: '-LAYER',
                ops: [
                  { kind: 'layer', key: key0, before: null, after: layer },
                  { kind: 'header', name: '$CLAYER', before, after: layer.name },
                ],
              });
            } else if (existing.frozen) ctx.print(`동결된 도면층 "${existing.name}"은(는) 현재 도면층으로 만들 수 없습니다.`, 'err');
            else setCurrentLayer(app, existing.name);
            break;
          }
          case 'S': {
            const t = await askWord(ctx, '현재로 만들 도면층 이름 입력 또는 <객체 선택>:');
            let name: string | null = t === null ? null : unquote(t);
            if (name === null) {
              const e = await ctx.getEntity('객체 선택:');
              if (!('handle' in e)) break;
              name = doc.entityIndex.get(e.handle)?.layer ?? null;
              if (!name) break;
            }
            const l = doc.layers.get(tableKey(name));
            if (!l) ctx.print(`도면층 "${name}"을(를) 찾을 수 없습니다.`, 'err');
            else setCurrentLayer(app, l.name);
            break;
          }
          case 'N': {
            const t = await askWord(ctx, '새 도면층(들)에 대한 이름 리스트 입력:');
            if (!t) break;
            const ops: EditOp[] = [];
            const made = new Set<string>();
            for (const n of splitNameList(t)) {
              if (validLayerName(n)) {
                ctx.print(`"${n}"은(는) 유효하지 않은 도면층 이름임.`, 'err');
                continue;
              }
              const k = tableKey(n);
              if (doc.layers.has(k) || made.has(k)) continue;
              made.add(k);
              ops.push({ kind: 'layer', key: k, before: null, after: newLayer(st.session.newHandle(), n) });
            }
            if (ops.length) st.session.commit({ label: '-LAYER', ops });
            break;
          }
          case 'R': {
            const a = await askWord(ctx, '이전 도면층 이름 입력:');
            if (!a) break;
            const l = doc.layers.get(tableKey(unquote(a)));
            if (!l) {
              ctx.print(`도면층 "${unquote(a)}"을(를) 찾을 수 없습니다.`, 'err');
              break;
            }
            const b = await askWord(ctx, '새 도면층 이름 입력:');
            if (!b) break;
            renameLayer(app, tableKey(l.name), unquote(b));
            break;
          }
          case 'ON': {
            const ls = await askLayers('켤 도면층의 이름 리스트 입력');
            commitLayers('-LAYER', ls.map((l) => [l, { off: false }]));
            break;
          }
          case 'OFF': {
            const ls = await askLayers('끌 도면층의 이름 리스트 입력', { select: true });
            const out: Layer[] = [];
            for (const l of ls) {
              if (tableKey(l.name) === tableKey(cur()) && !l.off) {
                const r2 = await ctx.getPoint(`현재 도면층 "${l.name}"을(를) 끄시겠습니까? [예(Y)/아니오(N)] <아니오(N)>:`, {
                  keywords: [
                    { key: 'Y', label: '예' },
                    { key: 'N', label: '아니오' },
                  ],
                });
                if (!('keyword' in r2) || r2.keyword !== 'Y') continue;
              }
              out.push(l);
            }
            commitLayers('-LAYER', out.map((l) => [l, { off: true }]));
            break;
          }
          case 'C': {
            let color: CadColor | null = null;
            let off = false;
            while (!color) {
              const t = await askWord(ctx, '색상 이름 또는 번호(1-255) 입력 또는 [트루컬러(T)/색상표(CO)]:');
              if (t === null) break;
              const up = t.toUpperCase();
              if (up === 'T' || up === '트루컬러') {
                const tc = await askWord(ctx, '트루컬러 입력(빨간색,초록색,파란색):');
                if (tc === null) break;
                color = parseTrueColor(tc);
                if (!color) ctx.print('0에서 255 사이의 세 값을 쉼표로 입력하십시오.', 'err');
                continue;
              }
              if (up === 'CO' || up === '색상표') {
                ctx.print('색상표 색은 이 웹 버전에서 쓸 수 없습니다. 색상 번호나 트루컬러를 입력하십시오.', 'err');
                continue;
              }
              const c = parseLayerColor(t);
              if (!c) {
                ctx.print('1에서 255 사이의 색상 번호나 색상 이름을 입력하십시오.', 'err');
                continue;
              }
              color = c.color;
              off = c.off;
            }
            if (!color) break;
            const ls = await askLayers(`색상 ${layerColorText(color)}에 대한 도면층의 이름 리스트 입력`, { current: true });
            commitLayers('-LAYER', ls.map((l) => [l, off ? { color, off: true } : { color }]));
            break;
          }
          case 'L': {
            let lt: string | null = null;
            for (;;) {
              const t = await askWord(ctx, '로드된 선종류 이름 입력 또는 [?] <Continuous>:');
              const n = t === null ? 'Continuous' : unquote(t);
              if (n === '?') {
                const list = [...doc.linetypes.values()].map((x) => x.name);
                ctx.print(list.length ? `로드된 선종류: ${list.join(', ')}` : '로드된 선종류: Continuous');
                continue;
              }
              const found = doc.linetypes.get(tableKey(n));
              if (!found && tableKey(n) !== 'CONTINUOUS') {
                ctx.print(`선종류 ${n}을(를) 찾을 수 없습니다. LINETYPE 명령으로 로드하십시오.`, 'err');
                continue;
              }
              lt = found?.name ?? 'Continuous';
              break;
            }
            const ls = await askLayers(`선종류 "${lt}"에 대한 도면층의 이름 리스트 입력`, { current: true });
            commitLayers('-LAYER', ls.map((l) => [l, { linetype: lt! }]));
            break;
          }
          case 'LW': {
            let lw: number | null = null;
            while (lw === null) {
              const t = await askWord(ctx, '선가중치 입력 (0.0mm - 2.11mm):');
              if (t === null) break;
              lw = parseLineweight(t);
              if (lw === null) ctx.print('0.0mm에서 2.11mm 사이의 선가중치를 입력하십시오.', 'err');
            }
            if (lw === null) break;
            const v = lw;
            const ls = await askLayers(`선가중치 ${lineweightText(v)}에 대한 도면층의 이름 리스트 입력`, { current: true });
            commitLayers('-LAYER', ls.map((l) => [l, { lineweight: v }]));
            break;
          }
          case 'TR': {
            let pct: number | null = null;
            while (pct === null) {
              const t = await askWord(ctx, '투명도 값 입력 (0-90):');
              if (t === null) break;
              pct = parseTransparency(t);
              if (pct === null) ctx.print('0에서 90 사이의 값을 입력하십시오.', 'err');
            }
            if (pct === null) break;
            const v = opacityFromPercent(pct);
            const ls = await askLayers(`투명도 ${pct}%에 대한 도면층의 이름 리스트 입력`, { current: true });
            commitLayers('-LAYER', ls.map((l) => [l, { transparency: v }]));
            break;
          }
          case 'MAT': {
            await askWord(ctx, '재료 이름 입력 또는 [?] <GLOBAL>:');
            ctx.print('재료는 3D 렌더링 특성이라 이 2D 웹 버전에서는 도면층에 지정하지 않습니다.');
            break;
          }
          case 'P': {
            const p = await ctx.getPoint('플롯 기본 설정 입력 [플롯(P)/플롯 안 함(N)] <플롯>:', {
              keywords: [
                { key: 'P', label: '플롯' },
                { key: 'N', label: '플롯 안 함' },
              ],
            });
            if (!('keyword' in p) && !('enter' in p)) break;
            const plot = !('keyword' in p) || p.keyword === 'P';
            const ls = await askLayers('이 플롯 기본 설정에 대한 도면층 이름 입력', { current: true });
            commitLayers('-LAYER', ls.map((l) => [l, { plot }]));
            break;
          }
          case 'F': {
            const ls = await askLayers('동결할 도면층의 이름 리스트 입력', { select: true });
            const ok = ls.filter((l) => {
              if (tableKey(l.name) !== tableKey(cur())) return true;
              ctx.print(`도면층 "${l.name}"을(를) 동결할 수 없습니다. 현재 도면층입니다.`, 'err');
              return false;
            });
            commitLayers('-LAYER', ok.map((l) => [l, { frozen: true }]));
            break;
          }
          case 'T': {
            const ls = await askLayers('동결해제할 도면층의 이름 리스트 입력');
            commitLayers('-LAYER', ls.map((l) => [l, { frozen: false }]));
            break;
          }
          case 'LO': {
            const ls = await askLayers('잠글 도면층의 이름 리스트 입력', { select: true });
            commitLayers('-LAYER', ls.map((l) => [l, { locked: true }]));
            break;
          }
          case 'U': {
            const ls = await askLayers('잠금해제할 도면층의 이름 리스트 입력', { select: true });
            commitLayers('-LAYER', ls.map((l) => [l, { locked: false }]));
            break;
          }
          case 'A': {
            ctx.print('도면층 상태(LAYERSTATE)는 아직 이 웹 버전에 없어 상태(A) 옵션을 쓸 수 없습니다.');
            break;
          }
          case 'D': {
            const d = await askText(ctx, '도면층 설명 입력:', '');
            const ls = await askLayers('설명을 적용할 도면층의 이름 리스트 입력', { select: true });
            commitLayers('-LAYER', ls.map((l) => [l, d ? { description: d } : { description: undefined }]));
            break;
          }
          case 'E': {
            const e = await ctx.getPoint('옵션 입력 [?/조정(R)]:', {
              keywords: [
                { key: '?', label: '?' },
                { key: 'R', label: '조정' },
              ],
            });
            if (!('keyword' in e)) break;
            if (e.keyword === '?') await askWord(ctx, '나열할 조정되지 않은 도면층 이름(들) 입력 <*>:');
            else await askWord(ctx, '조정할 도면층의 이름 리스트 입력 또는 <객체 선택>:');
            ctx.print('조정되지 않은 도면층이 없습니다(이 웹 버전은 새 도면층 알림을 기록하지 않습니다).');
            break;
          }
        }
      }
    },
  });
}

/** 새 도면층(LAYER 명령의 새 도면층과 같은 기본값) */
function newLayer(handle: string, name: string): Layer {
  return {
    name: name.trim(),
    handle,
    flags: 0,
    color: { aci: 7 },
    off: false,
    frozen: false,
    locked: false,
    linetype: 'Continuous',
    lineweight: -3,
    plot: true,
    transparency: 255,
  } as Layer;
}
