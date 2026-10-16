/**
 * 블록 명령: BLOCK·-BLOCK(블록 정의·재정의 — blockdefine.ts), INSERT·ATTDEF·EATTEDIT(blockinsert.ts), BEDIT·BSAVE·BCLOSE
 */
import type { AttribEntity, BlockDef, Vec3 } from '../core/model';
import { tableKey } from '../core/model';
import { cloneEntity } from '../edit/session';
import type { App, CommandContext } from './app';
import { ask, form } from './ui/dom';
import { registerBlockDefine } from './blockdefine';
import { enhancedAttributeEditor, registerInsertAttdef } from './blockinsert';

/** 사용자가 고를 수 있는 블록(배치·익명 블록 빼고) */
export function userBlocks(app: App): BlockDef[] {
  const st = app.active!;
  return [...st.doc.blocks.values()].filter((b) => !b.name.startsWith('*') && !(b.flags & 4) && !b.name.includes('|')).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** 블록 정의를 블록 좌표 → 도면 좌표로 옮기는 2D 변환 */
function insertTransform(b: BlockDef, ins: Vec3, scale: Vec3, rot: number): (p: Vec3) => Vec3 {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return (p) => {
    const x = (p.x - b.basePoint.x) * scale.x;
    const y = (p.y - b.basePoint.y) * scale.y;
    return { x: ins.x + x * c - y * s, y: ins.y + x * s + y * c, z: ins.z + (p.z - b.basePoint.z) * scale.z };
  };
}

/** 블록 정의의 속성 정의(ATTDEF)로 블록 참조의 속성(ATTRIB)을 만든다 */
export function makeAttribs(app: App, b: BlockDef, ins: Vec3, scale: Vec3, rot: number, values: Map<string, string>, insertHandle: string): AttribEntity[] {
  const st = app.active!;
  const tf = insertTransform(b, ins, scale, rot);
  const out: AttribEntity[] = [];
  for (const e of b.entities) {
    if (e.type !== 'ATTDEF') continue;
    const d = e as AttribEntity;
    if (d.attFlags & 2) continue; // 상수 속성은 블록 안에서 그린다
    const a = cloneEntity(d);
    a.type = 'ATTRIB';
    a.handle = st.session.newHandle();
    a.owner = insertHandle;
    a.insert = tf(d.insert);
    if (d.alignPoint) a.alignPoint = tf(d.alignPoint);
    a.height = d.height * Math.abs(scale.y);
    a.rotation = d.rotation + rot;
    a.text = values.get(d.tag) ?? d.text;
    a.prompt = undefined;
    if (a.mtext) {
      a.mtext.insert = tf(a.mtext.insert);
      a.mtext.height *= Math.abs(scale.y);
      a.mtext.rotation += rot;
      a.mtext.direction = undefined;
      a.mtext.text = values.get(d.tag) ?? a.mtext.text;
      a.mtext.handle = '';
    }
    out.push(a);
  }
  return out;
}

export function registerBlockCommands(app: App): void {
  // ------------------------------------------------------------- BLOCK·-BLOCK(blockdefine.ts)
  registerBlockDefine(app, (def, ins) => makeAttribs(app, def, ins.insert, ins.scale, ins.rotation, new Map(), ins.handle));

  // ------------------------------------------------------------- INSERT·ATTDEF(blockinsert.ts)
  registerInsertAttdef(app, (def, ins, scale, rot, values, handle) => makeAttribs(app, def, ins, scale, rot, values, handle));

  // ------------------------------------------------------------- EATTEDIT
  app.register({
    name: 'EATTEDIT',
    aliases: ['ATTEDIT', 'DDATTE', 'ATE'],
    title: '속성 값 편집',
    async run(ctx) {
      const r = await ctx.getEntity('블록 선택:');
      if (!('handle' in r)) return;
      await editAttributes(app, ctx, r.handle);
    },
  });

  // ------------------------------------------------------------- BEDIT·BSAVE·BCLOSE
  app.register({
    name: 'BEDIT',
    aliases: ['BE'],
    title: '블록 편집기',
    async run(ctx) {
      const st = app.active!;
      const editable = [...st.doc.blocks.values()].filter((b) => !b.name.startsWith('*') && !(b.flags & (4 | 16)) && !b.xrefPath).sort((a, b) => a.name.localeCompare(b.name));
      if (!editable.length) {
        ctx.print('편집할 수 있는 블록이 없습니다.', 'err');
        return;
      }
      // 블록 참조 하나를 고른 상태면 그 블록
      const sel = [...st.selection].map((h) => st.doc.entityIndex.get(h)).find((e) => e?.type === 'INSERT');
      const pre = sel?.type === 'INSERT' && editable.some((b) => tableKey(b.name) === tableKey(sel.block)) ? sel.block : editable[0]!.name;
      const v = await form(
        '블록 정의 편집',
        [{ key: 'name', label: '편집할 블록', type: 'select', value: editable.find((b) => tableKey(b.name) === tableKey(pre))!.name, options: editable.map((b) => ({ value: b.name, label: `${b.name} (객체 ${b.entities.length}개)` })) }],
        { ok: '확인', note: '블록 편집기에서 그리기·수정 명령으로 블록 정의를 고칩니다. 닫으면 이 블록의 모든 참조가 바뀝니다.' },
      );
      if (!v) return;
      if (await app.openBlockEditor(String(v.name))) ctx.print(`블록 편집기: ${String(v.name)}. 끝내려면 BCLOSE를 입력하십시오.`);
    },
  });
  app.register({
    name: 'BSAVE',
    title: '블록 저장',
    run(ctx) {
      const st = app.active!;
      if (!st.blockEdit) {
        ctx.print('블록 편집기에서만 쓸 수 있습니다.', 'err');
        return;
      }
      st.blockEdit.depth = st.session.depth;
      ctx.print(`블록 ${st.blockEdit.name}을(를) 저장했습니다.`);
    },
  });
  app.register({
    name: 'BCLOSE',
    title: '블록 편집기 닫기',
    async run(ctx) {
      const st = app.active!;
      const be = st.blockEdit;
      if (!be) {
        ctx.print('블록 편집기에서만 쓸 수 있습니다.', 'err');
        return;
      }
      let save = true;
      if (st.session.depth > be.depth) {
        const a = await ask('블록 - 변경 사항이 저장되지 않음', `블록 ${be.name}의 변경 사항을 저장하시겠습니까?`, [
          { label: '변경 사항을 저장', value: 'save', primary: true },
          { label: '변경 사항 취소', value: 'discard' },
        ]);
        if (a === null) return;
        save = a === 'save';
      }
      await app.closeBlockEditor(save);
      ctx.print(save ? `블록 ${be.name}을(를) 고쳤습니다.` : `블록 ${be.name}의 변경을 버렸습니다.`);
    },
  });
}

/** 블록 참조의 속성을 향상된 속성 편집기(속성·문자 옵션·특성 탭)로 고친다 */
export async function editAttributes(app: App, ctx: CommandContext | null, handle: string): Promise<boolean> {
  return enhancedAttributeEditor(app, ctx, handle);
}
