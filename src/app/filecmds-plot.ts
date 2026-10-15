/**
 * 플롯 스타일 명령: PLOTSTYLE(객체의 이름 있는 플롯 스타일), CONVERTCTB(CTB → STB 내려받기),
 * CONVERTPSTYLES(도면을 색상 종속 ↔ 이름 있는 플롯 스타일로). PLOTSTAMP는 filecmds-stamp.ts.
 */
import { ctbToStb, ctbTextFromPens, packPia, standardCtbPens, STANDARD_CTBS, unpackPia } from '../edit/filecmds/pia';
import { assignPlotStyleOps, convertToColorOps, convertToNamedOps, isNamedPlotStyleDoc, plotStyleNameList, plotStyleNameOf } from '../edit/filecmds/pstyles';
import { readCtb } from '../render/ctb';
import type { App, Command } from './app';
import { addCtb, ctbByName, ctbList, pickCtbFiles } from './ctblib';
import type { DocState } from './docstate';
import { pickFiles } from './drawingfiles';
import { download } from './export';
import { registerPlotStampCommand } from './filecmds-stamp';
import { ask, form } from './ui/dom';

/** 지금 공간(모형 또는 배치)의 플롯 스타일 표 이름 */
function currentSheet(st: DocState): string {
  return st.layoutFor(st.displaySpace)?.plot.styleSheet ?? '';
}

/** 고를 수 있는 플롯 스타일 이름: 도면 사전의 이름, 붙인 STB의 이름(불러온 경우) */
function availableStyles(st: DocState): string[] {
  const out = new Map<string, string>();
  for (const n of plotStyleNameList(st.doc)) out.set(n.toUpperCase(), n);
  const stb = ctbByName(currentSheet(st));
  for (const [n] of stb?.named ?? []) if (!out.has(n)) out.set(n, n.charAt(0) + n.slice(1).toLowerCase());
  if (!out.has('NORMAL')) out.set('NORMAL', 'Normal');
  return [...out.values()];
}

export function registerFilePlotCommands(app: App, reg: (c: Command) => void): void {
  registerPlotStampCommand(app, reg);

  reg({
    name: 'PLOTSTYLE',
    title: '플롯 스타일 지정',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      if (!isNamedPlotStyleDoc(doc)) {
        ctx.print('현재 도면은 색상 종속 플롯 스타일 모드입니다. 객체에는 이름 있는 플롯 스타일 도면에서만 플롯 스타일을 지정할 수 있습니다. CONVERTPSTYLES로 도면을 변환하십시오.', 'err');
        return;
      }
      const handles = await ctx.getSelection('객체 선택:');
      if (!handles.length) return;
      const names = availableStyles(st);
      // 고른 객체들이 모두 같은 플롯 스타일이면 그것을 기본으로
      const curNames = new Set(handles.map((h) => plotStyleNameOf(doc, doc.entityIndex.get(h)?.plotStyle) ?? 'ByLayer'));
      const cur = curNames.size === 1 ? [...curNames][0]! : 'ByLayer';
      const sheet = currentSheet(st);
      const v = await form(
        '플롯 스타일 선택',
        [
          { key: 'name', label: '플롯 스타일', type: 'select', value: names.find((n) => n.toUpperCase() === cur.toUpperCase()) ?? 'ByLayer', options: ['ByLayer', ...names].map((n) => ({ value: n, label: n })) },
          { key: 'other', label: '다른 이름(목록에 없으면)', type: 'text', value: '' },
        ],
        {
          ok: '확인',
          note: `원래 값: ${curNames.size === 1 ? cur : '*여러 값*'} · 활성 플롯 스타일 테이블: ${sheet || '없음'}${sheet && !ctbByName(sheet) ? '(불러오지 않음 — PLOT에서 STB 파일을 불러오면 목록에 나옵니다)' : ''}`,
          validate: (x) => (/[<>/\\":;?*|,=`]/.test(String(x.other)) ? '이름에 쓸 수 없는 문자가 있습니다.' : null),
        },
      );
      if (!v) return;
      const name = String(v.other).trim() || String(v.name);
      const r = assignPlotStyleOps(doc, handles, name, () => st.session.newHandle(), (h) => st.session.ownerOf(h));
      if (!r) {
        ctx.print('이 도면에는 플롯 스타일 이름 사전(ACAD_PLOTSTYLENAME)이 없습니다.', 'err');
        return;
      }
      if (r.ops.length) st.session.commit({ label: 'PLOTSTYLE', ops: r.ops, group: ctx.group });
      ctx.print(`객체 ${r.changed}개의 플롯 스타일을 "${name}"(으)로 지정했습니다.`);
    },
  });

  reg({
    name: 'CONVERTCTB',
    title: 'CTB를 STB로 변환',
    noDoc: true,
    async run(ctx) {
      const loaded = ctbList().filter((t) => !t.named);
      const v = await form(
        '색상 종속 플롯 스타일 테이블 변환',
        [
          {
            key: 'src',
            label: '변환할 CTB',
            type: 'select',
            value: 'file',
            options: [
              { value: 'file', label: 'CTB 파일 고르기…' },
              ...STANDARD_CTBS.map((n) => ({ value: `std:${n}`, label: `${n} (기본 표)` })),
              ...loaded.map((t) => ({ value: `ctb:${t.name}`, label: `${t.name} (불러온 표)` })),
            ],
          },
          { key: 'name', label: '새 STB 이름(비우면 같은 이름)', type: 'text', value: '' },
        ],
        { ok: '변환', note: '각 색(ACI 1~255)의 펜 설정을 Color_1 ~ Color_255 이름의 플롯 스타일로 옮기고 Normal을 더합니다. 파일은 이 컴퓨터에서 만들어 내려받습니다.' },
      );
      if (!v) return;
      const src = String(v.src);
      let text: string;
      let srcName: string;
      if (src === 'file') {
        const [f] = await pickFiles('.ctb,.CTB', false);
        if (!f) return;
        if (f.size > 4 * 1024 * 1024) {
          ctx.print(`${f.name}: 너무 큰 파일입니다.`, 'err');
          return;
        }
        const r = await unpackPia(new Uint8Array(await f.arrayBuffer()));
        if (!r || r.kind !== 'CTB') {
          ctx.print(`${f.name}은(는) 색상 종속 플롯 스타일 테이블(CTB) 파일이 아닙니다.`, 'err');
          return;
        }
        text = r.text;
        srcName = f.name;
      } else if (src.startsWith('std:')) {
        srcName = src.slice(4);
        text = ctbTextFromPens(standardCtbPens(srcName)!);
      } else {
        const t = ctbByName(src.slice(4));
        if (!t) return;
        srcName = t.name;
        text = ctbTextFromPens(t.pens);
      }
      let stb: string;
      try {
        stb = ctbToStb(text);
      } catch (e) {
        ctx.print(`변환하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
        return;
      }
      const data = await packPia(stb, 'STB');
      const want = String(v.name).trim().replace(/\.stb$/i, '');
      const name = `${want || srcName.replace(/\.ctb$/i, '')}.stb`;
      download(new Blob([data], { type: 'application/octet-stream' }), name);
      // 바로 플롯·CONVERTPSTYLES에서 쓸 수 있게 불러 둔다
      const table = await readCtb(data, name);
      if (table) addCtb(table);
      ctx.print(`색상 종속 플롯 스타일 테이블 ${srcName}을(를) 이름 있는 플롯 스타일 테이블 ${name}(으)로 변환했습니다(Normal, Color_1~Color_255).`);
    },
  });

  reg({
    name: 'CONVERTPSTYLES',
    title: '플롯 스타일 모드 변환',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const sheet = currentSheet(st);
      if (isNamedPlotStyleDoc(doc)) {
        const a = await ask('플롯 스타일 변환', '도면을 색상 종속 플롯 스타일로 변환하면 도면층과 객체에 지정한 이름 있는 플롯 스타일이 모두 제거됩니다. 계속하시겠습니까?', [
          { label: '확인', value: 'ok', primary: true },
          { label: '취소', value: 'cancel' },
        ]);
        if (a !== 'ok') return;
        const same = sheet ? sheet.replace(/\.stb$/i, '.ctb') : '';
        const v = await form('색상 종속 플롯 스타일 테이블', [
          {
            key: 'ctb',
            label: '배치에 붙일 CTB',
            type: 'select',
            value: '',
            options: [
              { value: '', label: same ? `같은 이름(${same})` : '없음(배치 설정 그대로)' },
              ...[...new Set([...STANDARD_CTBS, ...ctbList().filter((t) => !t.named).map((t) => t.name)])].map((n) => ({ value: n, label: n })),
            ],
          },
        ]);
        if (!v) return;
        const r = convertToColorOps(doc, String(v.ctb) || undefined);
        st.session.commit({ label: 'CONVERTPSTYLES', ops: r.ops, group: ctx.group });
        ctx.print(`도면이 이름 있는 플롯 스타일 모드에서 색상 종속 모드로 변환되었습니다(도면층 ${r.layers}개, 객체 ${r.entities}개, 배치 ${r.layouts}개).`);
        return;
      }
      const a = await ask(
        '플롯 스타일 변환',
        '도면을 이름 있는 플롯 스타일로 변환합니다. 도면층과 색을 직접 지정한 객체에는 그 색의 플롯 스타일(Color_1 등)이 지정됩니다. 출력 모양을 유지하려면 먼저 CONVERTCTB로 이 도면의 CTB를 STB로 변환해 두십시오. 계속하시겠습니까?',
        [
          { label: '확인', value: 'ok', primary: true },
          { label: '취소', value: 'cancel' },
        ],
      );
      if (a !== 'ok') return;
      const same = sheet ? sheet.replace(/\.ctb$/i, '.stb') : '';
      const v = await form('이름 있는 플롯 스타일 테이블 선택', [
        {
          key: 'stb',
          label: '배치에 붙일 STB',
          type: 'select',
          value: ctbByName(same)?.named ? same : '',
          options: [
            { value: '', label: same ? `같은 이름(${same})` : '없음(배치 설정 그대로)' },
            ...ctbList()
              .filter((t) => t.named)
              .map((t) => ({ value: t.name, label: `${t.name} (불러온 표)` })),
            { value: 'load', label: 'STB 파일 불러오기…' },
          ],
        },
      ]);
      if (!v) return;
      let stb = String(v.stb);
      if (stb === 'load') {
        const got = (await pickCtbFiles()).filter((t) => t.named);
        if (!got.length) {
          ctx.print('이름 있는 플롯 스타일 테이블(STB)을 읽지 못했습니다.', 'err');
          return;
        }
        stb = got[0]!.name;
      }
      const r = convertToNamedOps(doc, () => st.session.newHandle(), stb || undefined);
      if (!r) {
        ctx.print('이 도면에는 플롯 스타일 이름 사전(ACAD_PLOTSTYLENAME)이 없어 변환할 수 없습니다.', 'err');
        return;
      }
      st.session.commit({ label: 'CONVERTPSTYLES', ops: r.ops, group: ctx.group });
      ctx.print(`도면이 색상 종속 모드에서 이름 있는 플롯 스타일 모드로 변환되었습니다(도면층 ${r.layers}개, 객체 ${r.entities}개, 배치 ${r.layouts}개).`);
    },
  });
}
