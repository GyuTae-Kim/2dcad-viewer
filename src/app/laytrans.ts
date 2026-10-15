/**
 * 도면층 변환기(LAYTRANS): 이 도면의 도면층을 다른 도면(DWG·DXF·DWS·DWT)의 도면층 또는 새로 만든 정의로 바꾼다.
 * 변환 대상은 사용자가 고른 파일에서 읽는다(파일은 이 브라우저 안에서만 읽는다).
 * 변환은 명령 취소 한 단계.
 * 매핑 저장(S)·불러오기는 AutoCAD 형식: 저장하면 변환 대상 도면층과 확장 자료 ACLAYTRANS(원본 도면층 이름)를 담은 DWS를
 * 내려받고, 그런 파일을 로드(L)하면 이 도면에 있는 원본 도면층의 매핑을 다시 채운다(src/edit/layertools/translate.ts).
 */
import type { CadDocument, Layer } from '../core/model';
import { tableKey } from '../core/model';
import { DefinitionCopier } from '../edit/layertools/clone';
import { colorLabel, lineweightLabel, transparencyLabel } from '../edit/layertools/standards';
import {
  DEFAULT_TRANSLATE_SETTINGS,
  type LayTransSaveItem,
  type LayerMapping,
  type TranslateSettings,
  cannotTranslate,
  layTransMappingDocument,
  readLayTransMappings,
  sameNameMappings,
  translateLayersOps,
  translateLog,
} from '../edit/layertools/translate';
import { filterLayerNames, layerObjectCounts, purgeLayersOps } from '../edit/layertools/walk';
import type { App } from './app';
import { pickAndReadDrawings } from './drawingfiles';
import { baseName, download } from './export';
import { currentLayer, validLayerName } from './layers';
import { type ListItem, PickList, TempLayerView, guardKeys, wideDialog } from './layertools-ui';
import { layerSwatch } from './laywalk';
import { LINEWEIGHTS } from './propedit';
import { ask, form, h, showMenu } from './ui/dom';

/** 변환 대상 정의 하나 */
interface Target {
  layer: Layer;
  /** 정의를 읽은 도면(새로 만든 것은 null) */
  source: CadDocument | null;
  from: string;
}

/** 설정은 이 세션 동안 기억한다 */
let settings: TranslateSettings & { log: boolean; show: boolean } = { ...DEFAULT_TRANSLATE_SETTINGS, log: false, show: false };

async function settingsDialog(): Promise<void> {
  const v = await form(
    '설정',
    [
      { key: 'forceColor', label: '객체 색상을 BYLAYER로 강제(C)', type: 'check', value: settings.forceColor },
      { key: 'forceLinetype', label: '객체 선종류를 BYLAYER로 강제(L)', type: 'check', value: settings.forceLinetype },
      { key: 'forceTransparency', label: '객체 투명도를 BYLAYER로 강제(T)', type: 'check', value: settings.forceTransparency },
      { key: 'blocks', label: '블록의 객체 변환(B)', type: 'check', value: settings.blocks },
      { key: 'purge', label: '변환한 원본 도면층 삭제(P)', type: 'check', value: settings.purge },
      { key: 'log', label: '변환 로그 쓰기(W)', type: 'check', value: settings.log },
      { key: 'show', label: '선택 시 도면층 내용 표시(S)', type: 'check', value: settings.show },
    ],
    { ok: '확인', note: '변환 로그는 <도면 이름>.log 파일로 내려받습니다(이 앱의 문장 형식).' },
  );
  if (!v) return;
  settings = {
    forceColor: !!v.forceColor,
    forceLinetype: !!v.forceLinetype,
    forceTransparency: !!v.forceTransparency,
    blocks: !!v.blocks,
    purge: !!v.purge,
    log: !!v.log,
    show: !!v.show,
  };
}

const LW_OPTIONS = [
  { value: '-3', label: '기본값' },
  ...LINEWEIGHTS.map((w) => ({ value: String(w), label: `${(w / 100).toFixed(2)} mm` })),
];

/** 도면층 정의 대화상자(새로 만들기·편집) */
async function layerDialog(title: string, doc: CadDocument, base: Layer | null, taken: (name: string) => boolean): Promise<Layer | null> {
  const lts = [...doc.linetypes.values()].filter((l) => !/^(BYLAYER|BYBLOCK)$/i.test(l.name)).map((l) => l.name);
  if (base && !lts.some((n) => tableKey(n) === tableKey(base.linetype))) lts.unshift(base.linetype);
  const v = await form(
    title,
    [
      { key: 'name', label: '이름', type: 'text', value: base?.name ?? '' },
      { key: 'color', label: '색상(ACI 1~255)', type: 'number', value: base && base.color.aci >= 1 && base.color.aci <= 255 ? base.color.aci : 7 },
      { key: 'linetype', label: '선종류', type: 'select', value: base?.linetype ?? 'Continuous', options: lts.map((n) => ({ value: n, label: n })) },
      { key: 'lineweight', label: '선가중치', type: 'select', value: String(base?.lineweight ?? -3), options: LW_OPTIONS },
      { key: 'transparency', label: '투명도(0~90)', type: 'number', value: base ? Number(transparencyLabel(base.transparency)) : 0 },
      { key: 'plot', label: '플롯', type: 'check', value: base?.plot ?? true },
      { key: 'description', label: '설명', type: 'text', value: base?.description ?? '' },
    ],
    {
      ok: '확인',
      validate: (x) => {
        const n = String(x.name).trim();
        const e = validLayerName(n);
        if (e) return e;
        if (taken(n)) return `도면층 "${n}"이(가) 이미 변환 대상에 있습니다.`;
        const c = Number(x.color);
        if (!Number.isInteger(c) || c < 1 || c > 255) return '색상은 1~255의 정수입니다.';
        const t = Number(x.transparency);
        if (t < 0 || t > 90) return '투명도는 0~90입니다.';
        return null;
      },
    },
  );
  if (!v) return null;
  const color = base && base.color.aci === Number(v.color) ? { ...base.color } : { aci: Number(v.color) };
  const out: Layer = {
    ...(base ? structuredClone(base) : { handle: '', flags: 0, off: false, frozen: false, locked: false }),
    name: String(v.name).trim(),
    color,
    linetype: String(v.linetype),
    lineweight: Number(v.lineweight),
    transparency: Math.round(255 * (1 - Number(v.transparency) / 100)),
    plot: !!v.plot,
  } as Layer;
  const d = String(v.description).trim();
  if (d) out.description = d;
  else delete out.description;
  return out;
}

export function registerLayTransCommands(app: App): void {
  app.register({
    name: 'LAYTRANS',
    title: '도면층 변환기',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const targets = new Map<string, Target>();
      /** 원본 도면층(대문자) → 대상(대문자) */
      const mapping = new Map<string, string>();
      const view = new TempLayerView(app, st);

      // --- 왼쪽: 변환 시작
      const fromList = new PickList('변환 시작');
      const toList = new PickList('변환 대상');
      const filterInput = h('input', { class: 'ltx-input ltx-grow', type: 'text', placeholder: '와일드카드(예: A-*)', 'aria-label': '선택 필터' }) as HTMLInputElement;
      guardKeys(filterInput);
      const table = h('table', { class: 'ltx-table' });
      const tableBox = h('div', { class: 'ltx-list', style: 'max-height:180px;min-height:90px' }, table);
      const selectedMaps = new Set<string>();
      const info = h('div', { class: 'ltx-note' });

      const refreshFrom = () => {
        const counts = layerObjectCounts(doc);
        const items: ListItem[] = [...doc.layers.values()]
          .filter((l) => !mapping.has(tableKey(l.name)) && !cannotTranslate(l.name))
          .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
          .map((l) => {
            const c = counts.get(tableKey(l.name)) ?? 0;
            return { key: tableKey(l.name), label: l.name, swatch: layerSwatch(l), dim: c === 0, tag: c ? String(c) : '', title: c ? `객체 ${c}개` : '참조되지 않음' };
          });
        fromList.setItems(items);
      };
      const refreshTo = () => {
        const items: ListItem[] = [...targets.entries()]
          .sort((a, b) => a[1].layer.name.localeCompare(b[1].layer.name, 'ko'))
          .map(([k, t]) => ({ key: k, label: t.layer.name, swatch: layerSwatch(t.layer), tag: t.from, title: `${t.layer.name} — ${t.from}` }));
        toList.setItems(items);
      };
      const refreshTable = () => {
        const rows = [...mapping.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'));
        for (const k of [...selectedMaps]) if (!mapping.has(k)) selectedMaps.delete(k);
        table.replaceChildren(
          h('tr', {}, ...['이전 도면층 이름', '새 도면층 이름', '색상', '선종류', '선가중치', '투명도', '플롯'].map((t) => h('th', {}, t))),
          ...rows.map(([fk, tk]) => {
            const t = targets.get(tk)!;
            const from = doc.layers.get(fk)?.name ?? fk;
            const tr = h(
              'tr',
              { class: selectedMaps.has(fk) ? 'sel' : '' },
              h('td', {}, from),
              h('td', {}, t.layer.name),
              h('td', {}, colorLabel(t.layer.color)),
              h('td', {}, t.layer.linetype),
              h('td', {}, lineweightLabel(t.layer.lineweight)),
              h('td', {}, transparencyLabel(t.layer.transparency)),
              h('td', {}, t.layer.plot ? '예' : '아니오'),
            );
            tr.addEventListener('mousedown', (ev) => {
              if (!(ev.ctrlKey || ev.metaKey)) selectedMaps.clear();
              if (selectedMaps.has(fk)) selectedMaps.delete(fk);
              else selectedMaps.add(fk);
              refreshTable();
            });
            tr.addEventListener('dblclick', () => void editMapping());
            return tr;
          }),
        );
        info.textContent = `매핑 ${mapping.size}개 · 변환 대상 ${targets.size}개`;
      };
      const refreshAll = () => {
        refreshFrom();
        refreshTo();
        refreshTable();
      };

      fromList.onChange = () => {
        if (settings.show) {
          const sel = fromList.selection();
          view.show(sel.length ? new Set(sel) : null);
        }
      };
      fromList.onContext = (ev) =>
        showMenu(ev.clientX, ev.clientY, [
          { label: '모두 선택', run: () => fromList.setSelection(fromList.keys) },
          { label: '모두 지우기', run: () => fromList.setSelection([]) },
          {
            label: '도면층 소거',
            run: async () => {
              const r = purgeLayersOps(doc, fromList.selection().map((k) => doc.layers.get(k)?.name ?? k), currentLayer(app));
              if (!r.ops.length) {
                ctx.print('고른 도면층 가운데 소거할 수 있는(참조되지 않은) 도면층이 없습니다.', 'err');
                return;
              }
              view.restore();
              st.session.commit({ label: 'LAYTRANS', ops: r.ops, group: ctx.group });
              ctx.print(`도면층 ${r.purged.length}개를 소거했습니다.`);
              refreshFrom();
            },
          },
        ]);

      const selectBtn = h('button', { class: 'ltx-btn', type: 'button' }, '선택(C)');
      selectBtn.addEventListener('click', () => fromList.setSelection(filterLayerNames(fromList.keys.map((k) => doc.layers.get(k)?.name ?? k), filterInput.value || '*').map(tableKey)));
      filterInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') selectBtn.click();
      });

      const loadBtn = h('button', { class: 'ltx-btn', type: 'button', title: 'DWG·DXF·DWS·DWT 파일의 도면층을 변환 대상에 넣습니다' }, '로드(L)...');
      loadBtn.addEventListener('click', async () => {
        const files = await pickAndReadDrawings(app, (t, c) => ctx.print(t, c));
        let added = 0;
        let bad = 0;
        for (const f of files) {
          for (const l of f.doc.layers.values()) {
            const k = tableKey(l.name);
            if (l.name.includes('|') || validLayerName(l.name)) {
              bad++;
              continue;
            }
            if (targets.has(k)) continue;
            targets.set(k, { layer: structuredClone(l), source: f.doc, from: f.name });
            added++;
          }
        }
        if (files.length) ctx.print(`변환 대상에 도면층 ${added}개를 넣었습니다(${files.map((f) => f.name).join(', ')}).${bad ? ` 이름을 쓸 수 없거나 외부 참조 종속인 ${bad}개는 뺐습니다.` : ''}`);
        // 파일에 저장된 매핑(ACLAYTRANS): 이 도면에 있는 원본 도면층만, 이미 매핑한 것은 그대로
        let loaded = 0;
        for (const f of files) {
          for (const m of readLayTransMappings(f.doc)) {
            const tk = tableKey(m.target);
            if (!targets.has(tk)) continue;
            for (const n of m.sources) {
              const fk = tableKey(n);
              const l = doc.layers.get(fk);
              if (!l || cannotTranslate(l.name) || mapping.has(fk)) continue;
              mapping.set(fk, tk);
              loaded++;
            }
          }
        }
        if (loaded) ctx.print(`파일에 저장된 도면층 매핑 ${loaded}개를 불러왔습니다.`);
        refreshAll();
      });
      const newBtn = h('button', { class: 'ltx-btn', type: 'button' }, '새로 만들기(N)...');
      newBtn.addEventListener('click', async () => {
        const l = await layerDialog('새 도면층', doc, null, (n) => targets.has(tableKey(n)));
        if (!l) return;
        targets.set(tableKey(l.name), { layer: l, source: null, from: '새로 만들기' });
        refreshTo();
        toList.setSelection([tableKey(l.name)]);
      });

      const mapBtn = h('button', { class: 'ltx-btn', type: 'button' }, '매핑(M)');
      mapBtn.addEventListener('click', () => {
        const from = fromList.selection();
        const to = toList.selection();
        if (!from.length || to.length !== 1) {
          ctx.print('변환 시작에서 도면층을 하나 이상, 변환 대상에서 도면층 하나를 고르십시오.', 'err');
          return;
        }
        for (const f of from) mapping.set(f, to[0]!);
        view.restore();
        refreshAll();
      });
      const sameBtn = h('button', { class: 'ltx-btn', type: 'button' }, '동일 매핑(A)');
      sameBtn.addEventListener('click', () => {
        const from = fromList.keys.map((k) => doc.layers.get(k)?.name ?? k);
        const m = sameNameMappings(
          from,
          [...targets.values()].map((t) => t.layer),
        );
        for (const x of m) mapping.set(tableKey(x.from), tableKey(x.to.name));
        if (!m.length) ctx.print('이름이 같은 도면층이 없습니다.');
        refreshAll();
      });

      const editMapping = async () => {
        const fk = [...selectedMaps][0];
        if (!fk) return;
        const tk = mapping.get(fk)!;
        const t = targets.get(tk)!;
        const l = await layerDialog('도면층 편집', t.source ?? doc, t.layer, (n) => tableKey(n) !== tk && targets.has(tableKey(n)));
        if (!l) return;
        const nk = tableKey(l.name);
        targets.delete(tk);
        targets.set(nk, { ...t, layer: l });
        for (const [f, x] of mapping) if (x === tk) mapping.set(f, nk);
        refreshAll();
      };
      const editBtn = h('button', { class: 'ltx-btn', type: 'button' }, '편집(E)...');
      editBtn.addEventListener('click', () => void editMapping());
      const removeBtn = h('button', { class: 'ltx-btn', type: 'button' }, '제거(R)');
      const saveBtn = h('button', { class: 'ltx-btn', type: 'button', title: '매핑과 변환 대상 도면층을 DWS 파일로 내려받습니다(AutoCAD 도면층 변환기에서도 불러올 수 있습니다)' }, '저장(S)...');
      saveBtn.addEventListener('click', async () => {
        if (!mapping.size) {
          info.textContent = '저장할 매핑이 없습니다.';
          return;
        }
        const byTarget = new Map<string, LayTransSaveItem & { from: string[] }>();
        for (const [fk, tk] of mapping) {
          const t = targets.get(tk);
          if (!t) continue;
          let it = byTarget.get(tk);
          if (!it) byTarget.set(tk, (it = { layer: t.layer, source: t.source, from: [] }));
          it.from.push(doc.layers.get(fk)?.name ?? fk);
        }
        const name = `${baseName(st.name)}-도면층 매핑.dws`;
        let docId = -1;
        try {
          const out = layTransMappingDocument([...byTarget.values()], doc);
          docId = (await app.engine.adopt(name, out)).docId;
          const res = await app.engine.save(docId, 'dwg', 'AC1032', false);
          download(new Blob([res.data as BlobPart], { type: 'application/acad' }), name);
          ctx.print(`도면층 매핑 ${mapping.size}개(변환 대상 ${byTarget.size}개)를 ${name}(으)로 저장했습니다.`);
        } catch (e) {
          ctx.print(`매핑을 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
        } finally {
          if (docId >= 0) app.engine.closeDoc(docId);
        }
      });
      removeBtn.addEventListener('click', () => {
        for (const k of selectedMaps) mapping.delete(k);
        selectedMaps.clear();
        refreshAll();
      });

      const body = h(
        'div',
        { class: 'ltx-col' },
        h(
          'div',
          { class: 'ltx-row', style: 'align-items:stretch;flex-wrap:nowrap' },
          h('div', { class: 'ltx-col ltx-grow' }, h('div', { class: 'ltx-h' }, '변환 시작(F)'), fromList.el, h('div', { class: 'ltx-row' }, h('span', {}, '선택 필터'), filterInput, selectBtn)),
          h('div', { class: 'ltx-col', style: 'justify-content:center' }, mapBtn, sameBtn),
          h('div', { class: 'ltx-col ltx-grow' }, h('div', { class: 'ltx-h' }, '변환 대상(O)'), toList.el, h('div', { class: 'ltx-row' }, loadBtn, newBtn)),
        ),
        h('div', { class: 'ltx-h' }, '도면층 변환 매핑(Y)'),
        tableBox,
        h('div', { class: 'ltx-row' }, editBtn, removeBtn, saveBtn, h('span', { class: 'ltx-grow' }), info),
        h('div', { class: 'ltx-note' }, '저장(S)은 매핑을 DWS 파일로 내려받습니다(이 도면에는 남지 않습니다). 매핑을 저장한 파일을 로드(L)하면 매핑을 다시 채웁니다. 모든 매핑은 지금의 도면층 기준으로 한 번에 적용합니다.'),
      );
      refreshAll();
      const dlg = wideDialog('도면층 변환기', body, [
        { label: '설정(G)...', value: 'settings', keep: () => (void settingsDialog().then(() => fromList.onChange?.()), true) },
        { label: '취소', value: 'cancel' },
        {
          label: '변환(T)',
          value: 'translate',
          primary: true,
          keep: () => {
            if (mapping.size) return false;
            info.textContent = '먼저 도면층을 매핑하십시오(매핑(M) 또는 동일 매핑(A)).';
            return true;
          },
        },
      ]);
      let res: string | null;
      try {
        res = await dlg.closed;
      } finally {
        view.restore();
      }
      if (res !== 'translate' || !mapping.size || app.active !== st) return;

      // 대상 정의가 쓰는 선종류를 그 파일에서 가져온다
      const copiers = new Map<CadDocument, DefinitionCopier>();
      const lt = new Map<string, string>();
      const mappings: LayerMapping[] = [];
      for (const [fk, tk] of mapping) {
        const t = targets.get(tk)!;
        const from = doc.layers.get(fk);
        if (!from) continue;
        if (t.source && t.layer.linetype) {
          let cp = copiers.get(t.source);
          if (!cp) {
            cp = new DefinitionCopier(t.source, doc, () => st.session.newHandle());
            copiers.set(t.source, cp);
          }
          const n = cp.linetype(t.layer.linetype);
          if (n) lt.set(tableKey(t.layer.linetype), n);
        }
        mappings.push({ from: from.name, to: t.layer });
      }
      const r = translateLayersOps(doc, mappings, settings, () => st.session.newHandle(), (n) => lt.get(tableKey(n)) ?? (doc.linetypes.get(tableKey(n))?.name ?? 'Continuous'));
      const ops = [...[...copiers.values()].flatMap((c) => c.finish()), ...r.ops];
      if (!ops.length) {
        ctx.print('바꿀 것이 없습니다.');
        return;
      }
      st.session.commit({ label: 'LAYTRANS', ops, group: ctx.group });
      ctx.print(`도면층 ${mappings.length}개를 변환했습니다: 객체 ${r.moved}개를 옮겼습니다.${r.created.length ? ` 만든 도면층: ${r.created.join(', ')}.` : ''}${r.removed.length ? ` 삭제한 도면층: ${r.removed.join(', ')}.` : ''}`);
      if (r.kept.length) ctx.print(`블록 정의 안 등에 객체가 남아 지우지 않은 도면층: ${r.kept.join(', ')}`);
      if (settings.log) {
        const text = translateLog(st.name, mappings, settings, r);
        download(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${baseName(st.name)}.log`);
      }
      if (!r.moved && !r.created.length && !r.removed.length) await ask('도면층 변환기', '옮긴 객체가 없습니다.', [{ label: '확인', value: 'ok', primary: true }]);
    },
  });
}
