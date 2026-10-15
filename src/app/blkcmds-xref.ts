/**
 * 외부 참조 명령: XATTACH(XA)·IMAGEATTACH(IAT)·PDFATTACH(파일 고르기 → 삽입점·축척·회전), XBIND·-XBIND(의존 기호 결합),
 * XOPEN(외부 참조를 새 탭으로), BLOCKTOXREF(Express: 블록 참조를 외부 참조로), CLASSICXREF(외부 참조 창).
 * 고른 파일의 연결(그리기)은 외부 참조 창(refs.ts)의 연결 함수를 그대로 쓴다. 파일은 이 브라우저 안에서만 읽는다.
 * 도면 작업 계산은 src/edit/blkcmds(xref·attach)의 순수 함수가 한다.
 */
import type { CadDocument, InsertEntity, Vec3 } from '../core/model';
import { tableKey } from '../core/model';
import { imageAttachOps, pdfAttachOps, unitsPerInch } from '../edit/blkcmds/attach';
import { SYM_KINDS, SYM_LABEL, type SymKind, blockToXrefOps, dependentSymbols, xbindOps, xrefAttachOps, xrefNameFromFile } from '../edit/blkcmds/xref';
import { matchNameList } from '../edit/layercmd';
import { INSUNITS_MM } from '../edit/util/calc';
import type { App, CommandContext, Keyword } from './app';
import { askOption, askReal, askWord, askYN, fmt4 } from './dashcmds-ask';
import { currentProps } from './draw';
import { expandXrefBounds, linkImageFiles, linkPdfFiles, linkXrefFiles, renderPdfPages, xrefOfDoc } from './refs';
import { commandLineMode } from './script';
import { sessionFile } from './sessionfiles';
import { dialog, form, h } from './ui/dom';
import { pickOneFile, registerOnce } from './blkcmds-io';
import type { Pt } from './view';

const DWG_ACCEPT = '.dwg,.dxf,.DWG,.DXF';
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.bmp,.webp,.PNG,.JPG,.JPEG,.GIF,.BMP,.WEBP';

/** 연결한 외부 참조 파일(파일 이름으로) */
function linkedXref(fileName: string) {
  const probe = { blocks: new Map([['?', { name: '?', flags: 4, xrefPath: fileName, entities: [] }]]) } as unknown as CadDocument;
  return xrefOfDoc(probe, '?');
}

/** 블록 단위 → 도면 단위 축척(둘 중 하나가 단위 없음이면 1) */
function unitFactor(src: number, dst: number): number {
  const a = INSUNITS_MM[src];
  const b = INSUNITS_MM[dst];
  return src && dst && a && b ? a / b : 1;
}

const deg = (v: number) => (v * Math.PI) / 180;

/** 상자 네 모서리를 놓은 미리보기(블록 좌표 상자 → 삽입) */
function boxRubber(box: { minX: number; minY: number; maxX: number; maxY: number } | null, base: Vec3, scale: () => number, rot: () => number) {
  return (p: Pt) => {
    if (!box) return [];
    const s = scale();
    const c = Math.cos(rot());
    const n = Math.sin(rot());
    const pts = [
      [box.minX, box.minY],
      [box.maxX, box.minY],
      [box.maxX, box.maxY],
      [box.minX, box.maxY],
    ].flatMap(([x, y]) => {
      const dx = (x! - base.x) * s;
      const dy = (y! - base.y) * s;
      return [p.x + dx * c - dy * n, p.y + dx * n + dy * c];
    });
    return [{ pts, closed: true, dashed: true }];
  };
}

/** 삽입점 묻기(축척(S)·회전(R) 키워드로 값을 바꾼다). 취소면 null */
async function placeWithKeywords(ctx: CommandContext, rubber: (p: Pt, s: number, r: number) => ReturnType<ReturnType<typeof boxRubber>>, scale: number, rotDeg: number, prompt = '삽입점 지정 또는 [축척(S)/회전(R)]:'): Promise<{ at: Pt; scale: number; rotDeg: number } | null> {
  const kws: Keyword[] = [
    { key: 'S', label: '축척' },
    { key: 'R', label: '회전' },
  ];
  for (;;) {
    const r = await ctx.getPoint(prompt, { keywords: kws, rubber: (p) => rubber(p, scale, deg(rotDeg)) });
    if ('point' in r) return { at: r.point, scale, rotDeg };
    if ('keyword' in r && r.keyword === 'S') scale = await askReal(ctx, `축척 비율 지정 <${fmt4(scale)}>:`, scale, (v) => (v > 0 ? null : '축척은 0보다 커야 합니다.'));
    else if ('keyword' in r && r.keyword === 'R') rotDeg = await askReal(ctx, `회전 각도 지정 <${rotDeg}>:`, rotDeg);
    else return null;
  }
}

async function finishXref(app: App): Promise<void> {
  const st = app.active;
  if (!st) return;
  await app.edits.flush(st);
  expandXrefBounds(app, st);
  app.view.requestRender();
}

// ---------------------------------------------------------------------------
// XATTACH
// ---------------------------------------------------------------------------

async function runXattach(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const file = await pickOneFile(app, ctx, DWG_ACCEPT, '부착할 파일 이름 입력:', ['.dwg', '.dxf']);
  if (!file) return;
  if (!/\.(dwg|dxf)$/i.test(file.name)) {
    ctx.print(`${file.name}: DWG·DXF 파일만 외부 참조로 부착할 수 있습니다.`, 'err');
    return;
  }
  if (file.name.toLowerCase() === st.name.toLowerCase() || file.name.toLowerCase() === st.saveName.toLowerCase()) {
    ctx.print(`${file.name}은(는) 지금 도면이라 자신에게 부착할 수 없습니다(순환 참조).`, 'err');
    return;
  }
  const linked = await linkXrefFiles(app, [file]);
  const xf = linked.length ? linkedXref(file.name) : null;
  if (!xf) return;
  const xdoc = xf.doc;
  let name = xrefNameFromFile(file.name);
  const exist = doc.blocks.get(tableKey(name));
  if (exist && !(exist.flags & 4)) {
    let n = 1;
    while (doc.blocks.has(tableKey(`${name}_${n}`))) n++;
    ctx.print(`"${exist.name}"은(는) 이미 이 도면의 블록 이름이라 외부 참조 이름을 ${name}_${n}(으)로 합니다.`);
    name = `${name}_${n}`;
  } else if (exist) ctx.print(`외부 참조 ${exist.name}이(가) 이미 정의되어 있습니다. 기존 정의를 사용합니다.`);
  const insunits = Number(doc.header.get('$INSUNITS') ?? 0) || 0;
  let scale = unitFactor(Number(xdoc.header.get('$INSUNITS') ?? 0) || 0, insunits);
  let rotDeg = 0;
  let overlay = !!exist && !!(exist.flags & 8);
  if (!commandLineMode(app)) {
    const v = await form(
      `외부 참조 부착 — ${file.name}`,
      [
        { key: 'name', label: '이름', type: 'text', value: name },
        {
          key: 'type',
          label: '참조 유형',
          type: 'select',
          value: overlay ? 'overlay' : 'attach',
          options: [
            { value: 'attach', label: '부착' },
            { value: 'overlay', label: '중첩' },
          ],
        },
        { key: 'scale', label: '축척', type: 'number', value: +scale.toPrecision(12) },
        { key: 'rot', label: '회전(도)', type: 'number', value: 0 },
      ],
      {
        ok: '확인',
        note: `저장 경로: ${file.name}(상대 경로). 삽입점은 화면에서 지정합니다.${scale !== 1 ? ` 블록 단위 환산 축척 ${+scale.toPrecision(6)}을(를) 넣었습니다.` : ''}`,
        validate: (x) => {
          const n = String(x.name).trim();
          if (!n || /[<>/\\":;?*|,=`]/.test(n)) return '이름에 쓸 수 없는 문자가 있습니다.';
          const b = doc.blocks.get(tableKey(n));
          if (b && !(b.flags & 4)) return '같은 이름의 블록이 이미 있습니다.';
          if (!(Number(x.scale) > 0)) return '축척은 0보다 커야 합니다.';
          return null;
        },
      },
    );
    if (!v) return;
    name = String(v.name).trim();
    overlay = v.type === 'overlay';
    scale = Number(v.scale);
    rotDeg = Number(v.rot);
  }
  const ib = xdoc.header.get('$INSBASE');
  const base: Vec3 = ib && typeof ib === 'object' ? { x: ib.x, y: ib.y, z: 0 } : { x: 0, y: 0, z: 0 };
  const box = xf.scene.bounds;
  const placed = await placeWithKeywords(ctx, (p, s, r) => boxRubber(box, base, () => s, () => r)(p), scale, rotDeg);
  if (!placed) return;
  if (commandLineMode(app)) {
    placed.scale = await askReal(ctx, `X 축척 비율 입력 <${fmt4(placed.scale)}>:`, placed.scale, (v) => (v !== 0 ? null : '축척은 0일 수 없습니다.'));
    placed.rotDeg = await askReal(ctx, `회전 각도 지정 <${placed.rotDeg}>:`, placed.rotDeg);
  }
  try {
    const r = xrefAttachOps(
      doc,
      { name, path: file.name, overlay, xdoc },
      { space: st.space, insert: { x: placed.at.x, y: placed.at.y, z: 0 }, scale: { x: placed.scale, y: placed.scale, z: placed.scale }, rotation: deg(placed.rotDeg), props: currentProps(app) },
      () => st.session.newHandle(),
    );
    st.selection.clear();
    st.session.commit({ label: 'XATTACH', ops: r.ops, group: ctx.group, rebuildNow: true });
    app.lastCreated = [r.insert.handle];
    await finishXref(app);
    ctx.print(`외부 참조 "${r.insert.block}"을(를) ${overlay ? '중첩' : '부착'}했습니다(${file.name}).`);
  } catch (e) {
    ctx.print(e instanceof Error ? e.message : String(e), 'err');
  }
}

// ---------------------------------------------------------------------------
// IMAGEATTACH
// ---------------------------------------------------------------------------

/** 이미지 파일을 연결하고 이미지 객체를 넣는다(PASTESPEC도 쓴다). 넣었으면 true */
export async function attachImageFile(app: App, ctx: CommandContext, file: File, label: string, defaultWidth = 1): Promise<boolean> {
  let w = 0;
  let hgt = 0;
  try {
    const bmp = await createImageBitmap(file);
    w = bmp.width;
    hgt = bmp.height;
    bmp.close();
  } catch {
    ctx.print(`${file.name}: 이 브라우저가 읽을 수 없는 이미지 형식입니다(PNG·JPEG·GIF·BMP·WebP만).`, 'err');
    return false;
  }
  const res = await linkImageFiles(app, [file]);
  if (!res.linked.length) {
    ctx.print(`${file.name}: 이미지를 연결하지 못했습니다.`, 'err');
    return false;
  }
  let scale = defaultWidth > 0 ? defaultWidth : 1;
  let rotDeg = 0;
  if (!commandLineMode(app) && label === 'IMAGEATTACH') {
    const v = await form(
      `이미지 부착 — ${file.name}`,
      [
        { key: 'scale', label: '축척(이미지 폭, 도면 단위)', type: 'number', value: 1 },
        { key: 'rot', label: '회전(도)', type: 'number', value: 0 },
        { key: 'onscreen', label: '축척을 화면에서 지정', type: 'check', value: true },
      ],
      { ok: '확인', note: `${w} × ${hgt} 화소. 해상도 정보를 쓰지 않으므로 축척 1 = 폭 1 도면 단위입니다(AutoCAD와 같다).`, validate: (x) => (Number(x.scale) > 0 ? null : '축척은 0보다 커야 합니다.') },
    );
    if (!v) return false;
    scale = Number(v.scale);
    rotDeg = Number(v.rot);
    if (!v.onscreen) {
      const p = await ctx.getPoint('삽입점 지정 <0,0>:', { rubber: (q) => imageRubber(q, w, hgt, scale, deg(rotDeg)) });
      if ('enter' in p) return commitImage(app, ctx, file, w, hgt, { x: 0, y: 0 }, scale, rotDeg, label);
      if (!('point' in p)) return false;
      return commitImage(app, ctx, file, w, hgt, p.point, scale, rotDeg, label);
    }
  }
  const p = await ctx.getPoint('삽입점 지정 <0,0>:', { rubber: (q) => imageRubber(q, w, hgt, scale, deg(rotDeg)) });
  let at: Pt;
  if ('point' in p) at = p.point;
  else if ('enter' in p) at = { x: 0, y: 0 };
  else return false;
  ctx.print(`기본 이미지 크기: 폭: ${fmt4(scale)}, 높이: ${fmt4((scale * hgt) / w)}${defaultWidth === 1 ? ', 단위 없음' : ''}`);
  for (;;) {
    const r = await ctx.getPoint(`축척 비율 지정 <${fmt4(scale)}>:`, { base: at, preferNumber: true, allowText: true, rubber: (q) => imageRubber(at, w, hgt, Math.hypot(q.x - at.x, q.y - at.y) || scale, deg(rotDeg)) });
    if ('enter' in r) break;
    if ('point' in r) {
      const d = Math.hypot(r.point.x - at.x, r.point.y - at.y);
      if (d > 0) {
        scale = d;
        break;
      }
      continue;
    }
    if ('text' in r) {
      const v = Number(r.text.trim());
      if (Number.isFinite(v) && v > 0) {
        scale = v;
        break;
      }
    }
    ctx.print('0보다 큰 값이 필요합니다.', 'err');
  }
  return commitImage(app, ctx, file, w, hgt, at, scale, rotDeg, label);
}

function imageRubber(q: Pt, w: number, hgt: number, width: number, rot: number) {
  const k = width / Math.max(1, w);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const W = w * k;
  const H = hgt * k;
  const pts = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ].flatMap(([x, y]) => [q.x + x! * c - y! * s, q.y + x! * s + y! * c]);
  return [{ pts, closed: true, dashed: true }];
}

function commitImage(app: App, ctx: CommandContext, file: File, w: number, hgt: number, at: Pt, width: number, rotDeg: number, label: string): boolean {
  const st = app.active!;
  const r = imageAttachOps(st.doc, { fileName: file.name, widthPx: w, heightPx: hgt, space: st.space, insert: { x: at.x, y: at.y, z: 0 }, width, rotation: deg(rotDeg), props: currentProps(app) }, () => st.session.newHandle());
  st.selection.clear();
  st.session.commit({ label, ops: r.ops, group: ctx.group, rebuildNow: true });
  app.lastCreated = [r.image.handle];
  if (r.reused) ctx.print(`이미지 ${file.name}이(가) 이미 정의되어 있습니다. 기존 정의를 사용합니다.`);
  ctx.print(`이미지 ${file.name}(${w} × ${hgt} 화소)을(를) 부착했습니다.`);
  return true;
}

// ---------------------------------------------------------------------------
// PDFATTACH
// ---------------------------------------------------------------------------

async function runPdfattach(app: App, ctx: CommandContext): Promise<void> {
  const file = await pickOneFile(app, ctx, '.pdf,.PDF', '부착할 PDF 파일 이름 입력:', ['.pdf']);
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) {
    ctx.print(`${file.name}: PDF 파일이 아닙니다.`, 'err');
    return;
  }
  // 페이지 수(크기는 고른 페이지만 잰다)
  let opened: { pdf: { numPages: number; getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number } }> }; close: () => Promise<void> };
  app.ui.setBusy('PDF 읽는 중…', 0.3);
  try {
    const r = await import('./pdfraster');
    opened = await r.openPdf(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    ctx.print(`${file.name}: PDF를 읽지 못했습니다(${e instanceof Error ? e.message : String(e)}). 암호가 걸렸거나 손상된 파일입니다.`, 'err');
    return;
  } finally {
    app.ui.setBusy(null);
  }
  try {
    await placePdf(app, ctx, file, opened.pdf);
  } finally {
    void opened.close();
  }
}

async function placePdf(app: App, ctx: CommandContext, file: File, pdf: { numPages: number; getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number } }> }): Promise<void> {
  const st = app.active!;
  const pages = { length: pdf.numPages };
  if (!pages.length) {
    ctx.print(`${file.name}: 페이지가 없습니다.`, 'err');
    return;
  }
  const insunits = Number(st.doc.header.get('$INSUNITS') ?? 0) || 0;
  let page = 1;
  let scale = 1;
  let rotDeg = 0;
  if (!commandLineMode(app)) {
    const v = await form(
      `PDF 언더레이 부착 — ${file.name}`,
      [
        { key: 'page', label: `페이지(1~${pages.length})`, type: 'number', value: 1 },
        { key: 'scale', label: '축척', type: 'number', value: 1 },
        { key: 'rot', label: '회전(도)', type: 'number', value: 0 },
      ],
      {
        ok: '확인',
        note: `축척 1 = 실제 용지 크기(도면 단위 INSUNITS ${insunits || '없음'}${insunits ? '' : ' — 1인치 = 1 단위'}). 삽입점은 화면에서 지정합니다.`,
        validate: (x) => {
          const p = Number(x.page);
          if (!Number.isInteger(p) || p < 1 || p > pages.length) return `페이지는 1에서 ${pages.length} 사이의 정수입니다.`;
          return Number(x.scale) > 0 ? null : '축척은 0보다 커야 합니다.';
        },
      },
    );
    if (!v) return;
    page = Number(v.page);
    scale = Number(v.scale);
    rotDeg = Number(v.rot);
  } else if (pages.length > 1) {
    for (;;) {
      const t = await askWord(ctx, '페이지 번호 입력 또는 [?] <1>:', [{ key: '?', label: '?' }]);
      if (t === null) break;
      if (t === '?') {
        ctx.print(`페이지: 1~${pages.length}`);
        continue;
      }
      const n = Number(t);
      if (Number.isInteger(n) && n >= 1 && n <= pages.length) {
        page = n;
        break;
      }
      ctx.print(`1에서 ${pages.length} 사이의 정수가 필요합니다.`, 'err');
    }
  }
  const vp = (await pdf.getPage(page)).getViewport({ scale: 1 });
  const size = { w: vp.width / 72, h: vp.height / 72 };
  const upi = unitsPerInch(insunits);
  const box = { minX: 0, minY: 0, maxX: size.w * upi, maxY: size.h * upi };
  const p = await ctx.getPoint('삽입점 지정:', { rubber: (q) => boxRubber(box, { x: 0, y: 0, z: 0 }, () => scale, () => deg(rotDeg))(q) });
  if (!('point' in p)) return;
  const at = p.point;
  if (commandLineMode(app)) {
    scale = await askReal(ctx, `축척 비율 지정 <${fmt4(scale)}>:`, scale, (v) => (v > 0 ? null : '축척은 0보다 커야 합니다.'));
    rotDeg = await askReal(ctx, `회전 지정 <${rotDeg}>:`, rotDeg);
  }
  const r = pdfAttachOps(st.doc, { fileName: file.name, page, space: st.space, insert: { x: at.x, y: at.y, z: 0 }, scale, rotation: deg(rotDeg), insunits, props: currentProps(app) }, () => st.session.newHandle());
  st.selection.clear();
  st.session.commit({ label: 'PDFATTACH', ops: r.ops, group: ctx.group, rebuildNow: true });
  app.lastCreated = [r.underlay.handle];
  const linked = await linkPdfFiles(app, [file]);
  if (!linked.linked.length) await renderPdfPages(app);
  if (linked.failed.length) ctx.print(`${file.name}: 페이지를 그리지 못했습니다. 경계만 보입니다.`, 'err');
  ctx.print(`PDF 언더레이 ${file.name}(${page}쪽)을(를) 부착했습니다.`);
}

// ---------------------------------------------------------------------------
// XBIND
// ---------------------------------------------------------------------------

interface XrefSyms {
  name: string;
  xdoc: CadDocument | null;
  syms: Record<SymKind, string[]>;
}

function xrefList(app: App): XrefSyms[] {
  const doc = app.active!.doc;
  return [...doc.blocks.values()]
    .filter((b) => b.flags & 4)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    .map((b) => {
      const xdoc = xrefOfDoc(doc, tableKey(b.name))?.doc ?? null;
      return { name: b.name, xdoc, syms: dependentSymbols(doc, b.name, xdoc) };
    });
}

/** 고른 의존 기호를 결합하고 알린다 */
function commitXbind(app: App, ctx: CommandContext, picks: Map<string, { kind: SymKind; name: string }[]>, list: XrefSyms[]): void {
  const st = app.active!;
  const counts = new Map<SymKind, number>();
  let failed = 0;
  for (const x of list) {
    const items = picks.get(x.name);
    if (!items?.length) continue;
    const r = xbindOps(st.doc, x.name, items, x.xdoc, () => st.session.newHandle());
    if (r.ops.length) st.session.commit({ label: 'XBIND', ops: r.ops, group: ctx.group, rebuildNow: true });
    for (const b of r.bound) {
      counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
      ctx.print(`${SYM_LABEL[b.kind]} ${b.from} → ${b.to}`);
    }
    for (const f of r.failed) ctx.print(`${SYM_LABEL[f.kind]} ${f.name}은(는) 결합할 수 없습니다${f.kind === 'block' && !x.xdoc ? '(참조 파일이 연결되지 않음)' : ''}.`, 'err');
    failed += r.failed.length;
  }
  const parts = SYM_KINDS.filter((k) => counts.get(k)).map((k) => `${SYM_LABEL[k]} ${counts.get(k)}개`);
  ctx.print(parts.length ? `결합됨: ${parts.join(', ')}.` : failed ? '결합한 기호가 없습니다.' : '고른 기호가 없습니다.');
}

function runXbindDialog(app: App, ctx: CommandContext): Promise<void> {
  const list = xrefList(app);
  if (!list.length) {
    ctx.print('이 도면에는 외부 참조가 없습니다.', 'err');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const checks: { x: string; kind: SymKind; name: string; box: HTMLInputElement }[] = [];
    const tree = h('div', { style: 'max-height:52vh;overflow:auto;min-width:340px;font-size:12px;line-height:1.7' });
    for (const x of list) {
      const xs = h('details', { open: true }, h('summary', { style: 'font-weight:600' }, `${x.name}${x.xdoc ? '' : ' (파일 연결 안 됨)'}`));
      for (const kind of SYM_KINDS) {
        const names = x.syms[kind];
        if (!names.length) continue;
        const kd = h('details', { style: 'margin-left:14px' }, h('summary', {}, `${SYM_LABEL[kind]} (${names.length})`));
        for (const n of names) {
          const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
          checks.push({ x: x.name, kind, name: n, box });
          kd.append(h('label', { style: 'display:block;margin-left:16px;white-space:nowrap' }, box, ` ${x.name}|${n}`));
        }
        xs.append(kd);
      }
      if (!x.xdoc) xs.append(h('div', { style: 'margin-left:14px;color:var(--text-dim)' }, '참조 파일을 연결하면(XR) 블록도 결합할 수 있습니다.'));
      tree.append(xs);
    }
    let done = false;
    const body = h('div', {}, h('p', { style: 'margin:0 0 6px' }, '결합할 의존 기호를 고르십시오. 결합하면 "참조$0$이름"의 보통 기호가 됩니다.'), tree);
    const back = dialog('외부 참조 바인딩', body, [
      {
        label: '취소',
        run: () => {
          done = true;
          resolve();
        },
      },
      {
        label: '확인',
        primary: true,
        run: () => {
          done = true;
          const picks = new Map<string, { kind: SymKind; name: string }[]>();
          for (const c of checks) {
            if (!c.box.checked) continue;
            const l = picks.get(c.x) ?? [];
            l.push({ kind: c.kind, name: c.name });
            picks.set(c.x, l);
          }
          if (picks.size) commitXbind(app, ctx, picks, list);
          resolve();
        },
      },
    ]);
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve();
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

async function runDashXbind(app: App, ctx: CommandContext): Promise<void> {
  const list = xrefList(app);
  if (!list.length) {
    ctx.print('이 도면에는 외부 참조가 없습니다.', 'err');
    return;
  }
  const KW: Keyword[] = [
    { key: 'B', label: '블록' },
    { key: 'D', label: '치수 스타일' },
    { key: 'LA', label: '도면층' },
    { key: 'LT', label: '선종류' },
    { key: 'S', label: '문자 스타일' },
  ];
  const k = await askOption(ctx, '기호 유형 입력 [블록(B)/치수 스타일(D)/도면층(LA)/선종류(LT)/문자 스타일(S)]:', KW, null);
  if (!k) return;
  const kind: SymKind = ({ B: 'block', D: 'dimStyle', LA: 'layer', LT: 'linetype', S: 'textStyle' } as const)[k as 'B' | 'D' | 'LA' | 'LT' | 'S'];
  const spec = await askWord(ctx, `종속 ${SYM_LABEL[kind]} 이름 입력:`);
  if (!spec) return;
  const all: { x: string; name: string; full: string }[] = [];
  for (const x of list) for (const n of x.syms[kind]) all.push({ x: x.name, name: n, full: `${x.name}|${n}` });
  const m = matchNameList(
    all.map((a) => a.full),
    spec,
  );
  for (const u of m.unmatched) ctx.print(`종속 ${SYM_LABEL[kind]} "${u}"을(를) 찾을 수 없습니다.`, 'err');
  if (!m.names.length) return;
  const set = new Set(m.names.map((n) => n.toUpperCase()));
  const picks = new Map<string, { kind: SymKind; name: string }[]>();
  for (const a of all) {
    if (!set.has(a.full.toUpperCase())) continue;
    const l = picks.get(a.x) ?? [];
    l.push({ kind, name: a.name });
    picks.set(a.x, l);
  }
  commitXbind(app, ctx, picks, list);
}

// ---------------------------------------------------------------------------
// XOPEN
// ---------------------------------------------------------------------------

async function runXopen(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  let ins: InsertEntity | null = null;
  // 외부 참조 하나를 고른 상태면 그것
  const pre = [...st.selection].map((x) => st.doc.entityIndex.get(x)).filter((e): e is InsertEntity => e?.type === 'INSERT' && !!((st.doc.blocks.get(tableKey(e.block))?.flags ?? 0) & 4));
  if (pre.length === 1) ins = pre[0]!;
  while (!ins) {
    const r = await ctx.getEntity('외부 참조 선택:');
    if (!('handle' in r)) return;
    const e = st.doc.entityIndex.get(r.handle);
    if (e?.type === 'INSERT' && (st.doc.blocks.get(tableKey(e.block))?.flags ?? 0) & 4) ins = e;
    else ctx.print('외부 참조가 아닙니다.', 'err');
  }
  const def = st.doc.blocks.get(tableKey(ins.block))!;
  const path = def.xrefPath || `${def.name}.dwg`;
  const fname = path.replace(/^.*[\\/]/, '');
  const xf = xrefOfDoc(st.doc, tableKey(def.name));
  // 이미 탭으로 열려 있으면 그 탭
  const open = app.docs.find((d) => d.name.toLowerCase() === (xf?.name ?? fname).toLowerCase());
  if (open) {
    app.activate(open);
    ctx.print(`${open.name}은(는) 이미 열려 있습니다.`);
    return;
  }
  const blob = sessionFile(fname);
  if (blob) {
    const opened = await app.openFile(fname, await blob.arrayBuffer());
    if (opened) ctx.print(`외부 참조 ${def.name}을(를) 새 탭에서 열었습니다(${fname}). 고쳐 저장한 뒤 외부 참조 창(XR)에서 다시 연결하면 반영됩니다.`);
    return;
  }
  if (xf) {
    app.ui.setBusy(`${xf.name} 여는 중…`, 0.5);
    try {
      const res = await app.engine.adopt(xf.name, xf.doc);
      const nst = app.addDocument(res, xf.name, 0);
      app.onOpened?.(nst);
      ctx.print(`외부 참조 ${def.name}을(를) 새 탭에서 열었습니다(${xf.name}). 고쳐 저장한 뒤 외부 참조 창(XR)에서 다시 연결하면 반영됩니다.`);
    } catch (e) {
      ctx.print(`외부 참조를 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      app.ui.setBusy(null);
    }
    return;
  }
  ctx.print(`외부 참조 파일 ${fname}을(를) 찾을 수 없습니다. 파일을 고르십시오.`);
  const f = await pickOneFile(app, ctx, DWG_ACCEPT, '열 파일 이름 입력:', ['.dwg', '.dxf']);
  if (!f) return;
  await app.openFile(f.name, await f.arrayBuffer());
}

// ---------------------------------------------------------------------------
// BLOCKTOXREF
// ---------------------------------------------------------------------------

async function runBlockToXref(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  let block = '';
  while (!block) {
    const r = await ctx.getEntity('변환할 블록 참조 선택:');
    if (!('handle' in r)) return;
    const e = doc.entityIndex.get(r.handle);
    const def = e?.type === 'INSERT' ? doc.blocks.get(tableKey(e.block)) : undefined;
    if (!def) ctx.print('블록 참조가 아닙니다.', 'err');
    else if (def.flags & 4) ctx.print('이미 외부 참조입니다.', 'err');
    else if (def.name.startsWith('*')) ctx.print('이름 없는(익명) 블록은 바꿀 수 없습니다.', 'err');
    else block = def.name;
  }
  ctx.print(`블록 ${block}의 참조를 바꿀 외부 참조 도면을 고르십시오.`);
  const file = await pickOneFile(app, ctx, DWG_ACCEPT, '외부 참조로 쓸 도면 파일 이름 입력:', ['.dwg', '.dxf']);
  if (!file) return;
  if (!/\.(dwg|dxf)$/i.test(file.name)) {
    ctx.print(`${file.name}: DWG·DXF 파일만 외부 참조가 될 수 있습니다.`, 'err');
    return;
  }
  const linked = await linkXrefFiles(app, [file]);
  const xf = linked.length ? linkedXref(file.name) : null;
  if (!xf) return;
  let overlay = false;
  let purge = true;
  if (commandLineMode(app)) {
    overlay = await askYN(ctx, '외부 참조를 중첩으로 부착하시겠습니까?', false);
    purge = await askYN(ctx, '끝나면 참조되지 않는 항목을 소거하시겠습니까?', true);
  } else {
    const v = await form(
      `블록을 외부 참조로 — ${block}`,
      [
        {
          key: 'type',
          label: '참조 유형',
          type: 'select',
          value: 'attach',
          options: [
            { value: 'attach', label: '부착' },
            { value: 'overlay', label: '중첩' },
          ],
        },
        { key: 'purge', label: '끝나면 참조되지 않는 블록 정의 소거', type: 'check', value: true },
      ],
      { ok: '변환', note: `블록 ${block}의 모든 참조(블록 안의 참조 포함)를 ${file.name}의 외부 참조로 바꿉니다. 삽입점·축척·회전·도면층은 그대로이고 속성은 없어집니다.` },
    );
    if (!v) return;
    overlay = v.type === 'overlay';
    purge = !!v.purge;
  }
  let name = xrefNameFromFile(file.name);
  const ex = doc.blocks.get(tableKey(name));
  if (ex && !(ex.flags & 4) && tableKey(ex.name) !== tableKey(block)) {
    let n = 1;
    while (doc.blocks.has(tableKey(`${name}_${n}`))) n++;
    ctx.print(`"${ex.name}"은(는) 이미 블록 이름이라 외부 참조 이름을 ${name}_${n}(으)로 합니다.`);
    name = `${name}_${n}`;
  }
  // 같은 이름이면 블록 정의를 소거해야 외부 참조 정의가 그 자리에 들어간다
  if (tableKey(name) === tableKey(block) && !purge) {
    let n = 1;
    while (doc.blocks.has(tableKey(`${name}_${n}`))) n++;
    name = `${name}_${n}`;
    ctx.print(`블록 정의를 남기므로 외부 참조 이름을 ${name}(으)로 합니다.`);
  }
  try {
    const r = blockToXrefOps(doc, block, { name, path: file.name, overlay, xdoc: xf.doc }, purge, () => st.session.newHandle());
    st.selection.clear();
    st.session.commit({ label: 'BLOCKTOXREF', ops: r.ops, group: ctx.group, rebuildNow: true });
    await finishXref(app);
    ctx.print(`블록 참조 ${r.count}개를 외부 참조 ${name}(${file.name})(으)로 바꿨습니다.${r.droppedAttribs ? ` 속성이 있던 참조 ${r.droppedAttribs}개는 속성이 없어졌습니다.` : ''}${r.purged ? ` 블록 정의 ${block}을(를) 소거했습니다.` : ''}`);
  } catch (e) {
    ctx.print(e instanceof Error ? e.message : String(e), 'err');
  }
}

export function registerBlkXrefCommands(app: App): void {
  registerOnce(app, { name: 'XATTACH', aliases: ['XA'], title: '외부 참조 부착', run: (ctx) => runXattach(app, ctx) });
  registerOnce(app, {
    name: 'IMAGEATTACH',
    aliases: ['IAT'],
    title: '이미지 부착',
    async run(ctx) {
      const f = await pickOneFile(app, ctx, IMAGE_ACCEPT, '부착할 이미지 파일 이름 입력:', ['.png', '.jpg']);
      if (!f) return;
      await attachImageFile(app, ctx, f, 'IMAGEATTACH');
    },
  });
  registerOnce(app, { name: 'PDFATTACH', title: 'PDF 언더레이 부착', run: (ctx) => runPdfattach(app, ctx) });
  registerOnce(app, { name: 'XBIND', aliases: ['XB'], title: '외부 참조 기호 결합', run: (ctx) => (commandLineMode(app) ? runDashXbind(app, ctx) : runXbindDialog(app, ctx)) });
  registerOnce(app, { name: '-XBIND', aliases: ['-XB'], title: '외부 참조 기호 결합(명령행)', run: (ctx) => runDashXbind(app, ctx) });
  registerOnce(app, { name: 'XOPEN', title: '외부 참조 열기', run: (ctx) => runXopen(app, ctx) });
  registerOnce(app, { name: 'BLOCKTOXREF', title: '블록을 외부 참조로 변환', run: (ctx) => runBlockToXref(app, ctx) });
  registerOnce(app, {
    name: 'CLASSICXREF',
    title: '외부 참조 관리자',
    run(ctx) {
      const c = app.findCommand('EXTERNALREFERENCES');
      if (!c) {
        ctx.print('외부 참조 창(EXTERNALREFERENCES)이 없습니다.', 'err');
        return;
      }
      return c.run(ctx);
    },
  });
}
