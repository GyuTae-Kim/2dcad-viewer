/**
 * 명령 흐름 시험용 가짜 App: 문서·편집 세션은 진짜(DocState·EditSession), 화면·입력은 흉내.
 * 입력은 App.onInput처럼 해석한다 — '' = Enter, 키워드(열쇠·이름), 숫자(preferNumber), "x,y" 점, 그 밖의 글(allowText).
 * { click: [x, y] }는 마우스를 그 점에 올려 미리보기(ghost)를 부른 뒤 누른 것, { pick }은 객체 고르기, { sel }은 선택 결과.
 */
import type { CadDocument, Entity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import type { App, Command, CommandContext, Keyword, PointResult } from '../../src/app/app';
import { DocState } from '../../src/app/docstate';
import { parsePointInput } from '../../src/app/commandline';
import { EditSession } from '../../src/edit/session';
import { entityPath } from '../../src/edit/geom/path';
import { pathNearest } from '../../src/edit/geom/curve';
import { boundsOf } from '../../src/edit/geom/query';
import { newDoc } from '../edit/make';
import { type CommitHook, type DblClickHandler, type EntityClickHandler, type GripMenuProvider, type InputFilter, type PointFilter, bindCommitHooks } from '../../src/app/hooks';

export type Input = string | { click: [number, number]; snap?: string } | { pick: string; at: [number, number] } | { sel: string[] };

export interface Harness {
  app: App;
  st: DocState;
  doc: CadDocument;
  printed: string[];
  prompts: string[];
  ghosts: number;
  /** 누를 때마다 부른 미리보기의 형상 수(빈 미리보기 = 0) */
  ghostSizes: number[];
  add(e: Entity): Entity;
  run(name: string, inputs: Input[]): Promise<void>;
}

/** 객체까지 거리(곡선은 경로, 그 밖은 범위 상자) */
function distanceTo(doc: CadDocument, e: Entity, x: number, y: number): number {
  const p = entityPath(e);
  if (p && p.pieces.length) return pathNearest(p, { x, y }).d;
  const b = boundsOf([e], doc);
  if (!b) return Infinity;
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dy = Math.max(b.minY - y, 0, y - b.maxY);
  return Math.hypot(dx, dy);
}

export function makeHarness(setup?: (doc: CadDocument) => void): Harness {
  const doc = newDoc();
  doc.header.set('$CLAYER', '0');
  setup?.(doc);
  const st = new DocState(1, doc, 't.dxf', 0, 0);
  const commands = new Map<string, Command>();
  const printed: string[] = [];
  const prompts: string[] = [];
  const lastCreated: string[] = [];
  st.session = new EditSession(doc, (tx) => {
    for (const op of tx.ops) if (op.kind === 'add') lastCreated.push(op.entity.handle);
  });
  const picker = {
    pick(x: number, y: number, tol: number): string | null {
      let best: string | null = null;
      let bd = Infinity;
      for (const e of doc.blocks.get(MODEL_SPACE)!.entities) {
        const d = distanceTo(doc, e, x, y);
        if (d <= tol && d < bd) {
          bd = d;
          best = e.handle;
        }
      }
      return best;
    },
    candidates(x: number, y: number, r: number) {
      return doc.blocks
        .get(MODEL_SPACE)!
        .entities.filter((e) => distanceTo(doc, e, x, y) <= r)
        .map((e) => ({ handle: e.handle }));
    },
    geometry: () => ({ segs: [0, 0, 1, 1] }),
    geometryOf: (list: Entity[]) => ({ segs: list.length ? [0, 0, 1, 1] : [] }),
    box(h: string) {
      const e = doc.entityIndex.get(h);
      const b = e ? boundsOf([e], doc) : null;
      return b ? { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY } : undefined;
    },
  };
  const overlay = { pickbox: 5, snap: null as null | { p: { x: number; y: number }; kind: string }, ghost: [] as unknown[] };
  const app = {
    active: st,
    docs: [st],
    commands,
    lastCreated,
    lastSelection: [] as string[],
    register(c: Command) {
      commands.set(c.name.toUpperCase(), c);
    },
    picker: () => picker,
    view: { overlay, pixelSize: () => 0.02, requestOverlay() {}, requestRender() {} },
    cmd: { print: (t: string) => printed.push(t), acceptSpaces: false },
    ui: { setBusy() {} },
    clearSelection() {
      st.selection.clear();
    },
    setSelection() {},
    refreshSelectionOverlay() {},
    // App의 확장 지점(src/app/hooks.ts)
    pointFilters: [] as PointFilter[],
    inputFilters: [] as InputFilter[],
    entityClickHandlers: [] as EntityClickHandler[],
    dblClickHandlers: [] as DblClickHandler[],
    gripMenuProviders: [] as GripMenuProvider[],
    commitHooks: [] as CommitHook[],
    dragPreviewMode: null,
  } as unknown as App;
  // App.addDocument처럼 편집 세션을 확정 고리에 잇는다
  bindCommitHooks(app, st);

  const h: Harness = {
    app,
    st,
    doc,
    printed,
    prompts,
    ghosts: 0,
    ghostSizes: [],
    add(e: Entity) {
      if (!e.handle) e.handle = st.session.newHandle();
      e.owner = doc.blocks.get(MODEL_SPACE)!.recordHandle;
      st.session.commit({ label: 'TEST', ops: [{ kind: 'add', block: MODEL_SPACE, entity: e }] });
      return doc.entityIndex.get(e.handle)!;
    },
    async run(name: string, inputs: Input[]) {
      const queue = [...inputs];
      const next = (prompt: string): Input => {
        prompts.push(prompt);
        if (!queue.length) throw new Error(`입력이 모자랍니다: ${prompt}`);
        return queue.shift()!;
      };
      const kwOf = (t: string, kws: Keyword[]) => kws.find((k) => k.key.toUpperCase() === t.trim().toUpperCase() || k.label === t.trim());
      const ctx: CommandContext = {
        app,
        print: (t: string) => printed.push(t),
        group: 99,
        async getPoint(prompt, opt = {}) {
          const x = next(prompt);
          if (typeof x === 'string') {
            const t = x.trim();
            if (!t) return { enter: true };
            const kw = kwOf(t, opt.keywords ?? []);
            if (kw) return { keyword: kw.key };
            if (opt.preferNumber && /^-?[\d.]+(?:e-?\d+)?$/i.test(t)) return { text: t };
            const p = parsePointInput(t, opt.base ?? null, null);
            if (p) return { point: p, snap: null };
            if (opt.allowText || opt.preferNumber) return { text: t };
            throw new Error(`점이 아닌 입력: ${t} (${prompt})`);
          }
          if ('click' in x) {
            const p = { x: x.click[0], y: x.click[1] };
            overlay.snap = x.snap ? { p, kind: x.snap } : null;
            if (opt.ghost) {
              const g = opt.ghost(p);
              h.ghosts++;
              h.ghostSizes.push(g.reduce((n, x) => n + x.segs.length, 0));
            }
            const r: PointResult = { point: p, snap: x.snap ? { kind: x.snap as never } : null };
            overlay.snap = null;
            return r;
          }
          throw new Error(`점 프롬프트에 맞지 않는 입력 (${prompt})`);
        },
        async getEntity(prompt, kws = []) {
          const x = next(prompt);
          if (typeof x === 'string') {
            if (!x.trim()) return { enter: true };
            const kw = kwOf(x, kws);
            if (kw) return { keyword: kw.key };
            throw new Error(`객체 프롬프트에 글: ${x} (${prompt})`);
          }
          if ('pick' in x) return { handle: x.pick, point: { x: x.at[0], y: x.at[1] } };
          throw new Error(`객체 프롬프트에 맞지 않는 입력 (${prompt})`);
        },
        async getSelection(prompt = '객체 선택:', opt = {}) {
          const x = next(prompt);
          if (typeof x === 'string') {
            const kw = kwOf(x, opt.keywords ?? []);
            if (kw) return Promise.reject(Object.assign(new Error('keyword'), { keyword: kw.key }));
            return [];
          }
          if ('sel' in x) return x.sel;
          throw new Error(`선택 프롬프트에 맞지 않는 입력 (${prompt})`);
        },
      };
      const c = commands.get(name.toUpperCase());
      if (!c) throw new Error(`명령 없음: ${name}`);
      await c.run(ctx);
      if (queue.length) throw new Error(`남은 입력 ${queue.length}개: ${JSON.stringify(queue)}`);
    },
  };
  return h;
}

/** 모형 공간의 객체(종류별) */
export function modelEntities<T extends Entity['type']>(doc: CadDocument, type: T): Extract<Entity, { type: T }>[] {
  return doc.blocks.get(MODEL_SPACE)!.entities.filter((e): e is Extract<Entity, { type: T }> => e.type === type);
}
