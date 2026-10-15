/**
 * 모형 타일 뷰포트: VPORTS(뷰포트 대화상자), -VPORTS(명령행).
 * 구성은 뷰포트 표의 *Active 레코드들(첫 레코드가 활성)이고, 이름 있는 구성은 같은 이름의 레코드 묶음이다.
 * 화면의 타일 상태(DocState.tiles)는 언제나 표에서 다시 만든다(열 때, 명령 뒤, 명령 취소 뒤).
 * 배치에서는 AutoCAD처럼 배치 뷰포트(MVIEW)를 만든다. 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { VPortRecord } from '../core/model';
import { MODEL_SPACE } from '../core/model';
import type { EditOp } from '../edit/session';
import type { App, CommandContext } from './app';
import type { Camera, DocState, Tile, TileSet } from './docstate';
import { form } from './ui/dom';
import { type R, type Split, joinRects, splitRect } from './tilelayout';


const ACTIVE = '*ACTIVE';
const EPS = 1e-6;

const isActive = (v: VPortRecord) => v.name.toUpperCase() === ACTIVE;

/** 표의 *Active 레코드들(표 순서, 첫째가 활성) */
export function activeRecords(st: DocState): VPortRecord[] {
  return st.doc.vports.filter(isActive);
}

/** 레코드 → 카메라(화면 영역 높이 hPx) */
function camOf(v: VPortRecord, hPx: number): Camera | null {
  if (!(v.height > 0) || !Number.isFinite(v.center.x) || !Number.isFinite(v.center.y)) return null;
  return { cx: v.center.x + (v.viewTarget?.x ?? 0), cy: v.center.y + (v.viewTarget?.y ?? 0), scale: Math.max(1e-12, hPx / v.height) };
}

/** 표에서 타일 상태를 다시 만든다. 활성 레코드가 하나 이하면 타일 없음 */
export function applyTilesFromDoc(app: App, st: DocState): void {
  const recs = activeRecords(st);
  const v = app.view;
  if (recs.length <= 1) {
    // 타일을 거두면 남은 *Active의 뷰로
    if (st.tiles && recs[0]) {
      const cam = camOf(recs[0], v.height);
      if (cam) st.cameras.set(MODEL_SPACE, cam);
    }
    st.tiles = null;
    v.requestRender();
    v.requestOverlay();
    return;
  }
  const list: Tile[] = recs.map((r) => {
    const ll = { x: clamp01(r.lowerLeft.x), y: clamp01(r.lowerLeft.y) };
    const ur = { x: clamp01(r.upperRight.x), y: clamp01(r.upperRight.y) };
    return { ll, ur, cam: camOf(r, Math.max(1, (ur.y - ll.y) * v.height)), prev: [] };
  });
  const tiles: TileSet = { list, active: 0 };
  st.tiles = tiles;
  const first = list[0]!;
  if (first.cam) st.cameras.set(MODEL_SPACE, { ...first.cam });
  st.prevCameras.set(MODEL_SPACE, []);
  v.requestRender();
  v.requestOverlay();
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** 지금 화면 상태로 *Active 레코드들을 만든다(카메라·타일 배치) */
function currentActives(app: App, st: DocState, layout?: { rects: R[]; cams: (Camera | null)[] }): VPortRecord[] {
  const v = app.view;
  const old = activeRecords(st);
  const template = old[0];
  // 활성 타일이 첫 레코드(AutoCAD는 첫 *Active를 현재 뷰포트로 연다)
  const order = st.tiles && !layout ? [st.tiles.active, ...st.tiles.list.map((_, i) => i).filter((i) => i !== st.tiles!.active)] : null;
  const rects: R[] = layout?.rects ?? (st.tiles ? order!.map((i) => st.tiles!.list[i]!).map((t) => ({ x0: t.ll.x, y0: t.ll.y, x1: t.ur.x, y1: t.ur.y })) : [{ x0: 0, y0: 0, x1: 1, y1: 1 }]);
  const cams: (Camera | null)[] =
    layout?.cams ?? (st.tiles ? order!.map((i) => (i === st.tiles!.active ? (st.cameras.get(MODEL_SPACE) ?? null) : st.tiles!.list[i]!.cam)) : [st.cameras.get(MODEL_SPACE) ?? null]);
  return rects.map((r, i) => {
    const base = old[i] ?? template;
    const cam = cams[i] ?? cams[0] ?? { cx: 0, cy: 0, scale: 1 };
    const wPx = Math.max(1, (r.x1 - r.x0) * v.width);
    const hPx = Math.max(1, (r.y1 - r.y0) * v.height);
    const target = base?.viewTarget ?? { x: 0, y: 0, z: 0 };
    return {
      name: '*Active',
      handle: old[i]?.handle ?? st.session.newHandle(),
      flags: base?.flags ?? 0,
      lowerLeft: { x: r.x0, y: r.y0 },
      upperRight: { x: r.x1, y: r.y1 },
      center: { x: cam.cx - target.x, y: cam.cy - target.y },
      snapBase: base?.snapBase ?? { x: 0, y: 0 },
      snapSpacing: base?.snapSpacing ?? { x: 10, y: 10 },
      gridSpacing: base?.gridSpacing ?? { x: 10, y: 10 },
      viewDirection: base?.viewDirection ?? { x: 0, y: 0, z: 1 },
      viewTarget: { ...target },
      height: hPx / cam.scale,
      aspect: wPx / hPx,
      lensLength: base?.lensLength ?? 50,
      twist: base?.twist ?? 0,
      // 등각투영 설정(SNAPSTYL·SNAPISOPAIR)은 뷰포트 레코드에 저장한다(viewtools-iso.ts)
      ...(base?.snapStyle !== undefined ? { snapStyle: base.snapStyle } : {}),
      ...(base?.snapIsoPair !== undefined ? { snapIsoPair: base.snapIsoPair } : {}),
      ...(base?.xdata ? { xdata: base.xdata } : {}),
    };
  });
}

/** 표 전체를 바꾸는 편집(이름 있는 구성은 그대로, *Active만 바꾼다) */
function replaceActives(st: DocState, actives: VPortRecord[]): EditOp {
  const before = st.doc.vports.slice();
  const named = before.filter((v) => !isActive(v));
  return { kind: 'vports', before, after: [...actives, ...named] };
}

/**
 * 저장 직전: *Active 레코드들의 뷰를 지금 화면으로 맞춘다(명령 취소 기록 없이 문서와 워커에 바로).
 * 여는 쪽에서 같은 화면·타일로 열린다.
 */
export function syncActiveVports(app: App, st: DocState): void {
  if (st.space !== MODEL_SPACE && !st.tiles && !st.cameras.get(MODEL_SPACE)) return;
  const op = replaceActives(st, currentActives(app, st));
  st.doc.vports.splice(0, st.doc.vports.length, ...(op as Extract<EditOp, { kind: 'vports' }>).after);
  app.engine.edit(st.docId, [op]);
}

// ---------------------------------------------------------------------------
// 나누기·합치기
// ---------------------------------------------------------------------------

/** 지금 타일 배치(사각형·카메라, 활성이 첫째) */
function currentLayout(app: App, st: DocState): { rects: R[]; cams: (Camera | null)[]; active: number } {
  const cam = st.cameras.get(MODEL_SPACE) ?? app.view.camera();
  if (!st.tiles) return { rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }], cams: [cam], active: 0 };
  return {
    rects: st.tiles.list.map((t) => ({ x0: t.ll.x, y0: t.ll.y, x1: t.ur.x, y1: t.ur.y })),
    cams: st.tiles.list.map((t, i) => (i === st.tiles!.active ? cam : t.cam)),
    active: st.tiles.active,
  };
}

/** 같은 뷰 높이를 유지하며 영역 높이에 맞춘 카메라 */
function keepHeight(cam: Camera, fromH: number, toH: number): Camera {
  return { ...cam, scale: cam.scale * (toH / Math.max(EPS, fromH)) };
}

/** 활성(또는 전체) 영역을 나눈 새 배치 */
function splitLayout(app: App, st: DocState, k: Split, apply: 'current' | 'display'): { rects: R[]; cams: (Camera | null)[] } {
  const cur = currentLayout(app, st);
  const target = apply === 'display' ? { x0: 0, y0: 0, x1: 1, y1: 1 } : cur.rects[cur.active]!;
  const cam = cur.cams[cur.active] ?? app.view.camera();
  const parts = splitRect(target, k);
  const fromH = target.y1 - target.y0;
  const rects: R[] = [...parts];
  const cams: (Camera | null)[] = parts.map((p) => keepHeight(cam, fromH, p.y1 - p.y0));
  if (apply === 'current')
    cur.rects.forEach((r, i) => {
      if (i === cur.active) return;
      rects.push(r);
      cams.push(cur.cams[i] ?? null);
    });
  return { rects, cams };
}

function commitLayout(app: App, st: DocState, ctx: CommandContext | null, layout: { rects: R[]; cams: (Camera | null)[] }, label = 'VPORTS'): void {
  const actives = currentActives(app, st, layout);
  // 하나뿐이면 *Active 레코드 하나(전체 화면)
  st.session.commit({ label, ops: [replaceActives(st, actives)], group: ctx?.group });
}

// ---------------------------------------------------------------------------
// 명령
// ---------------------------------------------------------------------------

const SPLITS: { key: Split; label: string }[] = [
  { key: 'SI', label: '하나' },
  { key: '2V', label: '둘: 수직' },
  { key: '2H', label: '둘: 수평' },
  { key: '3R', label: '셋: 오른쪽' },
  { key: '3L', label: '셋: 왼쪽' },
  { key: '3A', label: '셋: 위' },
  { key: '3B', label: '셋: 아래' },
  { key: '3V', label: '셋: 수직' },
  { key: '3H', label: '셋: 수평' },
  { key: '4', label: '넷: 동일' },
];

/** 이름 있는 구성 이름들 */
function namedConfigs(st: DocState): string[] {
  const names = new Map<string, string>();
  for (const v of st.doc.vports) if (!isActive(v) && v.name) names.set(v.name.toUpperCase(), v.name);
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

function saveNamed(app: App, st: DocState, ctx: CommandContext, name: string): void {
  const actives = currentActives(app, st);
  const before = st.doc.vports.slice();
  const others = before.filter((v) => v.name.toUpperCase() !== name.toUpperCase());
  const saved = actives.map((v) => ({ ...v, name, handle: st.session.newHandle() }));
  st.session.commit({ label: 'VPORTS', ops: [{ kind: 'vports', before, after: [...others, ...saved] }], group: ctx.group });
}

function restoreNamed(app: App, st: DocState, ctx: CommandContext, name: string): boolean {
  const recs = st.doc.vports.filter((v) => v.name.toUpperCase() === name.toUpperCase());
  if (!recs.length) return false;
  const old = activeRecords(st);
  const actives = recs.map((v, i) => ({ ...v, name: '*Active', handle: old[i]?.handle ?? st.session.newHandle() }));
  st.session.commit({ label: 'VPORTS', ops: [replaceActives(st, actives)], group: ctx.group });
  void app;
  return true;
}

function deleteNamed(st: DocState, ctx: CommandContext, name: string): boolean {
  const before = st.doc.vports.slice();
  const after = before.filter((v) => v.name.toUpperCase() !== name.toUpperCase() || isActive(v));
  if (after.length === before.length) return false;
  st.session.commit({ label: 'VPORTS', ops: [{ kind: 'vports', before, after }], group: ctx.group });
  return true;
}

const NAME_BAD = /[<>/\\":;?*|,=`]/;

export function registerVportCommands(app: App): void {
  // 명령 취소·다시 실행·다른 편집으로 표가 바뀌면 타일을 다시 만든다
  app.onVportsChanged = (st) => applyTilesFromDoc(app, st);

  app.register({
    name: '-VPORTS',
    title: '타일 뷰포트(명령행)',
    async run(ctx, arg) {
      const st = app.active!;
      if (st.onLayout && !st.msVp) {
        // 배치에서는 배치 뷰포트를 만든다
        await app.run('MVIEW');
        return;
      }
      // 리본에서 '-VPORTS 3 R'처럼 옵션을 함께 넘길 수 있다
      const toks = (arg ?? '').trim().toUpperCase().split(/\s+/).filter(Boolean);
      const n = activeRecords(st).length || 1;
      ctx.print(`현재 구성의 뷰포트 수: ${st.tiles?.list.length ?? n}`);
      const r = toks.length ? { text: toks[0]! } : await ctx.getPoint('옵션 입력 [저장(S)/복원(R)/삭제(D)/결합(J)/단일(SI)/?/2/3/4] <3>:', {
        allowText: true,
        keywords: [
          { key: 'S', label: '저장' },
          { key: 'R', label: '복원' },
          { key: 'D', label: '삭제' },
          { key: 'J', label: '결합' },
          { key: 'SI', label: '단일' },
          { key: '?', label: '?' },
          { key: '2', label: '2' },
          { key: '3', label: '3' },
          { key: '4', label: '4' },
        ],
      });
      let k = 'enter' in r ? '3' : 'keyword' in r ? r.keyword : 'text' in r ? r.text.trim().toUpperCase() : '';
      if (k === '?') {
        const names = namedConfigs(st);
        const q = await ctx.getPoint('나열할 뷰포트 구성의 이름 입력 <*>:', { allowText: true });
        const pat = 'text' in q && q.text.trim() ? q.text.trim().toUpperCase() : '*';
        const re = new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
        ctx.print('현재 구성:');
        for (const v of activeRecords(st)) ctx.print(`  ${fmtRect(v)}`);
        for (const name of names.filter((x) => re.test(x))) {
          ctx.print(`구성 ${name}:`);
          for (const v of st.doc.vports.filter((x) => x.name.toUpperCase() === name.toUpperCase())) ctx.print(`  ${fmtRect(v)}`);
        }
        return;
      }
      if (k === 'S' || k === 'R' || k === 'D') {
        const verb = k === 'S' ? '저장할' : k === 'R' ? '복원할' : '삭제할';
        const q = await ctx.getPoint(`${verb} 뷰포트 구성의 이름 입력 또는 [?]:`, { allowText: true });
        if (!('text' in q)) return;
        const name = q.text.trim();
        if (!name) return;
        if (name === '?') {
          ctx.print(namedConfigs(st).join(', ') || '이름 있는 뷰포트 구성이 없습니다.');
          return;
        }
        if (k === 'S') {
          if (NAME_BAD.test(name) || name.toUpperCase() === ACTIVE) {
            ctx.print('이름이 올바르지 않습니다.', 'err');
            return;
          }
          saveNamed(app, st, ctx, name);
          ctx.print(`뷰포트 구성 ${name}을(를) 저장했습니다.`);
        } else if (k === 'R') {
          if (!restoreNamed(app, st, ctx, name)) ctx.print(`뷰포트 구성 ${name}을(를) 찾을 수 없습니다.`, 'err');
        } else if (!deleteNamed(st, ctx, name)) ctx.print(`뷰포트 구성 ${name}을(를) 찾을 수 없습니다.`, 'err');
        return;
      }
      if (k === 'J') {
        if (!st.tiles) {
          ctx.print('결합할 뷰포트가 없습니다.', 'err');
          return;
        }
        const t = st.tiles;
        const dom = await pickTile(app, ctx, '주 뷰포트 선택 <현재 뷰포트>:', t.active);
        if (dom < 0) return;
        const other = await pickTile(app, ctx, '결합할 뷰포트 선택:', -1);
        if (other < 0 || other === dom) return;
        const cur = currentLayout(app, st);
        const joined = joinRects(cur.rects[dom]!, cur.rects[other]!);
        if (!joined) {
          ctx.print('결합된 뷰포트가 직사각형이 아닙니다.', 'err');
          return;
        }
        const domCam = cur.cams[dom] ?? app.view.camera();
        const rects: R[] = [joined];
        const cams: (Camera | null)[] = [keepHeight(domCam, cur.rects[dom]!.y1 - cur.rects[dom]!.y0, joined.y1 - joined.y0)];
        cur.rects.forEach((rr, i) => {
          if (i === dom || i === other) return;
          rects.push(rr);
          cams.push(cur.cams[i] ?? null);
        });
        commitLayout(app, st, ctx, { rects, cams });
        return;
      }
      let split: Split | null = null;
      if (k === 'SI') split = 'SI';
      else if (k === '2') {
        const q = toks[1] ? { keyword: toks[1] } : await ctx.getPoint('구성 입력 [수평(H)/수직(V)] <수직>:', {
          keywords: [
            { key: 'H', label: '수평' },
            { key: 'V', label: '수직' },
          ],
        });
        split = 'keyword' in q && q.keyword === 'H' ? '2H' : '2V';
      } else if (k === '3') {
        const q = toks[1] ? { keyword: toks[1] } : await ctx.getPoint('구성 입력 [수평(H)/수직(V)/위(A)/아래(B)/왼쪽(L)/오른쪽(R)] <오른쪽>:', {
          keywords: [
            { key: 'H', label: '수평' },
            { key: 'V', label: '수직' },
            { key: 'A', label: '위' },
            { key: 'B', label: '아래' },
            { key: 'L', label: '왼쪽' },
            { key: 'R', label: '오른쪽' },
          ],
        });
        split = ('3' + ('keyword' in q ? q.keyword : 'R')) as Split;
      } else if (k === '4') split = '4';
      if (!split) {
        ctx.print('옵션을 입력하십시오.', 'err');
        return;
      }
      if (split === 'SI') {
        const cur = currentLayout(app, st);
        const r0 = cur.rects[cur.active]!;
        commitLayout(app, st, ctx, { rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }], cams: [keepHeight(cur.cams[cur.active] ?? app.view.camera(), r0.y1 - r0.y0, 1)] });
        return;
      }
      commitLayout(app, st, ctx, splitLayout(app, st, split, 'current'));
    },
  });

  app.register({
    name: 'VPORTS',
    title: '뷰포트',
    async run(ctx) {
      const st = app.active!;
      if (st.onLayout && !st.msVp) {
        await app.run('MVIEW');
        return;
      }
      const names = namedConfigs(st);
      const v = await form('뷰포트', [
        { key: 'name', label: '새 이름(저장할 때만)', type: 'text', value: '' },
        { key: 'std', label: '표준 뷰포트', type: 'select', value: st.tiles ? 'keep' : '2V', options: [{ value: 'keep', label: '*현재 구성*' }, ...SPLITS.map((s) => ({ value: s.key, label: s.label })), ...names.map((n) => ({ value: `name:${n}`, label: `이름 있는 구성: ${n}` }))] },
        {
          key: 'apply',
          label: '적용 위치',
          type: 'select',
          value: 'display',
          options: [
            { value: 'display', label: '화면 표시' },
            { value: 'current', label: '현재 뷰포트' },
          ],
        },
      ]);
      if (!v) return;
      const std = String(v.std);
      if (std.startsWith('name:')) restoreNamed(app, st, ctx, std.slice(5));
      else if (std !== 'keep') {
        const split = std as Split;
        if (split === 'SI' && v.apply === 'display') {
          const cur = currentLayout(app, st);
          const r0 = cur.rects[cur.active]!;
          commitLayout(app, st, ctx, { rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }], cams: [keepHeight(cur.cams[cur.active] ?? app.view.camera(), r0.y1 - r0.y0, 1)] });
        } else commitLayout(app, st, ctx, splitLayout(app, st, split, v.apply === 'current' ? 'current' : 'display'));
      }
      const name = String(v.name ?? '').trim();
      if (name) {
        if (NAME_BAD.test(name) || name.toUpperCase() === ACTIVE) ctx.print('이름이 올바르지 않습니다.', 'err');
        else {
          saveNamed(app, st, ctx, name);
          ctx.print(`뷰포트 구성 ${name}을(를) 저장했습니다.`);
        }
      }
    },
  });
}

function fmtRect(v: VPortRecord): string {
  const f = (n: number) => n.toFixed(4);
  return `${f(v.lowerLeft.x)},${f(v.lowerLeft.y)}  ${f(v.upperRight.x)},${f(v.upperRight.y)}`;
}

/** 타일을 하나 고른다(뷰포트 안을 누르거나 Enter면 기본값). 없으면 -1 */
async function pickTile(app: App, ctx: CommandContext, prompt: string, def: number): Promise<number> {
  let chosen = -1;
  const v = app.view;
  // 이 동안은 타일을 눌러도 활성으로 바꾸지 않고 그 번호를 받는다
  v.tilePick = (i) => {
    chosen = i;
    app.submitInput('');
  };
  try {
    const r = await ctx.getPoint(prompt, {});
    if (chosen >= 0) return chosen;
    if ('enter' in r) return def;
    return -1;
  } finally {
    v.tilePick = null;
  }
}
