/**
 * 명령행 블록 쓰기 -WBLOCK(스크립트용): `파일 이름 입력 <new block>:` →
 * `기존 블록 이름 입력 또는 [= (블록=출력 파일)/* (전체 도면)] <객체 선택 지정>:` → (객체) `삽입 기준점 지정:` → `객체 선택:`.
 * 파일은 WBLOCK과 같은 방식(src/edit/util/wblock의 새 도면 → 엔진 저장 → 내려받기)으로 만든다. 이름이 .dxf로 끝나면
 * AutoCAD 2018 DXF, 아니면 AutoCAD 2018 DWG. 객체로 쓰면 AutoCAD처럼 고른 객체를 도면에서 지운다(OOPS로 되살린다).
 */
import type { Entity } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { buildWblockDocument, type WblockSource } from '../edit/util/wblock';
import type { App, CommandContext } from './app';
import { userBlocks } from './blocks';
import { download } from './export';
import { unlockedOnly } from './layers';
import { SAVE_TYPES } from './save';
import { askText, rememberErased } from './util2-ui';
import type { Pt } from './view';

const BAD_FILE = /[<>/\\":;?*|]/;

/** 파일 이름 → 저장 형식(.dxf면 DXF 2018, 아니면 DWG 2018)과 확장자를 붙인 이름 */
export function wblockTarget(input: string): { fileName: string; base: string; format: 'dwg' | 'dxf'; version: string } | null {
  let n = input.trim();
  if (n.length >= 2 && n.startsWith('"') && n.endsWith('"')) n = n.slice(1, -1).trim();
  // 경로가 붙어 있으면 파일 이름만
  n = n.split(/[\\/]/).pop() ?? n;
  const m = /\.(dwg|dxf)$/i.exec(n);
  const format = m && m[1]!.toLowerCase() === 'dxf' ? 'dxf' : 'dwg';
  const base = m ? n.slice(0, -4) : n;
  if (!base || BAD_FILE.test(base)) return null;
  const t = SAVE_TYPES.find((x) => x.format === format && x.version === 'AC1032') ?? SAVE_TYPES[0]!;
  return { fileName: `${base}.${t.format}`, base, format: t.format as 'dwg' | 'dxf', version: t.version };
}

/** WBLOCK 파일을 만들어 내려받는다. 썼으면 true */
async function writeWblock(app: App, ctx: CommandContext, source: WblockSource, target: NonNullable<ReturnType<typeof wblockTarget>>): Promise<boolean> {
  const st = app.active!;
  const insunits = Number(st.doc.header.get('$INSUNITS') ?? 0) || 0;
  app.ui.setBusy('블록 쓰는 중…', 0.4);
  try {
    const built = buildWblockDocument(st.doc, source, { insUnits: source.kind === 'block' ? undefined : insunits });
    const res = await app.engine.adopt(target.fileName, built.doc);
    try {
      const out = await app.engine.save(res.docId, target.format, target.version, false);
      download(new Blob([out.data as BlobPart], { type: target.format === 'dxf' ? 'application/dxf' : 'application/acad' }), target.fileName);
      ctx.print(`${target.fileName}을(를) 썼습니다(객체 ${built.entities}개, ${(out.data.byteLength / 1024).toFixed(0)} KB).${built.skipped ? ` 옮길 수 없는 객체 ${built.skipped}개는 뺐습니다.` : ''}`);
      for (const w of out.warnings.slice(0, 3)) ctx.print(`참고: ${w.message}${w.count ? ` (${w.count})` : ''}`);
      return true;
    } finally {
      app.engine.closeDoc(res.docId);
    }
  } catch (e) {
    ctx.print(`블록을 쓰지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    return false;
  } finally {
    app.ui.setBusy(null);
  }
}

export function registerDashWblockCommand(app: App): void {
  app.register({
    name: '-WBLOCK',
    aliases: ['-W'],
    title: '블록 쓰기(명령행)',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      let target: ReturnType<typeof wblockTarget> = null;
      while (!target) {
        const t = await askText(ctx, '파일 이름 입력 <new block>:', 'new block');
        target = wblockTarget(t || 'new block');
        if (!target) ctx.print('파일 이름에 쓸 수 없는 문자가 있습니다.', 'err');
      }
      let source: WblockSource | null = null;
      let chosen: string[] = [];
      while (!source) {
        const r = await ctx.getPoint('기존 블록 이름 입력 또는 [= (블록=출력 파일)/* (전체 도면)] <객체 선택 지정>:', {
          keywords: [
            { key: '=', label: '=' },
            { key: '*', label: '*' },
          ],
          allowText: true,
        });
        if ('keyword' in r && r.keyword === '*') source = { kind: 'all' };
        else if ('keyword' in r || 'text' in r) {
          const name = 'keyword' in r ? target.base : r.text.trim().replace(/^"(.*)"$/, '$1');
          const b = userBlocks(app).find((x) => tableKey(x.name) === tableKey(name));
          if (!b) {
            ctx.print(`블록 "${name}"을(를) 찾을 수 없습니다.`, 'err');
            if ('keyword' in r) return;
            continue;
          }
          source = { kind: 'block', name: b.name };
        } else if ('enter' in r) {
          const p = await ctx.getPoint('삽입 기준점 지정:');
          if (!('point' in p)) return;
          const base: Pt = p.point;
          chosen = await ctx.getSelection('객체 선택:');
          if (!chosen.length) {
            ctx.print('선택된 객체가 없습니다.', 'err');
            return;
          }
          source = { kind: 'objects', handles: chosen, base };
        }
      }
      const saved = await writeWblock(app, ctx, source, target);
      if (!saved || source.kind !== 'objects') return;
      // AutoCAD -WBLOCK: 새 도면으로 쓴 객체는 도면에서 지운다(OOPS로 되살린다)
      const space = st.space;
      const blk = doc.blocks.get(space);
      if (!blk) return;
      const order = new Map(blk.entities.map((e, i) => [e.handle, i]));
      const mine = unlockedOnly(app, chosen)
        .filter((x) => st.session.ownerOf(x) === space)
        .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      if (!mine.length) return;
      const items = mine.map((x) => ({ block: space, entity: doc.entityIndex.get(x)! as Entity, index: order.get(x) ?? -1 }));
      rememberErased(st, items);
      const removes: EditOp[] = items.map((x) => ({ kind: 'remove', ...x }));
      st.selection.clear();
      st.session.commit({ label: '-WBLOCK', ops: removes.reverse(), group: ctx.group });
      ctx.print(`객체 ${mine.length}개를 도면에서 지웠습니다(OOPS로 되살릴 수 있습니다).`);
    },
  });
}
