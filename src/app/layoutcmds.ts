/**
 * 배치와 페이지 설정: LAYOUT(신규·복사·이름 바꾸기·삭제·설정·목록), PAGESETUP
 */
import type { BlockDef, BlockRecord, DictionaryObject, Entity, Layout, LayoutObject, PlotSettings, ViewportEntity } from '../core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { cloneEntity } from '../edit/session';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { PAPERS } from './plot';
import { paperInfo } from './scene';
import { ask, form } from './ui/dom';

const STYLE_SHEETS = ['', 'monochrome.ctb', 'Grayscale.ctb', 'acad.ctb', 'Screening 50%.ctb', 'Fill Patterns.ctb'];

const INCH_NAMES: Record<string, string> = { LETTER: 'Letter', LEGAL: 'Legal', TABLOID: 'ANSI_B', ANSIC: 'ANSI_C', ANSID: 'ANSI_D', ANSIE: 'ANSI_E' };

/** AutoCAD식 용지 이름(가로면 긴 변이 먼저) */
function mediaName(key: string, w: number, h: number): string {
  if (/^A\d$/.test(key)) return `ISO_full_bleed_${key}_(${w.toFixed(2)}_x_${h.toFixed(2)}_MM)`;
  return `${INCH_NAMES[key] ?? key}_(${(w / 25.4).toFixed(2)}_x_${(h / 25.4).toFixed(2)}_Inches)`;
}

/** 지금 용지에 가장 가까운 목록 항목 */
function paperKey(p: PlotSettings): string {
  const a = Math.min(p.paperWidth, p.paperHeight);
  const b = Math.max(p.paperWidth, p.paperHeight);
  const hit = PAPERS.find((x) => Math.abs(x.w - a) < 1 && Math.abs(x.h - b) < 1);
  return hit?.key ?? '';
}

function isLandscape(p: PlotSettings): boolean {
  const w = p.rotation & 1 ? p.paperHeight : p.paperWidth;
  const h = p.rotation & 1 ? p.paperWidth : p.paperHeight;
  return w >= h;
}

/** 새 배치의 기본 플롯 설정 */
function defaultPlot(st: DocState): PlotSettings {
  const src = st.doc.layouts.find((l) => tableKey(l.blockName) !== MODEL_SPACE)?.plot;
  if (src) return structuredClone(src);
  const metric = Number(st.doc.header.get('$MEASUREMENT') ?? 1) === 1;
  const w = metric ? 420 : 431.8;
  const h = metric ? 297 : 279.4;
  return {
    pageSetupName: '',
    printerName: 'none_device',
    paperName: mediaName(metric ? 'A3' : 'TABLOID', w, h),
    paperWidth: w,
    paperHeight: h,
    margins: [0, 0, 0, 0],
    plotOrigin: { x: 0, y: 0 },
    windowMin: { x: 0, y: 0 },
    windowMax: { x: 0, y: 0 },
    scaleNumerator: 1,
    scaleDenominator: 1,
    flags: 688,
    paperUnits: metric ? 1 : 0,
    rotation: 0,
    plotType: 5,
    styleSheet: '',
    standardScaleType: 16,
  };
}

/** 사전 항목을 더하거나 뺀 사본 */
function dictWith(d: DictionaryObject, name: string, handle: string | null, oldName?: string): DictionaryObject {
  const entries = new Map(d.entries);
  if (oldName !== undefined) entries.delete(oldName);
  if (handle) entries.set(name, handle);
  else entries.delete(name);
  return { ...d, entries };
}

function layoutDict(st: DocState): DictionaryObject | null {
  for (const o of st.doc.objects.values()) if ((o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT') && [...(o as DictionaryObject).entries.values()].some((h) => st.doc.objects.get(h)?.type === 'LAYOUT')) return o as DictionaryObject;
  return null;
}

function nextLayoutName(st: DocState): string {
  const names = new Set(st.doc.layouts.map((l) => l.name.toUpperCase()));
  const base = st.doc.layouts.some((l) => l.name.startsWith('배치')) ? '배치' : 'Layout';
  let n = 1;
  while (names.has(`${base}${n}`.toUpperCase())) n++;
  return `${base}${n}`;
}

function nextPaperBlock(st: DocState): string {
  if (!st.doc.blocks.has('*PAPER_SPACE')) return '*Paper_Space';
  let n = 0;
  while (st.doc.blocks.has(`*PAPER_SPACE${n}`)) n++;
  return `*Paper_Space${n}`;
}

/** 배치를 만드는 작업들. entities가 없으면 전체 용지 뷰포트와 모형 범위를 보여 주는 뷰포트 하나 */
function createLayoutOps(app: App, st: DocState, name: string, plot: PlotSettings, entities?: Entity[]): { ops: EditOp[]; layout: Layout } {
  const s = st.session;
  const blockName = nextPaperBlock(st);
  const key = tableKey(blockName);
  const recordHandle = s.newHandle();
  const layoutHandle = s.newHandle();
  const tabOrder = Math.max(0, ...st.doc.layouts.map((l) => l.tabOrder)) + 1;
  const proto: Layout = {
    name,
    handle: layoutHandle,
    tabOrder,
    blockRecord: recordHandle,
    blockName,
    flags: 0,
    limitsMin: { x: 0, y: 0 },
    limitsMax: { x: 0, y: 0 },
    insertionBase: { x: 0, y: 0, z: 0 },
    extMin: { x: 0, y: 0, z: 0 },
    extMax: { x: 0, y: 0, z: 0 },
    elevation: 0,
    ucsOrigin: { x: 0, y: 0, z: 0 },
    ucsXAxis: { x: 1, y: 0, z: 0 },
    ucsYAxis: { x: 0, y: 1, z: 0 },
    plot,
  };
  const pi = paperInfo(proto, null);
  proto.limitsMin = { x: pi.minX, y: pi.minY };
  proto.limitsMax = { x: pi.maxX, y: pi.maxY };
  let ents: Entity[];
  if (entities) {
    ents = entities.map((e) => {
      const c = cloneEntity(e);
      c.handle = s.newHandle();
      c.owner = recordHandle;
      delete c.xdict;
      delete c.reactors;
      delete (c as { dwgRaw?: unknown }).dwgRaw;
      if (c.type === 'INSERT') for (const a of c.attribs) a.handle = s.newHandle();
      return c;
    });
  } else {
    const W = pi.maxX - pi.minX;
    const H = pi.maxY - pi.minY;
    const cx = (pi.minX + pi.maxX) / 2;
    const cy = (pi.minY + pi.maxY) / 2;
    const vp = (over: boolean): ViewportEntity => ({
      ...entityDefaults(),
      type: 'VIEWPORT',
      handle: s.newHandle(),
      owner: recordHandle,
      paperSpace: true,
      center: { x: cx, y: cy, z: 0 },
      width: over ? W : W * 0.9,
      height: over ? H : H * 0.85,
      status: over ? 1 : 2,
      id: over ? 1 : 2,
      viewCenter: { x: cx, y: cy },
      snapBase: { x: 0, y: 0 },
      snapSpacing: { x: 10, y: 10 },
      gridSpacing: { x: 10, y: 10 },
      viewDirection: { x: 0, y: 0, z: 1 },
      viewTarget: { x: 0, y: 0, z: 0 },
      lensLength: 50,
      frontClip: 0,
      backClip: 0,
      viewHeight: over ? H : H * 0.85,
      snapAngle: 0,
      twistAngle: 0,
      circleSides: 1000,
      flags: 32864,
      frozenLayers: [],
      renderMode: 0,
      ucsPerViewport: true,
    });
    const overall = vp(true);
    const model = vp(false);
    // 모형 범위를 뷰포트에 맞춘다
    const b = st.scenes.get(MODEL_SPACE)?.bounds;
    if (b && b.maxX > b.minX) {
      model.viewCenter = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      model.viewHeight = Math.max(b.maxY - b.minY, ((b.maxX - b.minX) * model.height) / model.width) * 1.05;
    }
    ents = [overall, model];
    proto.viewport = overall.handle;
  }
  const record: BlockRecord = { name: blockName, handle: recordHandle, flags: 0, layout: layoutHandle, insertUnits: 0, explodable: true, scalable: true };
  const def: BlockDef = { name: blockName, handle: s.newHandle(), recordHandle, basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: ents, endHandle: s.newHandle() };
  const dict = layoutDict(st);
  const lo: LayoutObject = { type: 'LAYOUT', handle: layoutHandle, owner: dict?.handle, reactors: dict ? [dict.handle] : undefined, layout: proto };
  const ops: EditOp[] = [
    { kind: 'blockRecord', key, before: null, after: record },
    { kind: 'blockDef', key, before: null, after: def },
    { kind: 'object', key: layoutHandle, before: null, after: lo },
    { kind: 'layout', key, before: null, after: proto },
  ];
  if (dict) ops.push({ kind: 'object', key: dict.handle, before: dict, after: dictWith(dict, name, layoutHandle) });
  void app;
  return { ops, layout: proto };
}

async function chooseLayout(ctx: CommandContext, prompt: string, def: string): Promise<Layout | null> {
  const st = ctx.app.active!;
  const r = await ctx.getPoint(`${prompt} <${def}>:`, { allowText: true });
  const name = 'text' in r ? r.text.trim() : 'enter' in r ? def : '';
  const l = st.doc.layouts.find((x) => x.name.toUpperCase() === name.toUpperCase() && tableKey(x.blockName) !== MODEL_SPACE);
  if (!l) {
    ctx.print(`배치 "${name}"이(가) 없습니다.`, 'err');
    return null;
  }
  return l;
}

export function registerLayoutCommands(app: App): void {
  app.register({
    name: 'LAYOUT',
    aliases: ['LO'],
    title: '배치',
    async run(ctx, arg) {
      const st = app.active!;
      const cur = st.layoutFor(st.space);
      const curName = cur && tableKey(cur.blockName) !== MODEL_SPACE ? cur.name : (st.doc.layouts.find((l) => tableKey(l.blockName) !== MODEL_SPACE)?.name ?? '');
      let opt = arg?.trim().toUpperCase();
      if (!opt) {
        const r = await ctx.getPoint('배치 옵션 입력 [복사(C)/삭제(D)/신규(N)/이름바꾸기(R)/설정(S)/?] <설정>:', {
          keywords: [
            { key: 'C', label: '복사' },
            { key: 'D', label: '삭제' },
            { key: 'N', label: '신규' },
            { key: 'R', label: '이름바꾸기' },
            { key: 'S', label: '설정' },
            { key: '?', label: '?' },
          ],
        });
        opt = 'keyword' in r ? r.keyword : 'S';
      }
      const paperLayouts = st.doc.layouts.filter((l) => tableKey(l.blockName) !== MODEL_SPACE);
      switch (opt) {
        case 'N': {
          const def = nextLayoutName(st);
          const r = await ctx.getPoint(`새 배치 이름 입력 <${def}>:`, { allowText: true });
          const name = 'text' in r && r.text.trim() ? r.text.trim() : def;
          if (st.doc.layouts.some((l) => l.name.toUpperCase() === name.toUpperCase())) {
            ctx.print(`배치 "${name}"이(가) 이미 있습니다.`, 'err');
            return;
          }
          await app.edits.flush(st);
          const { ops, layout } = createLayoutOps(app, st, name, defaultPlot(st));
          st.session.commit({ label: 'LAYOUT', ops });
          await app.setSpace(layout.blockName);
          ctx.print(`배치 "${name}"을(를) 만들었습니다.`);
          return;
        }
        case 'C': {
          const src = await chooseLayout(ctx, '복사할 배치 입력', curName);
          if (!src) return;
          const def = `${src.name} (2)`;
          const r = await ctx.getPoint(`복사된 배치의 이름 입력 <${def}>:`, { allowText: true });
          const name = 'text' in r && r.text.trim() ? r.text.trim() : def;
          if (st.doc.layouts.some((l) => l.name.toUpperCase() === name.toUpperCase())) {
            ctx.print(`배치 "${name}"이(가) 이미 있습니다.`, 'err');
            return;
          }
          const srcBlock = st.doc.blocks.get(tableKey(src.blockName));
          const { ops } = createLayoutOps(app, st, name, structuredClone(src.plot), srcBlock?.entities ?? []);
          st.session.commit({ label: 'LAYOUT', ops });
          ctx.print(`배치 "${src.name}"을(를) "${name}"(으)로 복사했습니다.`);
          return;
        }
        case 'R': {
          const l = await chooseLayout(ctx, '이름을 바꿀 배치 입력', curName);
          if (!l) return;
          const r = await ctx.getPoint('새 배치 이름 입력:', { allowText: true });
          const name = 'text' in r ? r.text.trim() : '';
          if (!name) return;
          if (st.doc.layouts.some((x) => x !== l && x.name.toUpperCase() === name.toUpperCase())) {
            ctx.print(`배치 "${name}"이(가) 이미 있습니다.`, 'err');
            return;
          }
          const ops: EditOp[] = [{ kind: 'layout', key: tableKey(l.blockName), before: l, after: { ...l, name } }];
          const dict = layoutDict(st);
          if (dict) ops.push({ kind: 'object', key: dict.handle, before: dict, after: dictWith(dict, name, l.handle, l.name) });
          st.session.commit({ label: 'LAYOUT', ops });
          ctx.print(`배치 "${l.name}"의 이름을 "${name}"(으)로 바꿨습니다.`);
          return;
        }
        case 'D': {
          const l = await chooseLayout(ctx, '삭제할 배치 이름 입력', curName);
          if (!l) return;
          if (paperLayouts.length <= 1) {
            ctx.print('배치가 하나뿐이라 삭제할 수 없습니다.', 'err');
            return;
          }
          const a = await ask('배치 삭제', `배치 "${l.name}"이(가) 영구적으로 삭제됩니다(명령 취소로 되돌릴 수 있습니다).`, [
            { label: '삭제', value: 'ok', primary: true },
            { label: '취소', value: 'cancel' },
          ]);
          if (a !== 'ok') return;
          const key = tableKey(l.blockName);
          if (st.space === key) await app.setSpace('*Model_Space');
          const ops: EditOp[] = [{ kind: 'layout', key, before: l, after: null }];
          const obj = st.doc.objects.get(l.handle);
          if (obj) ops.push({ kind: 'object', key: l.handle, before: obj, after: null });
          const dict = layoutDict(st);
          if (dict) ops.push({ kind: 'object', key: dict.handle, before: dict, after: dictWith(dict, l.name, null) });
          const blk = st.doc.blocks.get(key);
          if (blk) ops.push({ kind: 'blockDef', key, before: blk, after: null });
          const rec = st.doc.blockRecords.get(key);
          if (rec) ops.push({ kind: 'blockRecord', key, before: rec, after: null });
          st.session.commit({ label: 'LAYOUT', ops });
          ctx.print(`배치 "${l.name}"을(를) 삭제했습니다.`);
          return;
        }
        case '?':
          ctx.print(`배치: ${st.doc.layouts.map((l) => l.name).join(', ')}`, 'res');
          return;
        default: {
          const l = await chooseLayout(ctx, '현재로 설정할 배치 입력', curName);
          if (l) await app.setSpace(l.blockName);
        }
      }
    },
  });

  app.register({
    name: 'PAGESETUP',
    title: '페이지 설정',
    async run(ctx) {
      const st = app.active!;
      if (st.blockEdit) {
        ctx.print('블록 편집기에서는 쓸 수 없습니다.', 'err');
        return;
      }
      const l = st.layoutFor(st.space);
      if (!l) return;
      const p = l.plot;
      const key = paperKey(p);
      const v = await form(
        `페이지 설정 - ${l.name}`,
        [
          {
            key: 'paper',
            label: '용지 크기',
            type: 'select',
            value: key || 'KEEP',
            options: [...(key ? [] : [{ value: 'KEEP', label: `지금 용지: ${p.paperName || `${p.paperWidth} × ${p.paperHeight} mm`}` }]), ...PAPERS.map((x) => ({ value: x.key, label: x.label }))],
          },
          { key: 'landscape', label: '가로 방향', type: 'check', value: isLandscape(p) },
          { key: 'style', label: '플롯 스타일 테이블(펜 지정)', type: 'select', value: STYLE_SHEETS.includes(p.styleSheet) ? p.styleSheet : '', options: STYLE_SHEETS.map((x) => ({ value: x, label: x || '없음' })) },
        ],
        { ok: '확인', note: '배치의 용지·방향·플롯 스타일을 바꿉니다. PLOT은 이 설정을 기본값으로 씁니다.' },
      );
      if (!v) return;
      const np: PlotSettings = { ...structuredClone(p), styleSheet: String(v.style) };
      const land = !!v.landscape;
      const pk = String(v.paper);
      if (pk !== 'KEEP') {
        const paper = PAPERS.find((x) => x.key === pk)!;
        const w = land ? paper.h : paper.w;
        const h = land ? paper.w : paper.h;
        np.paperName = mediaName(pk, w, h);
        np.paperWidth = w;
        np.paperHeight = h;
        np.rotation = 0;
      } else if (land !== isLandscape(p)) np.rotation = (p.rotation + 1) & 3;
      // 용지 원점은 그대로 두고 크기만 바꾼다
      const before = paperInfo(l, null);
      const nl: Layout = { ...l, plot: np };
      const after = paperInfo({ ...nl, limitsMin: { x: 0, y: 0 }, limitsMax: { x: 0, y: 0 } }, null);
      nl.limitsMin = { x: before.minX, y: before.minY };
      nl.limitsMax = { x: before.minX + (after.maxX - after.minX), y: before.minY + (after.maxY - after.minY) };
      st.session.commit({ label: 'PAGESETUP', ops: [{ kind: 'layout', key: tableKey(l.blockName), before: l, after: nl }] });
      app.view.requestRender();
      ctx.print(`배치 "${l.name}"의 페이지 설정을 바꿨습니다.`);
    },
  });
}
