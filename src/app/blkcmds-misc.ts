/**
 * 블록·명령 기타: UNDEFINE·REDEFINE(명령 정의 해제·되돌리기, `.이름`은 원래 명령), BASE(도면 삽입 기준점),
 * TINSERT(표 셀에 블록), PASTESPEC(선택하여 붙여넣기), DIMEX·DIMIM(Express: 치수 스타일 .dim 파일).
 */
import type { AttribEntity, CadDocument, Entity, InsertEntity, MTextEntity, TableEntity, Vec3 } from '../core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../core/model';
import { formatLength } from '../core/units';
import { importDimStylesOps, parseDimFile, writeDimFile } from '../edit/blkcmds/dimfile';
import { cellPlacement } from '../edit/blkcmds/tinsert';
import { matchNameList } from '../edit/layercmd';
import { isEditableTable, tableFromEntity } from '../edit/table/entity';
import { anchorOf, cellAt, cellRect } from '../edit/table/model';
import type { App, Command, CommandContext } from './app';
import { blockGeometry, geometryBounds } from './blockpreview';
import { makeAttribs, userBlocks } from './blocks';
import { askOption, askReal, askWord, askYN, fmt4 } from './dashcmds-ask';
import { addEntities, currentProps } from './draw';
import { baseName } from './export';
import { lispSession } from './lisp';
import { clipboardContent } from './modify';
import { expandDisplayList } from './pick';
import { SceneBuilder } from '../render/build';
import { commandLineMode } from './script';
import { rememberFile } from './sessionfiles';
import { form, h } from './ui/dom';
import { checkbox, modal, select, textInput } from './util2-ui';
import { outputName, pickOneFile, readTextFile, registerOnce, saveText } from './blkcmds-io';
import { attachImageFile } from './blkcmds-xref';

// ---------------------------------------------------------------------------
// UNDEFINE·REDEFINE
// ---------------------------------------------------------------------------

/** 정의 해제한 명령(이름 → 원래 명령) */
const undefinedCmds = new WeakMap<App, Map<string, Command>>();
const hooked = new WeakSet<App>();

function undefinedOf(app: App): Map<string, Command> {
  let m = undefinedCmds.get(app);
  if (!m) undefinedCmds.set(app, (m = new Map()));
  return m;
}

/** 정의 해제한 명령의 이름인지(스크립트·AutoLISP 연결용) */
export function isUndefinedCommand(app: App, name: string): boolean {
  return undefinedOf(app).has(name.trim().toUpperCase().replace(/^[_.']+/, ''));
}

/** `.이름`·`_.이름`·`._이름`은 정의 해제했어도 원래 명령을 찾게 한다(App.findCommand를 감싼다) */
function hookDotLookup(app: App): void {
  if (hooked.has(app)) return;
  hooked.add(app);
  const orig = app.findCommand.bind(app);
  app.findCommand = (name: string) => {
    const t = name.trim().toUpperCase();
    if (/^['_]*\./.test(t)) {
      const hit = undefinedOf(app).get(t.replace(/^['_.]+/, ''));
      if (hit) return hit;
    }
    return orig(name);
  };
}

const PROTECTED = new Set(['UNDEFINE', 'REDEFINE']);

async function askCommandName(ctx: CommandContext): Promise<string | null> {
  const t = await askWord(ctx, '명령 이름 입력:');
  if (!t) return null;
  return t.trim().toUpperCase().replace(/^_+/, '');
}

function registerRedefine(app: App): void {
  hookDotLookup(app);
  registerOnce(app, {
    name: 'UNDEFINE',
    title: '명령 정의 해제',
    noDoc: true,
    async run(ctx) {
      const n = await askCommandName(ctx);
      if (!n) return;
      const und = undefinedOf(app);
      if (und.has(n)) {
        ctx.print(`${n}은(는) 이미 정의 해제된 명령입니다. REDEFINE으로 되돌립니다.`);
        return;
      }
      if (PROTECTED.has(n)) {
        ctx.print(`${n}은(는) 정의 해제할 수 없습니다.`, 'err');
        return;
      }
      const lisp = lispSession(app);
      let builtin: Command | undefined;
      const lispOwned = lisp.commands.has(n);
      if (lispOwned) builtin = lisp.overridden.get(n);
      else builtin = app.commands.get(n);
      if (!builtin || n.startsWith('.')) {
        ctx.print('알 수 없는 명령 이름입니다.', 'err');
        return;
      }
      und.set(n, builtin);
      if (!lispOwned) app.commands.delete(n);
      ctx.print(`${n} 명령의 정의를 해제했습니다. 원래 명령은 .${n}(으)로 부르고, REDEFINE으로 되돌립니다.${lispOwned ? ` AutoLISP 명령 C:${n}이(가) 계속 실행됩니다.` : ' (defun c:…)로 같은 이름의 명령을 만들 수 있습니다.'}`);
    },
  });
  registerOnce(app, {
    name: 'REDEFINE',
    title: '명령 정의 되돌리기',
    noDoc: true,
    async run(ctx) {
      const n = await askCommandName(ctx);
      if (!n) return;
      const und = undefinedOf(app);
      const builtin = und.get(n);
      if (!builtin) {
        ctx.print(app.findCommand(n) ? `${n}은(는) 정의 해제된 명령이 아닙니다.` : '알 수 없는 명령 이름입니다.', 'err');
        return;
      }
      und.delete(n);
      const lisp = lispSession(app);
      app.commands.set(n, builtin);
      if (lisp.commands.has(n)) {
        // AutoCAD처럼 내장 명령이 AutoLISP 명령보다 먼저다(다시 정의 해제하면 AutoLISP 명령이 실행된다)
        lisp.overridden.set(n, builtin);
        ctx.print(`${n} 명령을 되돌렸습니다. AutoLISP 명령은 (c:${n.toLowerCase()})로 부르십시오.`);
      } else ctx.print(`${n} 명령을 되돌렸습니다.`);
    },
  });
}

// ---------------------------------------------------------------------------
// BASE
// ---------------------------------------------------------------------------

function registerBase(app: App): void {
  registerOnce(app, {
    name: 'BASE',
    title: '도면 삽입 기준점',
    async run(ctx) {
      const st = app.active!;
      const key = st.onLayout ? '$PINSBASE' : '$INSBASE';
      const v = st.doc.header.get(key);
      const cur: Vec3 = v && typeof v === 'object' ? { x: v.x, y: v.y, z: 'z' in v ? v.z : 0 } : { x: 0, y: 0, z: 0 };
      const f = (x: number) => formatLength(x, st.units);
      const r = await ctx.getPoint(`기준점 입력 <${f(cur.x)},${f(cur.y)},${f(cur.z)}>:`);
      if (!('point' in r)) return;
      const after: Vec3 = { x: r.point.x, y: r.point.y, z: cur.z };
      st.session.commit({ label: 'BASE', ops: [{ kind: 'header', name: key, before: v, after }], group: ctx.group });
      ctx.print(`도면 삽입 기준점(${key.slice(1)}): ${f(after.x)},${f(after.y)},${f(after.z)}. 이 도면을 다른 도면에 삽입·외부 참조하면 이 점이 기준점이 됩니다.`);
    },
  });
}

// ---------------------------------------------------------------------------
// TINSERT
// ---------------------------------------------------------------------------

function registerTinsert(app: App): void {
  registerOnce(app, {
    name: 'TINSERT',
    title: '표 셀에 블록 삽입',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const blocks = userBlocks(app);
      if (!blocks.length) {
        ctx.print('이 도면에는 삽입할 블록이 없습니다.', 'err');
        return;
      }
      // 셀 고르기
      let picked: { e: TableEntity | InsertEntity; rect: { x0: number; x1: number; y0: number; y1: number }; hm: number; vm: number } | null = null;
      while (!picked) {
        const r = await ctx.getEntity('표 셀 선택:');
        if (!('handle' in r)) return;
        const e = doc.entityIndex.get(r.handle);
        if (!isEditableTable(e)) {
          ctx.print('표가 아닙니다.', 'err');
          continue;
        }
        const rt = tableFromEntity(e, doc);
        if (!rt) {
          ctx.print('이 표는 읽을 수 없습니다.', 'err');
          continue;
        }
        const ang = e.type === 'ACAD_TABLE' ? Math.atan2(e.direction.y, e.direction.x) : e.rotation;
        const dx = r.point.x - e.insert.x;
        const dy = r.point.y - e.insert.y;
        const c = Math.cos(-ang);
        const s = Math.sin(-ang);
        const lx = (dx * c - dy * s) / (e.scale.x || 1);
        const ly = (dx * s + dy * c) / (e.scale.y || 1);
        const at = cellAt(rt.data, lx, ly, rt.style.flow);
        if (!at) {
          ctx.print('셀 안을 고르십시오.', 'err');
          continue;
        }
        const a = anchorOf(rt.data, at.r, at.c);
        picked = { e, rect: cellRect(rt.data, a.r, a.c, rt.style.flow), hm: rt.style.hMargin, vm: rt.style.vMargin };
      }
      const sel = [...st.selection].map((x) => doc.entityIndex.get(x)).find((x) => x?.type === 'INSERT');
      let name = sel?.type === 'INSERT' && blocks.some((b) => tableKey(b.name) === tableKey(sel.block)) ? blocks.find((b) => tableKey(b.name) === tableKey(sel.block))!.name : blocks[0]!.name;
      let autofit = true;
      let scale = 1;
      let rotDeg = 0;
      let align = 5;
      if (commandLineMode(app)) {
        for (;;) {
          const t = await askWord(ctx, `블록 이름 입력 또는 [?] <${name}>:`, [{ key: '?', label: '?' }]);
          if (t === null) break;
          if (t === '?') {
            ctx.print(blocks.map((b) => b.name).join(', '));
            continue;
          }
          const b = blocks.find((x) => tableKey(x.name) === tableKey(t));
          if (b) {
            name = b.name;
            break;
          }
          ctx.print(`블록 "${t}"을(를) 찾을 수 없습니다.`, 'err');
        }
        autofit = await askYN(ctx, '셀에 맞춰 자동 축척', true);
        if (!autofit) scale = await askReal(ctx, `축척 비율 지정 <${fmt4(1)}>:`, 1, (v) => (v > 0 ? null : '축척은 0보다 커야 합니다.'));
        rotDeg = await askReal(ctx, '회전 각도 지정 <0>:', 0);
      } else {
        const v = await form(
          '표 셀에 블록 삽입',
          [
            { key: 'name', label: '이름', type: 'select', value: name, options: blocks.map((b) => ({ value: b.name, label: b.name })) },
            { key: 'autofit', label: '자동 맞춤', type: 'check', value: true },
            { key: 'scale', label: '축척(자동 맞춤이 아닐 때)', type: 'number', value: 1 },
            { key: 'rot', label: '회전 각도(도)', type: 'number', value: 0 },
            {
              key: 'align',
              label: '전체 셀 정렬',
              type: 'select',
              value: '5',
              options: ['맨 위 왼쪽', '맨 위 중심', '맨 위 오른쪽', '중간 왼쪽', '중간 중심', '중간 오른쪽', '맨 아래 왼쪽', '맨 아래 중심', '맨 아래 오른쪽'].map((l, i) => ({ value: String(i + 1), label: l })),
            },
          ],
          { ok: '확인', validate: (x) => (x.autofit || Number(x.scale) > 0 ? null : '축척은 0보다 커야 합니다.') },
        );
        if (!v) return;
        name = String(v.name);
        autofit = !!v.autofit;
        scale = Number(v.scale);
        rotDeg = Number(v.rot);
        align = Number(v.align);
      }
      const def = doc.blocks.get(tableKey(name))!;
      const g = blockGeometry(app, doc, def.name);
      const box = (g && geometryBounds(g)) ?? [def.basePoint.x, def.basePoint.y, def.basePoint.x + 1, def.basePoint.y + 1];
      const t = picked.e;
      const tAng = t.type === 'ACAD_TABLE' ? Math.atan2(t.direction.y, t.direction.x) : t.rotation;
      const pl = cellPlacement({
        cell: picked.rect,
        hMargin: picked.hm,
        vMargin: picked.vm,
        box: box as [number, number, number, number],
        base: def.basePoint,
        autofit,
        scale,
        rotation: (rotDeg * Math.PI) / 180,
        align,
        table: { insert: t.insert, angle: tAng, scale: t.scale.x || 1 },
      });
      const values = new Map<string, string>();
      const ask = def.entities.filter((e): e is AttribEntity => e.type === 'ATTDEF' && !((e as AttribEntity).attFlags & (2 | 8)));
      if (ask.length && !commandLineMode(app)) {
        const v = await form(
          '속성 값',
          ask.map((d, i) => ({ key: `a${i}`, label: d.prompt || d.tag, type: 'text' as const, value: d.text })),
          { ok: '확인' },
        );
        if (v) ask.forEach((d, i) => values.set(d.tag, String(v[`a${i}`])));
      }
      const handle = st.session.newHandle();
      const sc = { x: pl.scale, y: pl.scale, z: pl.scale };
      const ins: InsertEntity = {
        ...entityDefaults(),
        ...currentProps(app),
        type: 'INSERT',
        handle,
        block: def.name,
        insert: pl.insert,
        scale: sc,
        rotation: pl.rotation,
        columnCount: 1,
        rowCount: 1,
        columnSpacing: 0,
        rowSpacing: 0,
        attribs: [],
      };
      if (/^\*PAPER_SPACE/i.test(st.space)) ins.paperSpace = true;
      ins.attribs = makeAttribs(app, def, pl.insert, sc, pl.rotation, values, handle);
      app.lastCreated = addEntities(app, ctx, [ins], 'TINSERT');
      ctx.print(`블록 ${def.name}을(를) 셀에 맞춰 넣었습니다(축척 ${+pl.scale.toPrecision(6)}). 참고: 이 버전은 셀 안에 블록을 담는 표 형식을 쓰지 않아 셀 자리에 맞춘 별도의 블록 참조로 넣습니다(표를 옮기면 함께 옮기십시오).`);
    },
  });
}

// ---------------------------------------------------------------------------
// PASTESPEC
// ---------------------------------------------------------------------------

/** 시스템 클립보드의 그림·글(읽을 수 없으면 비어 있다) */
async function readSystemClipboard(): Promise<{ image: Blob | null; text: string | null; error: string | null }> {
  const out: { image: Blob | null; text: string | null; error: string | null } = { image: null, text: null, error: null };
  const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!cb) return { ...out, error: '이 브라우저에서는 시스템 클립보드를 읽을 수 없습니다.' };
  try {
    if (cb.read) {
      for (const it of await cb.read()) {
        const it2 = it.types.find((t) => t.startsWith('image/'));
        if (it2 && !out.image) out.image = await it.getType(it2);
        if (it.types.includes('text/plain') && out.text === null) out.text = await (await it.getType('text/plain')).text();
      }
    } else if (cb.readText) out.text = await cb.readText();
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  if (out.text !== null && !out.text.trim()) out.text = null;
  return out;
}

/** 복사한 객체를 흰 바탕 검은 선의 PNG로 그린다(긴 변 최대 2000화소). 그릴 것이 없으면 null */
async function objectsToPng(app: App, doc: CadDocument, entities: readonly Entity[]): Promise<{ blob: Blob; width: number } | null> {
  let g;
  try {
    const b = new SceneBuilder(doc, { text: app.text });
    b.prepare(MODEL_SPACE);
    g = expandDisplayList(b.buildEntities(entities));
  } catch {
    return null;
  }
  const box = geometryBounds(g);
  if (!box) return null;
  const bw = Math.max(box[2] - box[0], 1e-9);
  const bh = Math.max(box[3] - box[1], 1e-9);
  const pad = 8;
  const k = 2000 / Math.max(bw, bh);
  const W = Math.max(1, Math.ceil(bw * k)) + pad * 2;
  const H = Math.max(1, Math.ceil(bh * k)) + pad * 2;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  if (!x) return null;
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, W, H);
  const X = (v: number) => pad + (v - box[0]) * k;
  const Y = (v: number) => H - pad - (v - box[1]) * k;
  x.fillStyle = '#000000';
  x.strokeStyle = '#000000';
  x.lineWidth = Math.max(1, Math.round(Math.max(W, H) / 1000));
  const tris = g.tris ?? [];
  x.beginPath();
  for (let i = 0; i + 5 < tris.length; i += 6) {
    x.moveTo(X(tris[i]!), Y(tris[i + 1]!));
    x.lineTo(X(tris[i + 2]!), Y(tris[i + 3]!));
    x.lineTo(X(tris[i + 4]!), Y(tris[i + 5]!));
    x.closePath();
  }
  x.fill();
  x.beginPath();
  for (let i = 0; i + 3 < g.segs.length; i += 4) {
    x.moveTo(X(g.segs[i]!), Y(g.segs[i + 1]!));
    x.lineTo(X(g.segs[i + 2]!), Y(g.segs[i + 3]!));
  }
  x.stroke();
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  c.width = c.height = 0;
  // 그림 폭(도면 단위): 여백까지 넣은 실제 크기
  return blob ? { blob, width: W / k } : null;
}

/** 글을 여러 줄 문자 서식으로(\, {, }는 이스케이프, 줄바꿈은 \P) */
function toMText(s: string): string {
  return s
    .replace(/\r\n|\r/g, '\n')
    .replace(/[\\{}]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\P');
}

function registerPasteSpec(app: App): void {
  registerOnce(app, {
    name: 'PASTESPEC',
    aliases: ['PA'],
    title: '선택하여 붙여넣기',
    async run(ctx) {
      const st = app.active!;
      const clip = clipboardContent();
      const own = clip?.entities.length ?? 0;
      const sys = await readSystemClipboard();
      const opts: { value: string; label: string }[] = [];
      if (own) {
        opts.push({ value: 'objects', label: `AutoCAD 도면 요소(원래 객체, ${own}개)` });
        opts.push({ value: 'block', label: '블록(블록으로 붙여넣기)' });
        opts.push({ value: 'picture', label: '이미지 개체(복사한 객체를 PNG 그림으로)' });
      }
      if (sys.image) opts.push({ value: 'image', label: `이미지 개체(${sys.image.type.replace('image/', '').toUpperCase()})` });
      if (sys.text) opts.push({ value: 'text', label: `여러 줄 문자(글 ${sys.text.length}자)` });
      if (!opts.length) {
        ctx.print(`클립보드에 붙여 넣을 내용이 없습니다.${sys.error ? ` (시스템 클립보드: ${sys.error})` : ''}`, 'err');
        return;
      }
      let kind = opts[0]!.value;
      if (commandLineMode(app)) {
        const keys: Record<string, string> = { objects: 'O', block: 'B', picture: 'P', image: 'I', text: 'T' };
        const names: Record<string, string> = { objects: '원래 객체', block: '블록', picture: '그림', image: '이미지', text: '문자' };
        const kws = opts.map((o) => ({ key: keys[o.value]!, label: names[o.value]! }));
        const k = await askOption(ctx, `붙여넣을 형식 [${kws.map((x) => `${x.label}(${x.key})`).join('/')}] <${kws[0]!.label}>:`, kws, kws[0]!.key);
        if (!k) return;
        kind = Object.keys(keys).find((x) => keys[x] === k) ?? kind;
      } else {
        const v = await form('선택하여 붙여넣기', [{ key: 'as', label: '다음으로', type: 'select', value: kind, options: opts }], {
          ok: '확인',
          note: `원본: ${own ? `이 앱 클립보드(객체 ${own}개)` : '이 앱 클립보드 비어 있음'}${sys.image || sys.text ? ', 시스템 클립보드' : ''}`,
        });
        if (!v) return;
        kind = String(v.as);
      }
      if (kind === 'objects' || kind === 'block') {
        const c = app.findCommand(kind === 'block' ? 'PASTEBLOCK' : 'PASTECLIP');
        if (c) await c.run(ctx);
        return;
      }
      const stampOf = () => {
        const d = new Date();
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
      };
      if (kind === 'picture' && clip) {
        const png = await objectsToPng(app, clip.doc, clip.entities);
        if (!png) {
          ctx.print('복사한 객체를 그림으로 만들 수 없습니다.', 'err');
          return;
        }
        const file = new File([png.blob], `${baseName(st.saveName)}_붙여넣기_${stampOf()}.png`, { type: 'image/png' });
        rememberFile(file.name, file);
        if (await attachImageFile(app, ctx, file, 'PASTESPEC', png.width)) ctx.print(`참고: 그림은 파일 ${file.name}(으)로 연결했습니다. 도면을 다른 곳에서 열려면 이 파일이 함께 있어야 합니다(ETRANSMIT로 묶으면 들어갑니다).`);
        return;
      }
      if (kind === 'image' && sys.image) {
        const ext = (sys.image.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
        const file = new File([sys.image], `${baseName(st.saveName)}_붙여넣기_${stampOf()}.${ext}`, { type: sys.image.type });
        rememberFile(file.name, file);
        if (await attachImageFile(app, ctx, file, 'PASTESPEC')) ctx.print(`참고: 그림은 파일 ${file.name}(으)로 연결했습니다. 도면을 다른 곳에서 열려면 이 파일이 함께 있어야 합니다(ETRANSMIT로 묶으면 들어갑니다).`);
        return;
      }
      if (kind === 'text' && sys.text) {
        const p = await ctx.getPoint('삽입점 지정:');
        if (!('point' in p)) return;
        const hgt = Number(st.doc.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
        const styleName = String(st.doc.header.get('$TEXTSTYLE') ?? 'Standard');
        const mt: MTextEntity = {
          ...entityDefaults(),
          ...currentProps(app),
          type: 'MTEXT',
          handle: '',
          insert: { x: p.point.x, y: p.point.y, z: 0 },
          height: hgt,
          width: 0,
          attachment: 1,
          drawingDirection: 1,
          text: toMText(sys.text),
          style: st.doc.textStyles.get(tableKey(styleName))?.name ?? styleName,
          rotation: 0,
          lineSpacingStyle: 1,
          lineSpacingFactor: 1,
          backgroundFlags: 0,
          backgroundScale: 1.5,
        };
        if (/^\*PAPER_SPACE/i.test(st.space)) mt.paperSpace = true;
        app.lastCreated = addEntities(app, ctx, [mt], 'PASTESPEC');
        ctx.print('클립보드의 글을 여러 줄 문자로 붙여 넣었습니다.');
      }
    },
  });
}

// ---------------------------------------------------------------------------
// DIMEX·DIMIM
// ---------------------------------------------------------------------------

function registerDimFile(app: App): void {
  registerOnce(app, {
    name: 'DIMEX',
    title: '치수 스타일 내보내기(.dim)',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const all = [...doc.dimStyles.values()].filter((s) => !(s.flags & 16) && !s.name.includes('|')).map((s) => s.name).sort((a, b) => a.localeCompare(b, 'ko'));
      if (!all.length) {
        ctx.print('이 도면에는 치수 스타일이 없습니다.', 'err');
        return;
      }
      const cur = String(doc.header.get('$DIMSTYLE') ?? all[0]);
      let names: string[] = [];
      let full = true;
      let fileName = `${baseName(st.saveName)}.dim`;
      if (commandLineMode(app)) {
        const spec = (await askWord(ctx, `내보낼 치수 스타일 이름 입력 <${cur}>:`)) ?? cur;
        const m = matchNameList(all, spec);
        for (const u of m.unmatched) ctx.print(`치수 스타일 "${u}"을(를) 찾을 수 없습니다.`, 'err');
        names = m.names;
        const k = await askOption(
          ctx,
          '문자 스타일 옵션 [전체 정의(F)/이름만(N)] <전체 정의>:',
          [
            { key: 'F', label: '전체 정의' },
            { key: 'N', label: '이름만' },
          ],
          'F',
        );
        full = k !== 'N';
        fileName = await outputName(app, ctx, '파일 이름 입력', fileName, '.dim');
      } else {
        const boxes = all.map((n) => ({ n, c: checkbox(` ${n}`, tableKey(n) === tableKey(cur)) }));
        const list = h('div', { style: 'max-height:38vh;overflow:auto;border:1px solid var(--border-soft);border-radius:4px;padding:4px 8px;display:flex;flex-direction:column;gap:2px;min-width:300px' }, ...boxes.map((b) => b.c.el));
        const fileIn = textInput(fileName);
        const ts = select(
          [
            { value: 'F', label: '문자 스타일 전체 정의 사용' },
            { value: 'N', label: '문자 스타일 이름만 사용' },
          ],
          'F',
        );
        const body = h(
          'div',
          {},
          h('div', { style: 'margin-bottom:4px' }, '내보낼 치수 스타일'),
          list,
          h('div', { style: 'display:flex;gap:8px;margin:6px 0' }, h('button', { class: 'btn', type: 'button', onclick: () => boxes.forEach((b) => (b.c.box.checked = true)) }, '모두 선택'), h('button', { class: 'btn', type: 'button', onclick: () => boxes.forEach((b) => (b.c.box.checked = false)) }, '모두 지우기')),
          h('label', { class: 'form-row' }, h('span', {}, '파일 이름'), fileIn),
          h('label', { class: 'form-row' }, h('span', {}, '문자 스타일 옵션'), ts),
        );
        const m = modal<string[]>('치수 스타일 내보내기', body, [
          { label: '취소', value: () => null as unknown as string[] },
          {
            label: '확인',
            primary: true,
            value: () => {
              const sel = boxes.filter((b) => b.c.box.checked).map((b) => b.n);
              return sel.length ? sel : undefined;
            },
          },
        ]);
        const r = await m.done;
        if (!r || !r.length) return;
        names = r;
        full = ts.value === 'F';
        fileName = fileIn.value.trim().replace(/^.*[\\/]/, '') || fileName;
        if (!/\.dim$/i.test(fileName)) fileName += '.dim';
      }
      if (!names.length) return;
      const out = writeDimFile(doc, names, { fullTextStyle: full });
      saveText(fileName, out.text, false, 'application/dxf');
      ctx.print(`치수 스타일 ${out.styles.length}개(${out.styles.join(', ')})를 ${fileName}(으)로 내보냈습니다.`);
    },
  });

  registerOnce(app, {
    name: 'DIMIM',
    title: '치수 스타일 가져오기(.dim)',
    async run(ctx) {
      const st = app.active!;
      const f = await pickOneFile(app, ctx, '.dim,.DIM,.dxf,.DXF', '가져올 치수 스타일 파일 이름 입력:', ['.dim']);
      if (!f) return;
      const { text } = await readTextFile(f);
      const content = parseDimFile(text);
      for (const e of content.errors.slice(0, 5)) ctx.print(e, 'err');
      if (!content.styles.length) return;
      const dup = content.styles.filter((s) => st.doc.dimStyles.has(tableKey(s.name))).map((s) => s.name);
      let overwrite = true;
      if (dup.length) {
        if (commandLineMode(app)) overwrite = await askYN(ctx, `기존 치수 스타일(${dup.join(', ')})을 덮어쓰시겠습니까?`, true);
        else {
          const v = await form('치수 스타일 가져오기', [{ key: 'ow', label: '같은 이름의 치수 스타일 덮어쓰기', type: 'check', value: true }], {
            ok: '가져오기',
            note: `${f.name}: 치수 스타일 ${content.styles.length}개(${content.styles.map((s) => s.name).join(', ')}). 이 도면에 이미 있는 것: ${dup.join(', ')}`,
          });
          if (!v) return;
          overwrite = !!v.ow;
        }
      }
      const r = importDimStylesOps(st.doc, content, overwrite, () => st.session.newHandle());
      if (r.ops.length) st.session.commit({ label: 'DIMIM', ops: r.ops, group: ctx.group, rebuildNow: true });
      if (r.added.length) ctx.print(`치수 스타일을 추가했습니다: ${r.added.join(', ')}`);
      if (r.replaced.length) ctx.print(`치수 스타일을 덮어썼습니다: ${r.replaced.join(', ')}`);
      if (r.skipped.length) ctx.print(`이미 있어 건너뛴 치수 스타일: ${r.skipped.join(', ')}`);
      if (r.created.length) ctx.print(`함께 만든 정의: ${r.created.join(', ')}`);
      for (const n of r.notes) ctx.print(`참고: ${n}`);
    },
  });
}

export function registerBlkMiscCommands(app: App): void {
  registerRedefine(app);
  registerBase(app);
  registerTinsert(app);
  registerPasteSpec(app);
  registerDimFile(app);
}
