/**
 * 블록 명령: BLOCK(블록 정의), INSERT(블록 삽입), ATTDEF(속성 정의), EATTEDIT(속성 값 고치기)
 */
import type { AttribEntity, BlockDef, BlockRecord, Entity, InsertEntity, Vec3 } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { cloneEntity } from '../edit/session';
import { formatLength } from '../core/units';
import type { App, CommandContext } from './app';
import { addEntities, currentProps } from './draw';
import { unlockedOnly } from './layers';
import { ask, form } from './ui/dom';
import type { Pt } from './view';
import { withAnnotativeFlag } from '../edit/annoscale/xdata';

const BAD_BLOCK_NAME = /[<>/\\":;?*|,=`]/;

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

/** 블록 정의의 대략적인 외곽(미리보기용, 블록 좌표) */
function blockOutline(b: BlockDef): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const e of b.entities) {
    const a = e as unknown as Record<string, unknown>;
    switch (e.type) {
      case 'LINE':
        add((a.start as Vec3).x, (a.start as Vec3).y);
        add((a.end as Vec3).x, (a.end as Vec3).y);
        break;
      case 'CIRCLE':
      case 'ARC': {
        const c = a.center as Vec3;
        const r = a.radius as number;
        add(c.x - r, c.y - r);
        add(c.x + r, c.y + r);
        break;
      }
      case 'LWPOLYLINE':
        for (const v of a.vertices as { x: number; y: number }[]) add(v.x, v.y);
        break;
      case 'TEXT':
      case 'ATTDEF':
      case 'MTEXT':
      case 'INSERT':
        add((a.insert as Vec3).x, (a.insert as Vec3).y);
        break;
      case 'POINT':
        add((a.position as Vec3).x, (a.position as Vec3).y);
        break;
      case 'ELLIPSE': {
        const c = a.center as Vec3;
        const m = a.majorAxis as Vec3;
        const r = Math.hypot(m.x, m.y);
        add(c.x - r, c.y - r);
        add(c.x + r, c.y + r);
        break;
      }
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function registerBlockCommands(app: App): void {
  // ------------------------------------------------------------- BLOCK
  app.register({
    name: 'BLOCK',
    aliases: ['B', 'BMAKE'],
    title: '블록 정의',
    async run(ctx) {
      const st = app.active!;
      const hs = unlockedOnly(app, await ctx.getSelection('블록으로 만들 객체 선택:'));
      if (!hs.length) {
        ctx.print('고른 객체가 없습니다.');
        return;
      }
      const r = await ctx.getPoint('삽입 기준점 지정:');
      if (!('point' in r)) return;
      const basePt = r.point;
      let n = 1;
      while (st.doc.blocks.has(tableKey(`블록${n}`))) n++;
      const v = await form(
        '블록 정의',
        [
          { key: 'name', label: '이름', type: 'text', value: `블록${n}` },
          { key: 'description', label: '설명', type: 'text', value: '' },
          {
            key: 'mode',
            label: '고른 객체',
            type: 'select',
            value: 'convert',
            options: [
              { value: 'convert', label: '블록으로 변환' },
              { value: 'retain', label: '그대로 두기' },
              { value: 'delete', label: '삭제' },
            ],
          },
          { key: 'annotative', label: '주석', type: 'check', value: false },
          { key: 'matchLayout', label: '블록 방향을 배치에 일치(주석일 때)', type: 'check', value: false },
        ],
        {
          ok: '만들기',
          note: `객체 ${hs.length}개, 기준점 ${formatLength(basePt.x, st.units)}, ${formatLength(basePt.y, st.units)}`,
          validate: (x) => {
            const nm = String(x.name).trim();
            if (!nm) return '이름을 입력하십시오.';
            if (BAD_BLOCK_NAME.test(nm) || nm.startsWith('*')) return '이름에 쓸 수 없는 문자가 있습니다.';
            if (st.doc.blocks.has(tableKey(nm))) return '같은 이름의 블록이 이미 있습니다.';
            return null;
          },
        },
      );
      if (!v) return;
      const name = String(v.name).trim();
      const mode = String(v.mode);
      const recordHandle = st.session.newHandle();
      const ops: EditOp[] = [];
      const ents: Entity[] = [];
      const space = st.space;
      const block = st.doc.blocks.get(space)!;
      // 고른 순서가 아니라 그리기 순서대로
      const order = new Map(block.entities.map((e, i) => [e.handle, i]));
      const chosen = hs.filter((x) => st.session.ownerOf(x) === space).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      const removeOps: EditOp[] = [];
      for (const h of chosen) {
        const e = st.doc.entityIndex.get(h)!;
        const c = cloneEntity(e);
        c.owner = recordHandle;
        if (mode !== 'retain') {
          removeOps.push({ kind: 'remove', block: space, entity: e, index: order.get(h) ?? -1 });
        } else {
          c.handle = st.session.newHandle();
          if (c.type === 'INSERT') for (const a of c.attribs) a.handle = st.session.newHandle();
        }
        ents.push(c);
      }
      // 지우기는 뒤에서부터(앞 객체를 지워도 뒤 번호가 맞게)
      ops.push(...removeOps.reverse());
      const hasAtt = ents.some((e) => e.type === 'ATTDEF');
      const record: BlockRecord = { name, handle: recordHandle, flags: 0, insertUnits: Number(st.doc.header.get('$INSUNITS') ?? 0) || 0, explodable: true, scalable: true };
      // 주석 블록(AcadAnnotative, 방향 일치는 AcadAnnoPO 1070 1)
      if (v.annotative) record.xdata = [...withAnnotativeFlag(undefined, true), ...(v.matchLayout ? [{ app: 'AcadAnnoPO', items: [{ code: 1070 as const, value: 1 }] }] : [])];
      const def: BlockDef = {
        name,
        handle: st.session.newHandle(),
        recordHandle,
        basePoint: { x: basePt.x, y: basePt.y, z: 0 },
        flags: hasAtt ? 2 : 0,
        description: String(v.description) || undefined,
        layer: '0',
        entities: ents,
        endHandle: st.session.newHandle(),
      };
      ops.push({ kind: 'blockRecord', key: tableKey(name), before: null, after: record }, { kind: 'blockDef', key: tableKey(name), before: null, after: def });
      let insHandle: string | null = null;
      if (mode === 'convert') {
        const ins: InsertEntity = {
          ...entityDefaults(),
          ...currentProps(app),
          type: 'INSERT',
          handle: st.session.newHandle(),
          owner: block.recordHandle,
          block: name,
          insert: { x: basePt.x, y: basePt.y, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
          rotation: 0,
          columnCount: 1,
          rowCount: 1,
          columnSpacing: 0,
          rowSpacing: 0,
          attribs: [],
        };
        ins.attribs = makeAttribs(app, def, ins.insert, ins.scale, 0, new Map(), ins.handle);
        insHandle = ins.handle;
        ops.push({ kind: 'add', block: space, entity: ins });
      }
      st.selection.clear();
      st.session.commit({ label: 'BLOCK', ops });
      if (insHandle) app.setSelection([insHandle]);
      ctx.print(`블록 "${name}"을(를) 만들었습니다(객체 ${ents.length}개).`);
    },
  });

  // ------------------------------------------------------------- INSERT
  app.register({
    name: 'INSERT',
    aliases: ['I', 'DDINSERT', 'CLASSICINSERT'],
    title: '블록 삽입',
    async run(ctx, arg) {
      const st = app.active!;
      const blocks = userBlocks(app);
      if (!blocks.length) {
        ctx.print('이 도면에는 삽입할 블록이 없습니다. BLOCK 명령으로 먼저 만드십시오.', 'err');
        return;
      }
      let name = arg && st.doc.blocks.has(tableKey(arg)) ? st.doc.blocks.get(tableKey(arg))!.name : '';
      let sx = 1;
      let sy = 1;
      let rotDeg = 0;
      let explode = false;
      if (!name) {
        const v = await form(
          '블록 삽입',
          [
            { key: 'name', label: '블록', type: 'select', value: blocks[0]!.name, options: blocks.map((b) => ({ value: b.name, label: `${b.name}${b.description ? ` — ${b.description}` : ''}` })) },
            { key: 'sx', label: '축척 X', type: 'number', value: 1 },
            { key: 'sy', label: '축척 Y', type: 'number', value: 1 },
            { key: 'rot', label: '회전(도)', type: 'number', value: 0 },
            { key: 'explode', label: '분해해서 넣기', type: 'check', value: false },
          ],
          { ok: '삽입', validate: (x) => (Number(x.sx) === 0 || Number(x.sy) === 0 ? '축척은 0일 수 없습니다.' : null) },
        );
        if (!v) return;
        name = String(v.name);
        sx = Number(v.sx);
        sy = Number(v.sy);
        rotDeg = Number(v.rot);
        explode = !!v.explode;
      }
      const def = st.doc.blocks.get(tableKey(name))!;
      const box = blockOutline(def);
      const rot = (rotDeg * Math.PI) / 180;
      const scale = { x: sx, y: sy, z: 1 };
      const preview = (p: Pt) => {
        if (!box) return [];
        const tf = insertTransform(def, { x: p.x, y: p.y, z: 0 }, scale, rot);
        const pts = [
          [box.minX, box.minY],
          [box.maxX, box.minY],
          [box.maxX, box.maxY],
          [box.minX, box.maxY],
        ].flatMap(([x, y]) => {
          const q = tf({ x: x!, y: y!, z: 0 });
          return [q.x, q.y];
        });
        return [{ pts, closed: true, dashed: true }];
      };
      const r = await ctx.getPoint('삽입점 지정:', { rubber: preview });
      if (!('point' in r)) return;
      const insPt = { x: r.point.x, y: r.point.y, z: 0 };
      // 속성 값 묻기
      const defs = def.entities.filter((e): e is AttribEntity => e.type === 'ATTDEF' && !((e as AttribEntity).attFlags & 2));
      const values = new Map<string, string>();
      if (defs.length && !explode) {
        const ask = defs.filter((d) => !(d.attFlags & 8));
        if (ask.length) {
          const v = await form(
            '속성 값',
            ask.map((d, i) => ({ key: `a${i}`, label: d.prompt || d.tag, type: 'text' as const, value: d.text })),
            { ok: '확인' },
          );
          if (v) ask.forEach((d, i) => values.set(d.tag, String(v[`a${i}`])));
        }
      }
      const handle = st.session.newHandle();
      const ins: InsertEntity = {
        ...entityDefaults(),
        ...currentProps(app),
        type: 'INSERT',
        handle,
        block: def.name,
        insert: insPt,
        scale,
        rotation: rot,
        columnCount: 1,
        rowCount: 1,
        columnSpacing: 0,
        rowSpacing: 0,
        attribs: [],
      };
      ins.attribs = makeAttribs(app, def, insPt, scale, rot, values, handle);
      if (explode) {
        const parts = explodeInsertSimple(app, ins, def);
        addEntities(app, ctx, parts, 'INSERT');
        ctx.print(`블록 "${def.name}"을(를) 분해해서 객체 ${parts.length}개로 넣었습니다.`);
        return;
      }
      addEntities(app, ctx, [ins], 'INSERT');
    },
  });

  // ------------------------------------------------------------- ATTDEF
  app.register({
    name: 'ATTDEF',
    aliases: ['ATT', 'DDATTDEF'],
    title: '속성 정의',
    async run(ctx) {
      const st = app.active!;
      const defH = Number(st.doc.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
      const v = await form(
        '속성 정의',
        [
          { key: 'tag', label: '태그', type: 'text', value: '' },
          { key: 'prompt', label: '프롬프트', type: 'text', value: '' },
          { key: 'value', label: '기본값', type: 'text', value: '' },
          { key: 'height', label: '문자 높이', type: 'number', value: defH },
          { key: 'invisible', label: '보이지 않음', type: 'check', value: false },
          { key: 'constant', label: '상수', type: 'check', value: false },
          { key: 'preset', label: '미리 설정', type: 'check', value: false },
        ],
        {
          validate: (x) => {
            const t = String(x.tag).trim();
            if (!t) return '태그를 입력하십시오.';
            if (/\s/.test(t)) return '태그에는 빈칸을 쓸 수 없습니다.';
            if (!(Number(x.height) > 0)) return '문자 높이는 0보다 커야 합니다.';
            return null;
          },
        },
      );
      if (!v) return;
      const r = await ctx.getPoint('시작점 지정:');
      if (!('point' in r)) return;
      const styleName = String(st.doc.header.get('$TEXTSTYLE') ?? 'Standard');
      const att: AttribEntity = {
        ...entityDefaults(),
        ...currentProps(app),
        type: 'ATTDEF',
        handle: '',
        insert: { x: r.point.x, y: r.point.y, z: 0 },
        height: Number(v.height),
        text: String(v.value),
        rotation: 0,
        widthFactor: 1,
        oblique: 0,
        style: st.doc.textStyles.get(tableKey(styleName))?.name ?? styleName,
        generation: 0,
        halign: 0,
        valign: 0,
        tag: String(v.tag).trim().toUpperCase(),
        prompt: String(v.prompt) || undefined,
        attFlags: (v.invisible ? 1 : 0) | (v.constant ? 2 : 0) | (v.preset ? 8 : 0),
      };
      addEntities(app, ctx, [att as Entity], 'ATTDEF');
    },
  });

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

/** 블록 참조의 속성 값을 대화상자로 고친다 */
export async function editAttributes(app: App, ctx: CommandContext | null, handle: string): Promise<boolean> {
  const st = app.active!;
  const e = st.doc.entityIndex.get(handle);
  if (e?.type !== 'INSERT' || !e.attribs.length) {
    (ctx ?? app.cmd).print('속성이 있는 블록이 아닙니다.', 'err');
    return false;
  }
  if (!unlockedOnly(app, [handle]).length) return false;
  const vis = e.attribs.filter((a) => !(a.attFlags & 2));
  const v = await form(
    `속성 편집 — ${e.block}`,
    vis.map((a, i) => ({ key: `a${i}`, label: a.tag, type: (a.mtext ? 'textarea' : 'text') as 'text', value: a.mtext ? a.mtext.text.replace(/\\P/g, '\n') : a.text })),
  );
  if (!v) return false;
  const c = cloneEntity(e);
  const cv = c.attribs.filter((a) => !(a.attFlags & 2));
  cv.forEach((a, i) => {
    const t = String(v[`a${i}`]);
    if (a.mtext) a.mtext.text = t.replace(/\r?\n/g, '\\P');
    a.text = t.replace(/\r?\n/g, ' ');
  });
  if (JSON.stringify(c) === JSON.stringify(e)) return false;
  const block = st.session.ownerOf(handle);
  if (!block) return false;
  st.session.commit({ label: 'EATTEDIT', ops: [{ kind: 'modify', block, before: e, after: c }] });
  return true;
}

/** 축척·회전만 있는 블록 참조를 블록 안 객체로 풀어낸다(삽입할 때 분해 옵션) */
function explodeInsertSimple(app: App, ins: InsertEntity, def: BlockDef): Entity[] {
  const st = app.active!;
  const tf = insertTransform(def, ins.insert, ins.scale, ins.rotation);
  const uniform = Math.abs(Math.abs(ins.scale.x) - Math.abs(ins.scale.y)) < 1e-12 ? Math.abs(ins.scale.x) : null;
  const out: Entity[] = [];
  for (const e of def.entities) {
    if (e.type === 'ATTDEF') continue;
    const c = cloneEntity(e) as Entity & Record<string, unknown>;
    c.handle = st.session.newHandle();
    switch (c.type) {
      case 'LINE':
        c.start = tf(c.start as Vec3);
        c.end = tf(c.end as Vec3);
        break;
      case 'POINT':
        c.position = tf(c.position as Vec3);
        break;
      case 'CIRCLE':
      case 'ARC':
        if (uniform === null) continue;
        c.center = tf(c.center as Vec3);
        c.radius = (c.radius as number) * uniform;
        if (c.type === 'ARC') {
          c.startAngle = (c.startAngle as number) + ins.rotation;
          c.endAngle = (c.endAngle as number) + ins.rotation;
        }
        break;
      case 'LWPOLYLINE':
        if (uniform === null) continue;
        for (const v of c.vertices as { x: number; y: number }[]) {
          const q = tf({ x: v.x, y: v.y, z: 0 });
          v.x = q.x;
          v.y = q.y;
        }
        break;
      case 'TEXT':
      case 'MTEXT':
        c.insert = tf(c.insert as Vec3);
        if (c.alignPoint) c.alignPoint = tf(c.alignPoint as Vec3);
        c.height = (c.height as number) * Math.abs(ins.scale.y);
        c.rotation = (c.rotation as number) + ins.rotation;
        if (c.type === 'MTEXT') c.direction = undefined;
        break;
      default:
        // 나머지는 분해 명령(EXPLODE)에서 정확히 처리한다
        continue;
    }
    if (c.layer === '0') c.layer = ins.layer;
    out.push(c);
  }
  return out;
}
