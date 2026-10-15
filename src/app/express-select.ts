/**
 * Express Tools 선택·조회 명령: SSX(같은 특성으로 선택 집합), GETSEL(도면층·유형으로 선택), XLIST(중첩 객체 정보),
 * XDLIST(확장 데이터 보기), NCOPY(중첩 객체 복사), GATTE(전역 속성 편집).
 * 계산은 src/edit/express/*.ts. 바꾸는 명령은 한 번의 명령 취소로 되돌린다.
 */
import type { BlockDef, CadDocument, Entity, InsertEntity } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import { affApply, affTranslate } from '../edit/geom/math';
import { transformEntity } from '../edit/geom/transform';
import { chainXf, invertXf, xfScale } from '../edit/refedit/xform';
import { type Importer, bindMapper, createImporter } from '../edit/refedit/names';
import { attributeAt } from '../edit/textools/attipedit';
import { type SsxFilter, type SsxKey, SSX_LABEL, getselSelect, ssxFilterLines, ssxFilterOf, ssxSelect, ssxSetValue, ssxTypeName, ssxValueText } from '../edit/express/ssx';
import { type NestChain, nestedCopy, xdataApps, xdataLines, xlistRows } from '../edit/express/xlist';
import { gatteChanges, knownTags, referenceName, referencesOf } from '../edit/express/gatte';
import type { EditOp } from '../edit/session';
import type { App, Command, CommandContext } from './app';
import type { DocState } from './docstate';
import { commitResults } from './modify';
import { choose, previewOf, yesNo } from './modify2-util';
import { Picker } from './pick';
import { xrefOfDoc } from './refs';
import { dialog, h } from './ui/dom';
import { askString, pickTolerance, visibleInSpace } from './express-util';
import type { OverlayGeom, Pt } from './view';

// ---------------------------------------------------------------------------
// 중첩 객체 고르기
// ---------------------------------------------------------------------------

type NestItem = { def: BlockDef; insert: InsertEntity; xref?: string };

export interface NestHit {
  entity: Entity;
  chain: NestItem[];
  /** 객체가 들어 있는 문서(외부 참조면 그 도면) */
  doc: CadDocument;
  /** 지금 공간 블록 참조의 속성을 골랐을 때 그 참조 */
  owner?: InsertEntity;
}

function geomDist(g: OverlayGeom, q: Pt): number {
  let best = Infinity;
  const s = g.segs;
  for (let i = 0; i + 3 < s.length; i += 4) {
    const ax = s[i]!;
    const ay = s[i + 1]!;
    const dx = s[i + 2]! - ax;
    const dy = s[i + 3]! - ay;
    const L = dx * dx + dy * dy;
    let t = L > 0 ? ((q.x - ax) * dx + (q.y - ay) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + dx * t - q.x, ay + dy * t - q.y);
    if (d < best) best = d;
  }
  const t = g.tris ?? [];
  for (let i = 0; i + 5 < t.length; i += 6) {
    const [x0, y0, x1, y1, x2, y2] = [t[i]!, t[i + 1]!, t[i + 2]!, t[i + 3]!, t[i + 4]!, t[i + 5]!];
    const d1 = (q.x - x1) * (y0 - y1) - (x0 - x1) * (q.y - y1);
    const d2 = (q.x - x2) * (y1 - y2) - (x1 - x2) * (q.y - y2);
    const d3 = (q.x - x0) * (y2 - y0) - (x2 - x0) * (q.y - y0);
    if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return 0;
  }
  return best;
}

const MAX_NEST = 8;
const MAX_SCAN = 6000;

/** 블록 참조 ins 안에서 점 at(지금 공간 좌표) 아래의 가장 안쪽 객체 */
export function nestedPick(app: App, st: DocState, top: InsertEntity, at: Pt, tol: number): NestHit | null {
  const pickers = new Map<CadDocument, Map<string, Picker>>();
  const pickerFor = (doc: CadDocument, key: string) => {
    let m = pickers.get(doc);
    if (!m) pickers.set(doc, (m = new Map()));
    let p = m.get(key);
    if (!p) m.set(key, (p = new Picker(doc, [], app.text, key)));
    return p;
  };
  const visit = (doc: CadDocument, ins: InsertEntity, chain: NestItem[], depth: number, inXref: string | undefined): NestHit | null => {
    const key = tableKey(ins.block);
    const blk = doc.blocks.get(key);
    if (!blk) return null;
    let defDoc = doc;
    let defKey = key;
    let xname = inXref;
    if (blk.flags & 4) {
      if (inXref) return null;
      const f = xrefOfDoc(doc, key);
      if (!f) return null;
      defDoc = f.doc;
      defKey = MODEL_SPACE;
      xname = blk.name;
    }
    const next: NestItem[] = [...chain, { def: blk, insert: ins, xref: blk.flags & 4 ? blk.name : undefined }];
    const xf = chainXf(next);
    if (typeof xf === 'string') return null;
    const inv = invertXf(xf);
    const def = defDoc.blocks.get(defKey);
    if (!inv || !def) return null;
    const q = affApply(inv.m, at);
    const t = tol / Math.max(1e-12, xfScale(xf));
    const pk = pickerFor(defDoc, defKey);
    let best: Entity | null = null;
    let bestD = Infinity;
    let n = 0;
    const consider = (e: Entity) => {
      const d = geomDist(pk.geometryOf([e]), q);
      if (d <= t && d <= bestD) {
        best = e;
        bestD = d;
      }
    };
    for (const e of def.entities) {
      if (++n > MAX_SCAN) break;
      if (e.type === 'ATTDEF' && !((e as { attFlags?: number }).attFlags! & 2)) continue;
      consider(e);
      if (e.type === 'INSERT') for (const a of e.attribs) consider(a as Entity);
    }
    const found = best as Entity | null;
    if (!found) return null;
    if (found.type === 'INSERT' && depth + 1 < MAX_NEST) {
      const inner = visit(defDoc, found, next, depth + 1, xname);
      if (inner) return inner;
    }
    return { entity: found, chain: next, doc: defDoc };
  };
  return visit(st.doc, top, [], 0, undefined);
}

/** 고른 점의 객체를 중첩 객체로 풀어 준다(블록 참조가 아니면 null) */
async function pickNested(app: App, ctx: CommandContext, prompt: string, keywords: { key: string; label: string }[] = []): Promise<NestHit | { keyword: string } | 'enter' | 'none'> {
  const st = app.active!;
  const r = await ctx.getEntity(prompt, keywords);
  if ('enter' in r) return 'enter';
  if ('keyword' in r) return { keyword: r.keyword };
  const e = st.doc.entityIndex.get(r.handle);
  if (!e || e.type !== 'INSERT') return 'none';
  const tol = pickTolerance(app);
  // 블록 참조 자신의 속성(지금 공간 좌표)
  const pk = app.picker();
  if (pk) for (const a of e.attribs) if (geomDist(pk.geometryOf([a as Entity]), r.point) <= tol) return { entity: a as Entity, chain: [], doc: st.doc, owner: e };
  return nestedPick(app, st, e, r.point, tol) ?? 'none';
}

// ---------------------------------------------------------------------------
// SSX
// ---------------------------------------------------------------------------

const SSX_KEYS: [string, SsxKey | 'F' | 'P'][] = [
  ['B', 'block'],
  ['C', 'color'],
  ['E', 'type'],
  ['F', 'F'],
  ['LA', 'layer'],
  ['LT', 'linetype'],
  ['P', 'P'],
  ['S', 'style'],
  ['T', 'thickness'],
  ['V', 'vector'],
];

async function runSsx(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  let f: SsxFilter = {};
  const pickBase = async (prompt: string): Promise<boolean> => {
    const r = await ctx.getEntity(prompt);
    if (!('handle' in r)) return false;
    const e = st.doc.entityIndex.get(r.handle);
    if (!e) return false;
    f = ssxFilterOf(e);
    return true;
  };
  app.clearSelection();
  await pickBase('객체 선택 <없음>:');
  const show = () => {
    const lines = ssxFilterLines(f);
    ctx.print(lines.length ? `필터: ${lines.join(', ')}` : '필터: (없음 — 모든 객체)');
  };
  for (;;) {
    show();
    const r = await ctx.getPoint('필터 옵션 입력 [블록 이름(B)/색상(C)/객체(E)/플래그(F)/도면층(LA)/선종류(LT)/선택(P)/스타일(S)/두께(T)/벡터(V)]:', {
      keywords: SSX_KEYS.map(([k, v]) => ({ key: k, label: v === 'F' ? '플래그' : v === 'P' ? '선택' : SSX_LABEL[v] })),
    });
    if ('enter' in r) break;
    if (!('keyword' in r)) continue;
    const opt = SSX_KEYS.find(([k]) => k === r.keyword)![1];
    if (opt === 'F') {
      ctx.print('플래그(F) 필터(DXF 그룹 66·70)는 이 웹 버전에서 쓸 수 없습니다. 다른 필터를 쓰십시오.', 'err');
      continue;
    }
    if (opt === 'P') {
      await pickBase('객체 선택:');
      continue;
    }
    const cur = ssxValueText(f, opt);
    const v = await askString(ctx, `>>추가할 ${SSX_LABEL[opt]} 입력${cur ? `(지금 ${cur})` : ''}/<Enter = 필터에서 빼기>:`, '');
    if (typeof v !== 'string') continue;
    const next = ssxSetValue(f, opt, v);
    if (typeof next === 'string') ctx.print(next, 'err');
    else f = next;
  }
  const list = visibleInSpace(st);
  const hs = ssxSelect(list, f);
  app.setSelection(hs, 'replace');
  app.lastSelection = [...hs];
  ctx.print(`${hs.length}개를 찾음. 선택된 객체로 남겨 두었습니다(다음 명령에서 이전(P)으로도 고를 수 있습니다).`);
}

// ---------------------------------------------------------------------------
// GETSEL
// ---------------------------------------------------------------------------

async function runGetsel(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  app.clearSelection();
  const a = await ctx.getEntity('선택할 도면층의 객체 선택 <*>:');
  const layer = 'handle' in a ? (st.doc.entityIndex.get(a.handle)?.layer ?? '*') : '*';
  if ('handle' in a) ctx.print(`도면층 = ${layer}`);
  const b = await ctx.getEntity('선택할 객체 유형의 객체 선택 <*>:');
  const be = 'handle' in b ? st.doc.entityIndex.get(b.handle) : undefined;
  const type = be ? ssxTypeName(be) : '*';
  if (be) ctx.print(`객체 유형 = ${type}`);
  ctx.print('수집 중...');
  const hs = getselSelect(visibleInSpace(st), layer, type);
  app.setSelection(hs, 'replace');
  app.lastSelection = [...hs];
  ctx.print(`${hs.length}개를 찾음(도면층 ${layer}, 유형 ${type}). 다음 명령에서 이전(P)으로 고를 수 있습니다.`);
}

// ---------------------------------------------------------------------------
// XLIST · XDLIST
// ---------------------------------------------------------------------------

async function runXlist(app: App, ctx: CommandContext): Promise<void> {
  for (;;) {
    const r = await pickNested(app, ctx, '나열할 중첩된 외부 참조 또는 블록 객체 선택:');
    if (r === 'enter') return;
    if (r === 'none' || 'keyword' in r) {
      ctx.print('블록·외부 참조 안의 객체를 고르십시오.', 'err');
      continue;
    }
    const rows = xlistRows(r.entity, r.chain);
    if (r.owner) rows[1]!.value = r.owner.block;
    for (const x of rows) ctx.print(`  ${x.label}: ${x.value}`);
    dialog(
      'XLIST',
      h('table', { class: 'grid' }, h('tbody', {}, ...rows.map((x) => h('tr', {}, h('td', { style: 'color:var(--text-dim);width:35%' }, x.label), h('td', {}, x.value))))),
    );
    return;
  }
}

async function runXdlist(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const r = await ctx.getEntity('객체 선택:');
  if (!('handle' in r)) return;
  const e = st.doc.entityIndex.get(r.handle);
  if (!e) return;
  const apps = xdataApps(e.xdata);
  if (!apps.length) {
    ctx.print('객체에 확장 데이터가 없습니다.');
    return;
  }
  ctx.print(`등록된 응용 프로그램: ${apps.join(', ')}`);
  const a = await askString(ctx, '나열할 응용 프로그램 이름 입력 <*>:', '*');
  const pat = typeof a === 'string' ? a : '*';
  const lines = xdataLines(e.xdata, pat);
  if (!lines.length) {
    ctx.print(`"${pat}"에 맞는 응용 프로그램의 확장 데이터가 없습니다.`);
    return;
  }
  for (const l of lines) ctx.print(l);
  dialog('XDLIST', h('pre', { style: 'margin:0;max-height:60vh;overflow:auto;white-space:pre-wrap;font-family:var(--mono)' }, lines.join('\n')));
}

// ---------------------------------------------------------------------------
// NCOPY
// ---------------------------------------------------------------------------

let ncopyMode: 'I' | 'B' = 'I';

async function runNcopy(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const hits: NestHit[] = [];
  const copies: Entity[] = [];
  const importers = new Map<CadDocument, Importer>();
  const importerFor = (src: CadDocument, xrefName: string) => {
    let imp = importers.get(src);
    if (!imp) {
      const map = ncopyMode === 'B' ? bindMapper(doc, xrefName) : (_k: string, n: string) => n;
      imp = createImporter(src, doc, map, () => st.session.newHandle());
      importers.set(src, imp);
    }
    return imp;
  };
  app.clearSelection();
  for (;;) {
    const r = await pickNested(app, ctx, hits.length ? '복사할 중첩된 객체 선택 또는 [설정(S)] <끝>:' : '복사할 중첩된 객체 선택 또는 [설정(S)]:', [{ key: 'S', label: '설정' }]);
    if (r === 'enter') break;
    if (r === 'none') {
      ctx.print('블록·외부 참조 안의 객체를 고르십시오.', 'err');
      continue;
    }
    if ('keyword' in r) {
      if (importers.size) {
        ctx.print('이미 외부 참조 객체를 고른 뒤에는 설정을 바꿀 수 없습니다.', 'err');
        continue;
      }
      const k = await choose(ctx, `중첩된 객체 복사 설정 입력 [삽입(I)/결합(B)] <${ncopyMode === 'I' ? '삽입' : '결합'}>:`, [
        { key: 'I', label: '삽입' },
        { key: 'B', label: '결합' },
      ], ncopyMode);
      ncopyMode = k === 'B' ? 'B' : 'I';
      continue;
    }
    let src: Entity | null = r.entity;
    if (r.doc !== doc) {
      const xname = [...r.chain].reverse().find((c) => c.xref)?.xref ?? 'XREF';
      src = importerFor(r.doc, xname).entity(r.entity);
      if (!src) {
        ctx.print('이 외부 참조 객체는 이 도면으로 옮길 수 없습니다.', 'err');
        continue;
      }
    }
    if (r.entity.type === 'ATTRIB') {
      // 속성은 속성 정의가 아닌 한 줄 문자로 복사한다(AutoCAD와 같다)
      src = { ...structuredClone(src), type: 'TEXT' } as Entity;
      delete (src as { tag?: string }).tag;
      delete (src as { attFlags?: number }).attFlags;
      delete (src as { prompt?: string }).prompt;
    }
    const c = r.chain.length ? nestedCopy(src, r.chain as NestChain, doc) : { ...structuredClone(src), handle: '' };
    if (typeof c === 'string') {
      ctx.print(c, 'err');
      continue;
    }
    hits.push(r);
    copies.push(c);
    ctx.print(`1개 찾음, 총 ${copies.length}개`);
    app.view.overlay.ghost = previewOf(app, copies);
    app.view.requestOverlay();
  }
  if (!copies.length) return;
  const moved = (dx: number, dy: number): Entity[] =>
    copies.map((c) => {
      if (!dx && !dy) return structuredClone(c);
      const r = transformEntity(c, affTranslate(dx, dy), doc);
      return { ...(r.replace?.[0] ?? r.add?.[0] ?? c), handle: '' } as Entity;
    });
  // 이름(도면층·스타일 …)을 먼저 만든다
  const commitImports = () => {
    for (const imp of importers.values()) {
      if (imp.ops.length) st.session.commit({ label: 'NCOPY', ops: imp.ops.splice(0), group: ctx.group });
    }
  };
  let multiple = false;
  const b = await ctx.getPoint('기본점 지정 또는 [변위(D)/다중(M)] <변위>:', {
    keywords: [
      { key: 'D', label: '변위' },
      { key: 'M', label: '다중' },
    ],
  });
  let base: Pt;
  if ('keyword' in b && b.keyword === 'M') {
    multiple = true;
    const b2 = await ctx.getPoint('기본점 지정:');
    if (!('point' in b2)) return;
    base = b2.point;
  } else if ('point' in b) base = b.point;
  else {
    const d = await askString(ctx, '변위 지정 <0,0,0>:', '0,0');
    const m = typeof d === 'string' ? /^\s*(-?[\d.]+(?:e-?\d+)?)\s*,\s*(-?[\d.]+(?:e-?\d+)?)/i.exec(d) : null;
    const dx = m ? Number(m[1]) : 0;
    const dy = m ? Number(m[2]) : 0;
    commitImports();
    const a = commitResults(app, ctx, [{ add: moved(dx, dy) }], 'NCOPY', { quiet: true });
    ctx.print(`중첩된 객체 ${a.added.length}개를 복사했습니다.`);
    return;
  }
  let total = 0;
  for (;;) {
    const q = await ctx.getPoint(total ? '두 번째 점 지정 또는 [종료(E)] <종료>:' : '두 번째 점 지정 또는 <첫 번째 점을 변위로 사용>:', {
      base,
      keywords: total ? [{ key: 'E', label: '종료' }] : [],
      ghost: (p) => previewOf(app, moved(p.x - base.x, p.y - base.y)),
    });
    let dx: number;
    let dy: number;
    if ('point' in q) {
      dx = q.point.x - base.x;
      dy = q.point.y - base.y;
    } else if ('enter' in q && !total) {
      dx = base.x;
      dy = base.y;
    } else break;
    commitImports();
    const a = commitResults(app, ctx, [{ add: moved(dx, dy) }], 'NCOPY', { quiet: true });
    total += a.added.length;
    if (!multiple) break;
  }
  if (total) ctx.print(`중첩된 객체 ${total}개를 복사했습니다.`);
}

// ---------------------------------------------------------------------------
// GATTE
// ---------------------------------------------------------------------------

async function runGatte(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  let blockName = '';
  let tag = '';
  for (;;) {
    const r = await ctx.getEntity('블록 참조 또는 속성 선택 [블록 이름(B)]:', [{ key: 'B', label: '블록 이름' }]);
    if ('enter' in r) return;
    if ('keyword' in r) {
      const n = await askString(ctx, '블록 이름 입력:');
      if (typeof n !== 'string' || !n.trim()) continue;
      const def = doc.blocks.get(tableKey(n.trim()));
      if (!def || def.name.startsWith('*') || !referencesOf(doc, def.name).length) {
        ctx.print(`블록 "${n.trim()}"의 참조가 도면에 없습니다.`, 'err');
        continue;
      }
      blockName = def.name;
      break;
    }
    const e = doc.entityIndex.get(r.handle);
    if (e?.type !== 'INSERT' || !e.attribs.length) {
      ctx.print('속성이 있는 블록 참조를 고르십시오.', 'err');
      continue;
    }
    blockName = referenceName(doc, e);
    const a = attributeAt(e, r.point, doc, pickTolerance(app) * 1.5);
    if (a) tag = a.tag;
    break;
  }
  ctx.print(`블록 이름: ${blockName}`);
  const tags = knownTags(doc, blockName);
  if (!tags.length) {
    ctx.print(`블록 "${blockName}"에 속성이 없습니다.`, 'err');
    return;
  }
  if (!tag) {
    ctx.print(`블록에 대해 알려진 태그 이름: ${tags.join(' ')}`);
    for (;;) {
      const r = await ctx.getPoint('속성 선택 또는 속성 이름 입력:', { allowText: true });
      if ('enter' in r) return;
      if ('text' in r) {
        const t = tags.find((x) => x.toUpperCase() === r.text.trim().toUpperCase());
        if (t) {
          tag = t;
          break;
        }
        ctx.print(`"${r.text.trim()}"은(는) 이 블록의 태그가 아닙니다.`, 'err');
        continue;
      }
      if ('point' in r) {
        const pk = app.picker();
        const hit = pk?.pick(r.point.x, r.point.y, pickTolerance(app));
        const ins = hit ? doc.entityIndex.get(hit) : undefined;
        const a = ins?.type === 'INSERT' ? attributeAt(ins, r.point, doc, pickTolerance(app) * 1.5) : null;
        if (a && tags.some((x) => x.toUpperCase() === a.tag.toUpperCase())) {
          tag = a.tag;
          break;
        }
        ctx.print('그 자리에 이 블록의 속성이 없습니다.', 'err');
      }
    }
  }
  ctx.print(`속성 태그: ${tag}`);
  const v = await askString(ctx, '새 문자 입력:');
  if (typeof v !== 'string') return;
  let refs = referencesOf(doc, blockName);
  // 잠긴 도면층(공간의 참조만)
  const lockedOut = (r: { block: string; entity: InsertEntity }) => doc.layers.get(tableKey(r.entity.layer))?.locked && /^\*(MODEL|PAPER)_SPACE/i.test(r.block);
  const all = await yesNo(ctx, `도면의 블록 참조 수 = ${refs.length}. 모두 처리하겠습니까?`, true);
  if (!all) {
    const hs = new Set(await ctx.getSelection('객체 선택:', { noPickfirst: true }));
    refs = refs.filter((r) => hs.has(r.entity.handle));
  }
  const locked = refs.filter(lockedOut).length;
  refs = refs.filter((r) => !lockedOut(r));
  ctx.print('잠시 기다리십시오...');
  const { changes, found } = gatteChanges(refs, tag, v);
  const ops: EditOp[] = changes.map((c) => ({ kind: 'modify', block: c.block, before: c.before, after: c.after }));
  if (ops.length) st.session.commit({ label: 'GATTE', ops, group: ctx.group });
  app.clearSelection();
  ctx.print(`속성 ${changes.length}개를 바꿨습니다.${found > changes.length ? ` (${found - changes.length}개는 이미 같은 값)` : ''}${locked ? ` 잠긴 도면층의 참조 ${locked}개는 건너뛰었습니다.` : ''}`);
}

// ---------------------------------------------------------------------------

export function registerExpressSelectCommands(app: App, add: (c: Command) => void = (c) => app.register(c)): void {
  add({ name: 'SSX', title: '같은 특성으로 선택 집합 만들기', run: (ctx) => runSsx(app, ctx) });
  add({ name: 'GETSEL', title: '도면층·객체 유형으로 선택', run: (ctx) => runGetsel(app, ctx) });
  add({ name: 'XLIST', title: '중첩 객체 정보', run: (ctx) => runXlist(app, ctx) });
  add({ name: 'XDLIST', title: '확장 데이터 보기', run: (ctx) => runXdlist(app, ctx) });
  add({ name: 'NCOPY', title: '중첩된 객체 복사', run: (ctx) => runNcopy(app, ctx) });
  add({ name: 'GATTE', title: '전역 속성 편집', run: (ctx) => runGatte(app, ctx) });
}
