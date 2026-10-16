/**
 * 배치 꾸미기: MVSETUP(정렬·작성·뷰포트 축척·옵션·제목 블록, 모형 공간이면 축척한 용지 테두리), LAYOUTWIZARD(배치 마법사).
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 제목 블록은 ISO A 시리즈 틀을 블록(속성 포함)으로 만들어 넣는다.
 */
import type { BlockDef, BlockRecord, Entity, InsertEntity, LwPolylineEntity, PlotSettings, Vec2, ViewportEntity } from '../core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../core/model';
import { type IsoSheet, ISO_SHEETS, type Rect, alignedViewCenter, isoSheet, modelBorder, newViewport, paperToModel, parseScale, scaledViewHeight, titleBlockEntities, viewportAtPaper, viewportGrid } from '../edit/filecmds/layoutgeom';
import { stampDate } from '../edit/filecmds/stamp';
import type { EditOp } from '../edit/session';
import type { App, Command, CommandContext, Keyword } from './app';
import { makeAttribs } from './blocks';
import { currentProps } from './draw';
import type { DocState } from './docstate';
import { baseName } from './export';
import { createLayer } from './layers';
import { createLayoutOps, defaultPlot, mediaName, nextLayoutName } from './layoutcmds';
import { PAPERS, unitMm } from './plot';
import { paperInfo } from './scene';
import { dialog, h } from './ui/dom';
import { packLw } from '../core/lwpoly';

type Pt = { x: number; y: number };

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

async function askNumber(ctx: CommandContext, prompt: string, def: number, ok: (v: number) => boolean = () => true): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(`${prompt} <${Math.round(def * 1e6) / 1e6}>:`, { preferNumber: true, allowText: true });
    if ('enter' in r) return def;
    if ('text' in r) {
      const v = Number(r.text.trim());
      if (Number.isFinite(v) && ok(v)) return v;
    }
    ctx.print('올바른 값을 입력하십시오.', 'err');
  }
}

async function askRect(ctx: CommandContext, first: string, fallback: Rect | null): Promise<Rect | null> {
  const a = await ctx.getPoint(first);
  if ('enter' in a) return fallback;
  if (!('point' in a)) return null;
  const p = a.point;
  const box = (q: Pt) => [p.x, p.y, q.x, p.y, q.x, q.y, p.x, q.y];
  const b = await ctx.getPoint('반대 구석 지정:', { base: p, rubber: (q) => [{ pts: box(q), closed: true, dashed: true }] });
  if (!('point' in b)) return null;
  const q = b.point;
  const r: Rect = [Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y)];
  return r[2] - r[0] > 1e-9 && r[3] - r[1] > 1e-9 ? r : null;
}

function layoutVps(st: DocState, key: string): ViewportEntity[] {
  return (st.doc.blocks.get(key)?.entities ?? []).filter((e): e is ViewportEntity => e.type === 'VIEWPORT');
}

/** 배치의 전체 용지 뷰포트가 없으면(초기화하지 않은 배치) 만드는 작업 */
function overallOps(st: DocState, key: string): EditOp[] {
  const lay = st.layoutFor(key);
  if (!lay) return [];
  const vps = layoutVps(st, key);
  if (vps.some((v) => v.id === 1) || (lay.viewport && vps.some((v) => v.handle === lay.viewport))) return [];
  const p = paperInfo(lay, null);
  const vp = newViewport([p.minX, p.minY, p.maxX, p.maxY], { handle: st.session.newHandle(), owner: st.doc.blocks.get(key)?.recordHandle, id: 1 });
  vp.status = 1;
  vp.viewCenter = { x: vp.center.x, y: vp.center.y };
  vp.viewHeight = vp.height;
  return [{ kind: 'add', block: key, entity: vp, index: 0 }];
}

/** 용지 사각형과 인쇄 가능 영역 */
function paperRects(st: DocState, key: string): { paper: Rect; printable: Rect; mmPerUnit: number } | null {
  const lay = st.layoutFor(key);
  if (!lay) return null;
  const p = paperInfo(lay, st.scenes.get(key)?.bounds ?? null);
  const paper: Rect = [p.minX, p.minY, p.maxX, p.maxY];
  return { paper, printable: p.printable ?? paper, mmPerUnit: p.mmPerUnit };
}

/** 뷰포트 축척: 용지 단위 / 모형 단위(축척 문자열 a:b는 용지 mm·인치 : 도면 단위의 mm·인치로 읽는다) */
function vpScale(st: DocState, scale: string, paperMmPerUnit: number): number | undefined {
  const r = parseScale(scale);
  if (r === null) return undefined;
  const ins = Number(st.doc.header.get('$INSUNITS') ?? 0) || (st.units.measurement ? 4 : 1);
  // 용지 단위 1 = paperMmPerUnit mm, 모형 단위 1 = unitMm(ins) mm
  return (r * unitMm(ins)) / paperMmPerUnit;
}

/** ISO 제목 블록 정의(없으면 만드는 작업)와 그 블록 참조. at = 용지 왼쪽 아래 자리, scale = 용지 단위 / mm */
function titleBlockInsert(app: App, st: DocState, sheet: IsoSheet, at: Pt, scale: number, layer: string, owner: string | undefined): { ops: EditOp[]; insert: InsertEntity } {
  const s = st.session;
  const name = `ISO_${sheet.key}_${sheet.w >= sheet.h ? 'LANDSCAPE' : 'PORTRAIT'}`;
  const key = tableKey(name);
  const ops: EditOp[] = [];
  let def = st.doc.blocks.get(key);
  if (!def) {
    const recH = s.newHandle();
    const ents = titleBlockEntities(sheet, { title: '', drawn: '', number: '', scale: '1:1', date: '', sheet: `ISO ${sheet.key}` }).map((e) => ({ ...e, handle: s.newHandle(), owner: recH }) as Entity);
    const record: BlockRecord = { name, handle: recH, flags: 0, insertUnits: 4, explodable: true, scalable: true };
    def = { name, handle: s.newHandle(), recordHandle: recH, basePoint: { x: 0, y: 0, z: 0 }, flags: 2, entities: ents, endHandle: s.newHandle(), description: `ISO ${sheet.key} 도면 틀과 제목 블록` } satisfies BlockDef;
    ops.push({ kind: 'blockRecord', key, before: null, after: record }, { kind: 'blockDef', key, before: null, after: def });
  }
  const handle = s.newHandle();
  const ins: InsertEntity = {
    ...entityDefaults(),
    ...currentProps(app),
    layer,
    type: 'INSERT',
    handle,
    owner,
    paperSpace: true,
    block: def.name,
    insert: { x: at.x, y: at.y, z: 0 },
    scale: { x: scale, y: scale, z: scale },
    rotation: 0,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  };
  const values = new Map([
    ['TITLE', baseName(st.saveName)],
    ['DATE', stampDate(new Date()).slice(0, 10)],
    ['SHEET', `ISO ${sheet.key}`],
  ]);
  ins.attribs = makeAttribs(app, def, ins.insert, ins.scale, 0, values, handle);
  return { ops, insert: ins };
}

const offsetRect = (r: Rect, at: Pt, k: number): Rect => [at.x + r[0] * k, at.y + r[1] * k, at.x + r[2] * k, at.y + r[3] * k];

// ---------------------------------------------------------------------------
// MVSETUP
// ---------------------------------------------------------------------------

/** 세션 동안의 MVSETUP 옵션 */
const mv = { layer: '', limits: false, units: '' as '' | 'mm' | 'inch' | 'ft' | 'm', origin: null as Pt | null };
/** 배치 키 → 제목 블록의 도면 영역(작성(C)의 기본 영역) */
const titleAreas = new Map<string, Rect>();

const MAIN_KW: Keyword[] = [
  { key: 'A', label: '정렬' },
  { key: 'C', label: '작성' },
  { key: 'S', label: '뷰포트 축척' },
  { key: 'O', label: '옵션' },
  { key: 'T', label: '제목 블록' },
  { key: 'U', label: '명령 취소' },
];

const METRIC_SCALES: [number, string][] = [
  [5000, '1:5000'],
  [2000, '1:2000'],
  [1000, '1:1000'],
  [500, '1:500'],
  [200, '1:200'],
  [100, '1:100'],
  [75, '1:75'],
  [50, '1:50'],
  [20, '1:20'],
  [10, '1:10'],
  [5, '1:5'],
  [1, '전체'],
];
const DECIMAL_SCALES: [number, string][] = [
  [4, '4배'],
  [2, '2배'],
  [1, '전체'],
  [0.5, '1/2'],
  [0.25, '1/4'],
];
const ENGINEERING_SCALES: [number, string][] = [
  [120, '1"=10\''],
  [240, '1"=20\''],
  [360, '1"=30\''],
  [480, '1"=40\''],
  [600, '1"=50\''],
  [720, '1"=60\''],
  [960, '1"=80\''],
  [1200, '1"=100\''],
];
const ARCH_SCALES: [number, string][] = [
  [480, '1/40"=1\''],
  [240, '1/20"=1\''],
  [192, '1/16"=1\''],
  [96, '1/8"=1\''],
  [48, '1/4"=1\''],
  [24, '1/2"=1\''],
  [16, '3/4"=1\''],
  [12, '1"=1\''],
  [4, '3"=1\''],
  [2, '6"=1\''],
  [1, '전체'],
];

/** 모형 공간 MVSETUP: 단위·축척·용지 크기로 축척한 테두리를 그린다 */
async function modelSetup(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const r = await ctx.getPoint('단위 유형 입력 [과학(S)/십진(D)/공학(E)/건축(A)/미터법(M)]:', {
    keywords: [
      { key: 'S', label: '과학' },
      { key: 'D', label: '십진' },
      { key: 'E', label: '공학' },
      { key: 'A', label: '건축' },
      { key: 'M', label: '미터법' },
    ],
  });
  if (!('keyword' in r)) return;
  const [title, list] = r.keyword === 'M' ? ['미터법 축척', METRIC_SCALES] : r.keyword === 'E' ? ['공학 축척', ENGINEERING_SCALES] : r.keyword === 'A' ? ['건축 축척', ARCH_SCALES] : [r.keyword === 'S' ? '과학 축척' : '십진 축척', DECIMAL_SCALES];
  ctx.print(title);
  ctx.print('==================');
  for (const [v, label] of list as [number, string][]) ctx.print(`(${v}) ${label}`);
  const scale = await askNumber(ctx, '축척 비율 입력', 1, (v) => v > 0);
  const w = await askNumber(ctx, '용지 폭 입력', r.keyword === 'M' ? 420 : 17, (v) => v > 0);
  const hgt = await askNumber(ctx, '용지 높이 입력', r.keyword === 'M' ? 297 : 11, (v) => v > 0);
  const pts = modelBorder(w, hgt, scale);
  const border: LwPolylineEntity = {
    ...entityDefaults(),
    ...currentProps(app),
    type: 'LWPOLYLINE',
    handle: st.session.newHandle(),
    owner: st.doc.blocks.get(MODEL_SPACE)?.recordHandle,
    ...packLw([0, 2, 4, 6].map((i) => ({ x: pts[i]!, y: pts[i + 1]!, bulge: 0, startWidth: 0, endWidth: 0 }))),
    closed: true,
    plinegen: false,
    constantWidth: 0,
    elevation: 0,
  };
  const ops: EditOp[] = [
    { kind: 'add', block: MODEL_SPACE, entity: border },
    { kind: 'header', name: '$LIMMIN', before: st.doc.header.get('$LIMMIN'), after: { x: 0, y: 0 } },
    { kind: 'header', name: '$LIMMAX', before: st.doc.header.get('$LIMMAX'), after: { x: w * scale, y: hgt * scale } },
  ];
  st.session.commit({ label: 'MVSETUP', ops, group: ctx.group });
  const pad = Math.max(w, hgt) * scale * 0.05;
  app.view.zoomRect(-pad, -pad, w * scale + pad, hgt * scale + pad, true, 0);
  ctx.print(`용지 ${w} × ${hgt}을(를) 축척 ${scale}(으)로 테두리를 그리고 한계를 맞췄습니다.`);
}

async function mvsetup(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  if (st.blockEdit) {
    ctx.print('블록 편집기에서는 쓸 수 없습니다.', 'err');
    return;
  }
  if (!st.onLayout) {
    const r = await ctx.getPoint('도면 공간을 사용하시겠습니까? [아니오(N)/예(Y)] <예>:', {
      keywords: [
        { key: 'N', label: '아니오' },
        { key: 'Y', label: '예' },
      ],
    });
    if ('keyword' in r && r.keyword === 'N') {
      await modelSetup(app, ctx);
      return;
    }
    if (!('enter' in r) && !('keyword' in r)) return;
    const lay = st.layouts.filter((l) => tableKey(l.blockName) !== MODEL_SPACE).sort((a, b) => a.tabOrder - b.tabOrder)[0];
    if (!lay) {
      ctx.print('배치가 없습니다. LAYOUT 또는 LAYOUTWIZARD로 먼저 배치를 만드십시오.', 'err');
      return;
    }
    // 공간을 바꾸면 이 명령은 끝나므로 배치에서 다시 시작한다
    await app.setSpace(lay.blockName);
    void app.run('MVSETUP');
    return;
  }
  if (st.msVp) {
    app.exitViewport(st);
    void app.run('MVSETUP');
    return;
  }
  const key = st.space;
  /** 이번 명령에서 한 단계마다 넣은 작업 수(명령 취소(U)) */
  const steps: number[] = [];
  const commit = (ops: EditOp[]) => {
    if (!ops.length) return;
    st.session.commit({ label: 'MVSETUP', ops, group: ctx.group });
    steps.push(ops.length);
  };
  const undo = () => {
    const n = steps.pop();
    if (n === undefined) ctx.print('명령 취소할 작업이 없습니다.');
    else st.session.undoLastStep(ctx.group, n);
  };
  const delObjects = async () => {
    const hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
    const ops: EditOp[] = [];
    for (const hnd of hs) {
      const e = st.doc.entityIndex.get(hnd);
      const blk = st.session.ownerOf(hnd);
      if (!e || !blk || (e.type === 'VIEWPORT' && (e as ViewportEntity).id === 1)) continue;
      const list = st.doc.blocks.get(blk)?.entities ?? [];
      ops.push({ kind: 'remove', block: blk, entity: e, index: list.indexOf(e) });
    }
    commit(ops);
    if (ops.length) ctx.print(`객체 ${ops.length}개를 지웠습니다.`);
  };
  for (;;) {
    const r = await ctx.getPoint('옵션 입력 [정렬(A)/작성(C)/뷰포트 축척(S)/옵션(O)/제목 블록(T)/명령 취소(U)]:', { keywords: MAIN_KW });
    if (!('keyword' in r)) return;
    switch (r.keyword) {
      case 'U':
        undo();
        break;
      case 'A':
        await alignStep(ctx, st, key, commit, undo);
        break;
      case 'C': {
        const c = await ctx.getPoint('옵션 입력 [객체 삭제(D)/뷰포트 작성(C)/명령 취소(U)] <작성>:', {
          keywords: [
            { key: 'D', label: '객체 삭제' },
            { key: 'C', label: '뷰포트 작성' },
            { key: 'U', label: '명령 취소' },
          ],
        });
        if ('keyword' in c && c.keyword === 'D') await delObjects();
        else if ('keyword' in c && c.keyword === 'U') undo();
        else if ('enter' in c || ('keyword' in c && c.keyword === 'C')) await createStep(ctx, st, key, commit);
        break;
      }
      case 'S':
        await scaleStep(ctx, st, key, commit);
        break;
      case 'O':
        await optionsStep(app, ctx, st);
        break;
      case 'T': {
        for (;;) {
          const t = await ctx.getPoint('옵션 입력 [객체 삭제(D)/원점(O)/명령 취소(U)/삽입(I)] <삽입>:', {
            keywords: [
              { key: 'D', label: '객체 삭제' },
              { key: 'O', label: '원점' },
              { key: 'U', label: '명령 취소' },
              { key: 'I', label: '삽입' },
            ],
          });
          if ('keyword' in t && t.keyword === 'D') await delObjects();
          else if ('keyword' in t && t.keyword === 'U') undo();
          else if ('keyword' in t && t.keyword === 'O') {
            const o = await ctx.getPoint('이 시트의 새 원점 지정:');
            if ('point' in o) mv.origin = o.point;
            continue;
          } else if ('enter' in t || ('keyword' in t && t.keyword === 'I')) await titleStep(app, ctx, st, key, commit);
          break;
        }
        break;
      }
    }
  }
}

async function alignStep(ctx: CommandContext, st: DocState, key: string, commit: (ops: EditOp[]) => void, undo: () => void): Promise<void> {
  for (;;) {
    const r = await ctx.getPoint('옵션 입력 [각도(A)/수평(H)/수직 정렬(V)/뷰 회전(R)/명령 취소(U)]:', {
      keywords: [
        { key: 'A', label: '각도' },
        { key: 'H', label: '수평' },
        { key: 'V', label: '수직 정렬' },
        { key: 'R', label: '뷰 회전' },
        { key: 'U', label: '명령 취소' },
      ],
    });
    if (!('keyword' in r)) return;
    if (r.keyword === 'U') {
      undo();
      continue;
    }
    if (r.keyword === 'A' || r.keyword === 'R') {
      ctx.print('이 웹 버전은 각도 정렬과 뷰 회전을 지원하지 않습니다. 수평(H)·수직 정렬(V)을 쓰십시오.', 'err');
      continue;
    }
    const vps = layoutVps(st, key);
    const a = await ctx.getPoint('기준점 지정:');
    if (!('point' in a)) return;
    const v1 = viewportAtPaper(vps, a.point);
    if (!v1) {
      ctx.print('점이 뷰포트 안에 있지 않습니다.', 'err');
      continue;
    }
    const b = await ctx.getPoint('초점 이동할 점 지정:', { base: a.point });
    if (!('point' in b)) return;
    const v2 = viewportAtPaper(vps, b.point);
    if (!v2 || v2 === v1) {
      ctx.print('다른 뷰포트 안의 점을 지정하십시오.', 'err');
      continue;
    }
    const vc = alignedViewCenter(v2, paperToModel(v2, b.point), a.point, r.keyword === 'H' ? 'H' : 'V');
    if (!vc) {
      ctx.print('비틀린 뷰포트는 정렬할 수 없습니다.', 'err');
      continue;
    }
    commit([{ kind: 'modify', block: key, before: v2, after: { ...v2, viewCenter: vc } }]);
  }
}

async function createStep(ctx: CommandContext, st: DocState, key: string, commit: (ops: EditOp[]) => void): Promise<void> {
  const list = () => {
    ctx.print('사용할 수 있는 배치 옵션: . . .');
    ctx.print('0:       없음');
    ctx.print('1:       단일');
    ctx.print('2:       표준 공학');
    ctx.print('3:       뷰포트 배열');
  };
  list();
  let choice = -1;
  while (choice < 0) {
    const r = await ctx.getPoint('로드할 배치 번호 입력 또는 [다시 표시(R)]:', { keywords: [{ key: 'R', label: '다시 표시' }], allowText: true, preferNumber: true });
    if ('keyword' in r) {
      list();
      continue;
    }
    if ('enter' in r) return;
    if (!('text' in r)) return;
    const n = Number(r.text.trim());
    if ([0, 1, 2, 3].includes(n)) choice = n;
    else ctx.print('0~3 중에서 고르십시오.', 'err');
  }
  if (choice === 0) return;
  const pr = paperRects(st, key);
  const fallback = titleAreas.get(key) ?? pr?.printable ?? null;
  const area = await askRect(ctx, '경계 영역의 첫 번째 점 지정:', fallback);
  if (!area) return;
  let rects: Rect[];
  if (choice === 1) rects = [area];
  else if (choice === 2) {
    const gx = await askNumber(ctx, 'X 방향으로 뷰포트 사이의 거리 지정', 0, (v) => v >= 0);
    const gy = await askNumber(ctx, 'Y 방향으로 뷰포트 사이의 거리 지정', gx, (v) => v >= 0);
    rects = viewportGrid(area, 2, 2, gx, gy);
  } else {
    const cols = await askNumber(ctx, 'X 방향의 뷰포트 개수 입력', 1, (v) => v >= 1 && Number.isInteger(v) && v <= 20);
    const rows = await askNumber(ctx, 'Y 방향의 뷰포트 개수 입력', 1, (v) => v >= 1 && Number.isInteger(v) && v <= 20);
    const gx = cols > 1 ? await askNumber(ctx, 'X 방향으로 뷰포트 사이의 거리 지정', 0, (v) => v >= 0) : 0;
    const gy = rows > 1 ? await askNumber(ctx, 'Y 방향으로 뷰포트 사이의 거리 지정', gx, (v) => v >= 0) : 0;
    rects = viewportGrid(area, cols, rows, gx, gy);
  }
  if (!rects.length) {
    ctx.print('간격이 너무 커서 뷰포트를 만들 수 없습니다.', 'err');
    return;
  }
  const owner = st.doc.blocks.get(key)?.recordHandle;
  const bounds = st.scenes.get(MODEL_SPACE)?.bounds ?? null;
  let id = Math.max(1, ...layoutVps(st, key).map((v) => v.id));
  const ops: EditOp[] = [...overallOps(st, key)];
  for (const r of rects) ops.push({ kind: 'add', block: key, entity: newViewport(r, { handle: st.session.newHandle(), owner, id: ++id, bounds }) });
  commit(ops);
  ctx.print(`뷰포트 ${rects.length}개를 만들었습니다${choice === 2 ? '(2D 도면이라 네 뷰포트 모두 평면 뷰)' : ''}.`);
}

async function scaleStep(ctx: CommandContext, st: DocState, key: string, commit: (ops: EditOp[]) => void): Promise<void> {
  ctx.print('축척할 뷰포트 선택...');
  const hs = new Set(await ctx.getSelection('객체 선택:', { noPickfirst: true }));
  const vps = layoutVps(st, key).filter((v) => v.id !== 1 && (hs.has(v.handle) || (v.clipBoundary && hs.has(v.clipBoundary))));
  if (!vps.length) {
    ctx.print('뷰포트를 고르지 않았습니다.', 'err');
    return;
  }
  let interactive = false;
  if (vps.length > 1) {
    const r = await ctx.getPoint('뷰포트의 축척 비율 설정. [대화식(I)/균일(U)] <균일>:', {
      keywords: [
        { key: 'I', label: '대화식' },
        { key: 'U', label: '균일' },
      ],
    });
    interactive = 'keyword' in r && r.keyword === 'I';
  }
  const ops: EditOp[] = [];
  let paper = 1;
  let model = 1;
  for (const [i, v] of vps.entries()) {
    if (i === 0 || interactive) {
      if (interactive) ctx.print(`뷰포트 ${i + 1}/${vps.length} (ID ${v.id})`);
      paper = await askNumber(ctx, '도면 공간 단위 수 입력', 1, (x) => x > 0);
      model = await askNumber(ctx, '모형 공간 단위 수 입력', 1, (x) => x > 0);
    }
    ops.push({ kind: 'modify', block: key, before: v, after: { ...v, viewHeight: scaledViewHeight(v.height, paper, model) } });
  }
  commit(ops);
}

async function optionsStep(app: App, ctx: CommandContext, st: DocState): Promise<void> {
  for (;;) {
    const r = await ctx.getPoint('옵션 입력 [도면층(L)/한계(LI)/단위(U)/외부 참조(X)] <종료>:', {
      keywords: [
        { key: 'L', label: '도면층' },
        { key: 'LI', label: '한계' },
        { key: 'U', label: '단위' },
        { key: 'X', label: '외부 참조' },
      ],
    });
    if (!('keyword' in r)) return;
    if (r.keyword === 'L') {
      const t = await ctx.getPoint(`제목 블록을 넣을 도면층 이름 입력 또는 [.(현재 도면층)] <${mv.layer || '.'}>:`, { allowText: true });
      if (!('text' in t)) continue;
      const n = t.text.trim();
      if (n === '.' || !n) mv.layer = '';
      else {
        if (!st.doc.layers.has(tableKey(n)) && !createLayer(app, n)) continue;
        mv.layer = st.doc.layers.get(tableKey(n))?.name ?? n;
      }
    } else if (r.keyword === 'LI') {
      const t = await ctx.getPoint(`제목 블록 삽입 후 한계를 재설정하시겠습니까? [예(Y)/아니오(N)] <${mv.limits ? '예' : '아니오'}>:`, {
        keywords: [
          { key: 'Y', label: '예' },
          { key: 'N', label: '아니오' },
        ],
      });
      if ('keyword' in t) mv.limits = t.keyword === 'Y';
    } else if (r.keyword === 'U') {
      const t = await ctx.getPoint('용지 공간 단위 유형 입력 [피트(F)/인치(I)/미터(ME)/밀리미터(M)] <밀리미터>:', {
        keywords: [
          { key: 'F', label: '피트' },
          { key: 'I', label: '인치' },
          { key: 'ME', label: '미터' },
          { key: 'M', label: '밀리미터' },
        ],
      });
      mv.units = 'keyword' in t ? (t.keyword === 'F' ? 'ft' : t.keyword === 'I' ? 'inch' : t.keyword === 'ME' ? 'm' : 'mm') : 'mm';
    } else {
      await ctx.getPoint('제목 블록을 외부 참조하시겠습니까? [예(Y)/아니오(N)] <아니오>:', {
        keywords: [
          { key: 'Y', label: '예' },
          { key: 'N', label: '아니오' },
        ],
      });
      ctx.print('이 웹 버전은 제목 블록을 블록으로만 넣습니다(외부 참조 아님).');
    }
  }
}

async function titleStep(app: App, ctx: CommandContext, st: DocState, key: string, commit: (ops: EditOp[]) => void): Promise<void> {
  const list = () => {
    ctx.print('사용할 수 있는 제목 블록:...');
    ctx.print('0:     없음');
    ISO_SHEETS.forEach((s, i) => ctx.print(`${i + 1}:     ISO ${s.key} 크기(mm)`));
  };
  list();
  let n = -1;
  while (n < 0) {
    const r = await ctx.getPoint('로드할 제목 블록 번호 입력 또는 [다시 표시(R)]:', { keywords: [{ key: 'R', label: '다시 표시' }], allowText: true, preferNumber: true });
    if ('keyword' in r) {
      list();
      continue;
    }
    if (!('text' in r)) return;
    const v = Number(r.text.trim());
    if (Number.isInteger(v) && v >= 0 && v <= ISO_SHEETS.length) n = v;
    else ctx.print(`0~${ISO_SHEETS.length} 중에서 고르십시오.`, 'err');
  }
  if (n === 0) return;
  const pr = paperRects(st, key);
  const lay = st.layoutFor(key);
  if (!pr || !lay) return;
  const landscape = pr.paper[2] - pr.paper[0] >= pr.paper[3] - pr.paper[1];
  const sheet = isoSheet(ISO_SHEETS[n - 1]!.key, landscape)!;
  const unitMmOf = mv.units === 'inch' ? 25.4 : mv.units === 'ft' ? 304.8 : mv.units === 'm' ? 1000 : mv.units === 'mm' ? 1 : pr.mmPerUnit;
  const k = 1 / unitMmOf;
  const at = mv.origin ?? { x: pr.paper[0], y: pr.paper[1] };
  const { ops, insert } = titleBlockInsert(app, st, sheet, at, k, mv.layer || currentProps(app).layer, st.doc.blocks.get(key)?.recordHandle);
  ops.push({ kind: 'add', block: key, entity: insert });
  if (mv.limits) ops.push({ kind: 'layout', key, before: lay, after: { ...lay, limitsMin: { x: at.x, y: at.y }, limitsMax: { x: at.x + sheet.w * k, y: at.y + sheet.h * k } } });
  commit(ops);
  titleAreas.set(key, offsetRect(sheet.area, at, k));
  ctx.print(`ISO ${sheet.key} 도면 틀과 제목 블록을 넣었습니다(블록 ${insert.block}, 제목 칸은 속성 — ATTEDIT·더블클릭으로 고칩니다).`);
}

// ---------------------------------------------------------------------------
// LAYOUTWIZARD
// ---------------------------------------------------------------------------

interface WizardState {
  name: string;
  printer: string;
  paper: string;
  inch: boolean;
  landscape: boolean;
  title: string;
  vpMode: 'none' | 'single' | 'std' | 'array';
  vpScale: string;
  rows: number;
  cols: number;
  rowGap: number;
  colGap: number;
  pick: boolean;
}

const PRINTERS = [
  { value: 'none_device', label: '없음' },
  { value: 'DWG To PDF.pc3', label: 'DWG To PDF.pc3 (PDF)' },
  { value: 'SVG', label: 'SVG (이 프로그램의 벡터 출력)' },
];
const VP_SCALES = ['fit', '1:1', '1:2', '1:5', '1:10', '1:20', '1:50', '1:100', '1:200', '1:500', '1:1000', '2:1', '5:1', '10:1'];
const STEPS = ['시작', '프린터', '용지 크기', '방향', '제목 블록', '뷰포트 정의', '위치 선택', '마침'];

/** 단계마다 화면을 바꾸는 마법사 대화상자. 마침이면 상태, 취소면 null */
function runWizard(st: DocState): Promise<WizardState | null> {
  const metric = !!st.units.measurement;
  const s: WizardState = { name: nextLayoutName(st), printer: 'DWG To PDF.pc3', paper: metric ? 'A3' : 'TABLOID', inch: !metric, landscape: true, title: '', vpMode: 'single', vpScale: 'fit', rows: 2, cols: 2, rowGap: 0.1 * (metric ? 25.4 : 1), colGap: 0.1 * (metric ? 25.4 : 1), pick: false };
  return new Promise((resolve) => {
    let step = 0;
    let done = false;
    const side = h('ol', { style: 'margin:0;padding:0 0 0 18px;min-width:120px;line-height:1.9' });
    const pane = h('div', { style: 'flex:1;min-width:260px;display:flex;flex-direction:column;gap:10px' });
    const body = h('div', { style: 'display:flex;gap:18px;min-height:260px;max-width:min(640px,86vw)' }, side, pane);
    const row = (label: string, el: HTMLElement) => h('label', { class: 'form-row' }, h('span', {}, label), el);
    const radio = (name: string, opts: { value: string; label: string }[], cur: string, set: (v: string) => void) =>
      h(
        'div',
        { style: 'display:flex;flex-direction:column;gap:4px' },
        ...opts.map((o) => {
          const r = h('input', { type: 'radio', name, value: o.value }) as HTMLInputElement;
          r.checked = o.value === cur;
          r.addEventListener('change', () => r.checked && set(o.value));
          return h('label', { style: 'display:flex;gap:6px;align-items:center' }, r, o.label);
        }),
      );
    const select = (opts: { value: string; label: string }[], cur: string, set: (v: string) => void) => {
      const el = h('select', {}, ...opts.map((o) => h('option', { value: o.value }, o.label))) as HTMLSelectElement;
      el.value = cur;
      el.addEventListener('change', () => set(el.value));
      return el;
    };
    const text = (cur: string, set: (v: string) => void) => {
      const el = h('input', { type: 'text' }) as HTMLInputElement;
      el.value = cur;
      el.addEventListener('input', () => set(el.value));
      el.addEventListener('keydown', (ev) => ev.stopPropagation());
      return el;
    };
    const num = (cur: number, set: (v: number) => void) =>
      text(String(cur), (v) => {
        const n = Number(v);
        if (Number.isFinite(n)) set(n);
      });
    const para = (t: string) => h('p', { style: 'margin:0;color:var(--text-dim);white-space:normal' }, t);
    const err = h('div', { class: 'form-error', role: 'alert' });
    const render = () => {
      side.innerHTML = '';
      STEPS.forEach((n, i) => side.append(h('li', { style: i === step ? 'font-weight:700' : 'color:var(--text-dim)' }, n)));
      pane.innerHTML = '';
      err.textContent = '';
      switch (step) {
        case 0:
          pane.append(para('이 마법사는 새 배치의 플롯 장치, 용지, 제목 블록, 뷰포트를 차례로 정합니다.'), row('새 배치의 이름 입력', text(s.name, (v) => (s.name = v))));
          break;
        case 1:
          pane.append(para('새 배치에 쓸 플롯 장치를 선택하십시오.'), radio('wz-printer', PRINTERS, s.printer, (v) => (s.printer = v)));
          break;
        case 2:
          pane.append(
            para('배치에 쓸 용지 크기를 선택하십시오.'),
            row('용지 크기', select(PAPERS.map((p) => ({ value: p.key, label: p.label })), s.paper, (v) => (s.paper = v))),
            h('div', {}, h('span', { style: 'color:var(--text-dim)' }, '도면 단위'), radio('wz-units', [{ value: 'mm', label: '밀리미터' }, { value: 'inch', label: '인치' }], s.inch ? 'inch' : 'mm', (v) => (s.inch = v === 'inch'))),
          );
          break;
        case 3:
          pane.append(para('용지에서 도면의 방향을 선택하십시오.'), radio('wz-orient', [{ value: 'P', label: '세로' }, { value: 'L', label: '가로' }], s.landscape ? 'L' : 'P', (v) => (s.landscape = v === 'L')));
          break;
        case 4:
          pane.append(
            para('배치에 쓸 제목 블록을 선택하십시오. 블록으로 삽입되며 용지 왼쪽 아래 구석에 놓입니다.'),
            row('제목 블록', select([{ value: '', label: '없음' }, ...ISO_SHEETS.map((x) => ({ value: x.key, label: `ISO ${x.key} 제목 블록` }))], s.title, (v) => (s.title = v))),
            para('유형: 블록(외부 참조는 지원하지 않습니다)'),
          );
          break;
        case 5: {
          const arr = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:6px' }, row('행', num(s.rows, (v) => (s.rows = v))), row('열', num(s.cols, (v) => (s.cols = v))), row('행 사이 간격', num(s.rowGap, (v) => (s.rowGap = v))), row('열 사이 간격', num(s.colGap, (v) => (s.colGap = v))));
          pane.append(
            para('배치에 추가할 뷰포트의 종류, 축척, 배열이면 행·열 수와 간격을 지정하십시오.'),
            radio(
              'wz-vp',
              [
                { value: 'none', label: '없음' },
                { value: 'single', label: '단일' },
                { value: 'std', label: '표준 3D 엔지니어링 뷰(2D 도면이라 평면 뷰 넷)' },
                { value: 'array', label: '배열' },
              ],
              s.vpMode,
              (v) => (s.vpMode = v as WizardState['vpMode']),
            ),
            row('뷰포트 축척', select(VP_SCALES.map((x) => ({ value: x, label: x === 'fit' ? '맞춤' : x })), s.vpScale, (v) => (s.vpScale = v))),
            arr,
          );
          break;
        }
        case 6: {
          const c = h('input', { type: 'checkbox' }) as HTMLInputElement;
          c.checked = s.pick;
          c.addEventListener('change', () => (s.pick = c.checked));
          pane.append(para('배치에서 두 점을 골라 뷰포트 위치를 정하려면 "위치 선택"을 켜십시오. 끄면 인쇄 가능 영역(제목 블록이 있으면 그 도면 영역)에 맞춥니다.'), h('label', { class: 'form-row check' }, h('span', {}, '위치 선택(마친 뒤 배치에서 지정)'), c));
          break;
        }
        default: {
          const p = PAPERS.find((x) => x.key === s.paper);
          pane.append(
            para('새 배치를 만들 준비가 되었습니다. 마침을 누르면 배치를 만들고 그 배치로 전환합니다. 페이지 설정은 PAGESETUP으로 나중에 바꿀 수 있습니다.'),
            h(
              'ul',
              { style: 'margin:0;padding-left:18px;line-height:1.7' },
              h('li', {}, `이름: ${s.name}`),
              h('li', {}, `플롯 장치: ${PRINTERS.find((x) => x.value === s.printer)?.label ?? s.printer}`),
              h('li', {}, `용지: ${p?.label ?? s.paper}, ${s.landscape ? '가로' : '세로'}, ${s.inch ? '인치' : '밀리미터'}`),
              h('li', {}, `제목 블록: ${s.title ? `ISO ${s.title}` : '없음'}`),
              h('li', {}, `뷰포트: ${{ none: '없음', single: '단일', std: '표준 엔지니어링(2×2)', array: `배열 ${s.rows}×${s.cols}` }[s.vpMode]}, 축척 ${s.vpScale === 'fit' ? '맞춤' : s.vpScale}${s.pick ? ', 위치는 배치에서 지정' : ''}`),
            ),
          );
        }
      }
      pane.append(err);
      const btns = back.querySelectorAll<HTMLButtonElement>('footer .btn');
      if (btns[0]) btns[0].disabled = step === 0;
      if (btns[1]) btns[1].textContent = step === STEPS.length - 1 ? '마침' : '다음 >';
      const title = back.querySelector('header');
      if (title?.firstChild) title.firstChild.textContent = `배치 작성 - ${STEPS[step]}`;
    };
    const check = (): string | null => {
      if (step === 0) {
        const n = s.name.trim();
        if (!n) return '배치 이름을 입력하십시오.';
        if (/[<>/\\":;?*|,=`]/.test(n)) return '배치 이름에 쓸 수 없는 문자가 있습니다.';
        if (st.doc.layouts.some((l) => l.name.toUpperCase() === n.toUpperCase())) return `배치 "${n}"이(가) 이미 있습니다.`;
      }
      if (step === 5 && s.vpMode === 'array' && !(Number.isInteger(s.rows) && Number.isInteger(s.cols) && s.rows >= 1 && s.cols >= 1 && s.rows <= 20 && s.cols <= 20 && s.rowGap >= 0 && s.colGap >= 0)) return '행·열은 1~20의 정수, 간격은 0 이상이어야 합니다.';
      return null;
    };
    const back = dialog('배치 작성 - 시작', body, [
      {
        label: '< 뒤로',
        run: () => {
          if (step > 0) step--;
          render();
          return true;
        },
      },
      {
        label: '다음 >',
        primary: true,
        run: () => {
          const e = check();
          if (e) {
            err.textContent = e;
            return true;
          }
          if (step < STEPS.length - 1) {
            step++;
            render();
            return true;
          }
          done = true;
          s.name = s.name.trim();
          resolve(s);
          return false;
        },
      },
      { label: '취소' },
    ]);
    render();
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

/** 마법사가 만든 배치에서 뷰포트 위치를 고르는 중(공간을 바꾸면 명령이 끝나 다시 시작한다) */
let pendingPick: { st: DocState; key: string; s: WizardState } | null = null;

/** 뷰포트 사각형들(용지 단위) */
function wizardRects(s: WizardState, area: Rect): Rect[] {
  if (s.vpMode === 'none') return [];
  if (s.vpMode === 'single') return [area];
  if (s.vpMode === 'std') {
    const g = Math.min(area[2] - area[0], area[3] - area[1]) * 0.02;
    return viewportGrid(area, 2, 2, g, g);
  }
  return viewportGrid(area, s.cols, s.rows, s.colGap, s.rowGap);
}

function wizardViewports(st: DocState, s: WizardState, area: Rect, firstId: number, owner: string | undefined, paperMm: number): ViewportEntity[] {
  const bounds = st.scenes.get(MODEL_SPACE)?.bounds ?? null;
  const scale = vpScale(st, s.vpScale, paperMm);
  let id = firstId;
  return wizardRects(s, area).map((r) => newViewport(r, { handle: st.session.newHandle(), owner, id: id++, bounds, scale }));
}

async function layoutWizard(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  // 배치를 만든 뒤 다시 시작한 경우: 뷰포트 위치를 받는다
  if (pendingPick && pendingPick.st === st && st.space === pendingPick.key) {
    const { key, s } = pendingPick;
    pendingPick = null;
    const pr = paperRects(st, key);
    const area = await askRect(ctx, '첫 번째 구석 지정:', titleAreas.get(key) ?? pr?.printable ?? null);
    if (!area || !pr) return;
    const owner = st.doc.blocks.get(key)?.recordHandle;
    const first = Math.max(1, ...layoutVps(st, key).map((v) => v.id)) + 1;
    const vps = wizardViewports(st, s, area, first, owner, pr.mmPerUnit);
    if (!vps.length) {
      ctx.print('간격이 너무 커서 뷰포트를 만들 수 없습니다.', 'err');
      return;
    }
    st.session.commit({ label: 'LAYOUTWIZARD', ops: vps.map((entity): EditOp => ({ kind: 'add', block: key, entity })), group: ctx.group });
    ctx.print(`뷰포트 ${vps.length}개를 만들었습니다.`);
    return;
  }
  pendingPick = null;
  if (st.blockEdit) {
    ctx.print('블록 편집기에서는 쓸 수 없습니다.', 'err');
    return;
  }
  const s = await runWizard(st);
  if (!s) return;
  await app.edits.flush(st);
  // 페이지 설정
  const paper = PAPERS.find((x) => x.key === s.paper) ?? PAPERS[1]!;
  const w = s.landscape ? paper.h : paper.w;
  const hgt = s.landscape ? paper.w : paper.h;
  const plot: PlotSettings = { ...defaultPlot(st), printerName: s.printer, paperName: mediaName(paper.key, w, hgt), paperWidth: w, paperHeight: hgt, paperUnits: s.inch ? 0 : 1, rotation: 0, plotType: 5, scaleNumerator: 1, scaleDenominator: 1 };
  // ISO 용지는 full bleed(여백 없음) 매체 이름이라 여백을 0으로, 장치 없음도 0
  if (s.printer === 'none_device' || /^A\d$/.test(paper.key)) plot.margins = [0, 0, 0, 0];
  // 용지 영역(배치 좌표, 왼쪽 아래 = 인쇄 여백만큼 음수)
  const unit = s.inch ? 25.4 : 1;
  const m = plot.margins.map((v) => v / unit);
  const paperRect: Rect = [-m[0]!, -m[1]!, w / unit - m[0]!, hgt / unit - m[1]!];
  const printable: Rect = [0, 0, w / unit - m[0]! - m[2]!, hgt / unit - m[1]! - m[3]!];
  const ents: Entity[] = [];
  const overall = newViewport(paperRect, { handle: st.session.newHandle(), id: 1 });
  overall.status = 1;
  overall.viewCenter = { x: overall.center.x, y: overall.center.y };
  overall.viewHeight = overall.height;
  ents.push(overall);
  let area: Rect = printable;
  const sheet = s.title ? isoSheet(s.title, s.landscape) : null;
  const at: Vec2 = { x: paperRect[0], y: paperRect[1] };
  if (sheet) area = offsetRect(sheet.area, at, 1 / unit);
  if (!s.pick) ents.push(...wizardViewports(st, s, area, 2, undefined, unit));
  const { ops, layout } = createLayoutOps(app, st, s.name, plot, ents);
  const key = tableKey(layout.blockName);
  if (sheet) {
    const t = titleBlockInsert(app, st, sheet, at, 1 / unit, currentProps(app).layer, layout.blockRecord);
    ops.unshift(...t.ops);
    ops.push({ kind: 'add', block: key, entity: t.insert });
    titleAreas.set(key, area);
  }
  st.session.commit({ label: 'LAYOUTWIZARD', ops, group: ctx.group });
  ctx.print(`배치 "${s.name}"을(를) 만들었습니다(${PAPERS.find((x) => x.key === s.paper)?.label ?? s.paper}, ${s.landscape ? '가로' : '세로'}${sheet ? `, ISO ${sheet.key} 제목 블록` : ''}).`);
  if (s.pick && s.vpMode !== 'none') pendingPick = { st, key, s };
  // 공간을 바꾸면 이 명령은 끝난다. 위치 선택이면 새 배치에서 다시 시작해 두 점을 받는다
  await app.setSpace(layout.blockName);
  if (pendingPick) void app.run('LAYOUTWIZARD');
}

export function registerFileLayoutCommands(app: App, reg: (c: Command) => void): void {
  reg({ name: 'MVSETUP', title: '뷰 설정(MVSETUP)', run: (ctx) => mvsetup(app, ctx) });
  reg({ name: 'LAYOUTWIZARD', title: '배치 마법사', run: (ctx) => layoutWizard(app, ctx) });
}
