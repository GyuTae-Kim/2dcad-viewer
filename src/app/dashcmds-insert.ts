/**
 * 명령행 블록 명령: -INSERT(블록 삽입), -ATTEDIT(속성 편집 — 개별·전역).
 * 프롬프트 순서는 AutoCAD 2026 한국어판을 따른다(스크립트가 그대로 쓴다).
 * - -INSERT: `블록 이름 입력 또는 [?]` → `삽입점 지정 또는 [기준점(B)/축척(S)/X/Y/Z/회전(R)]` → X·Y 축척 → 회전 → 속성 값.
 *   이름 앞의 *는 분해해서 넣기. `블록이름=파일`은 이 웹 버전이 경로로 파일을 열 수 없어 안내한다.
 *   블록 단위와 도면 단위(INSUNITS)가 다르면 그 비율로 축척한다. Z 축척은 AutoCAD처럼 |X 축척|이다(XYZ로 따로 주면 그 값).
 * - -ATTEDIT: `속성을 한 번에 하나씩 편집하시겠습니까?` → 블록·태그·값 사양(와일드카드) → 속성 선택 → 편집 옵션 또는 문자열 바꾸기.
 */
import type { AttribEntity, BlockDef, CadColor, InsertEntity, Vec3 } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { explodeEntity } from '../edit/geom';
import { cloneEntity, isLayoutBlock } from '../edit/session';
import { matchNameList, parseLayerColor, parseTrueColor } from '../edit/layercmd';
import { UNIT_NAMES, insertUnitFactor } from '../edit/script/dash';
import type { App, CommandContext, Keyword } from './app';
import { makeAttribs } from './blocks';
import { addEntities, currentProps } from './draw';
import { commitResults } from './modify';
import { previewOf } from './modify2-util';
import { askAngleDeg, askLine, askOption, askReal, askWord, askYN, fmt4, matchKeyword } from './dashcmds-ask';
import type { Pt } from './view';

/** 문서별 직전 블록 이름 */
const lastBlock = new WeakMap<object, string>();

const nonZero = (v: number) => (v === 0 ? '값은 0이 아니어야 합니다.' : null);

/** 블록 종류별 목록(-INSERT ?, -BLOCK ?와 같은 꼴) */
export function listBlocks(ctx: CommandContext, pattern: string): void {
  const doc = ctx.app.active!.doc;
  const all = [...doc.blocks.entries()].filter(([k]) => !isLayoutBlock(k)).map(([, b]) => b);
  const user = all.filter((b) => !b.name.startsWith('*') && !(b.flags & 4) && !b.name.includes('|'));
  const xref = all.filter((b) => b.flags & 4);
  const dep = all.filter((b) => !(b.flags & 4) && b.name.includes('|'));
  const unnamed = all.filter((b) => b.name.startsWith('*'));
  const named = [...user, ...xref, ...dep].map((b) => b.name);
  const hit = new Set(matchNameList(named, pattern || '*').names.map((n) => n.toUpperCase()));
  ctx.print('정의된 블록.');
  for (const b of [...user, ...xref, ...dep].sort((a, c) => a.name.localeCompare(c.name))) {
    if (!hit.has(b.name.toUpperCase())) continue;
    ctx.print(b.flags & 4 ? `  "${b.name}"   외부 참조: ${b.xrefPath ?? ''}` : `  "${b.name}"`);
  }
  ctx.print('사용자 블록   외부 참조   종속 블록   명명되지 않은 블록');
  ctx.print(`${String(user.length).padStart(6)}${String(xref.length).padStart(12)}${String(dep.length).padStart(12)}${String(unnamed.length).padStart(14)}`);
}

/** 블록 기준점 base가 삽입점 p에 오도록 실제 삽입점(블록 정의 기준점 기준) */
function insertPointFor(def: BlockDef, base: Vec3, p: Pt, scale: Vec3, rot: number): Vec3 {
  const dx = (base.x - def.basePoint.x) * scale.x;
  const dy = (base.y - def.basePoint.y) * scale.y;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: p.x - (dx * c - dy * s), y: p.y - (dx * s + dy * c), z: 0 };
}

const INSERT_KW: Keyword[] = [
  { key: 'B', label: '기준점' },
  { key: 'S', label: '축척' },
  { key: 'X', label: 'X' },
  { key: 'Y', label: 'Y' },
  { key: 'Z', label: 'Z' },
  { key: 'R', label: '회전' },
];

export function registerDashInsertCommands(app: App): void {
  // ------------------------------------------------------------- -INSERT
  app.register({
    name: '-INSERT',
    aliases: ['-I'],
    title: '블록 삽입(명령행)',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const last = lastBlock.get(doc) ?? '';
      let name = '';
      for (;;) {
        const t = await askWord(ctx, `블록 이름 입력 또는 [?]${last ? ` <${last}>` : ''}:`);
        if (t === null) {
          if (!last) return;
          name = last;
          break;
        }
        if (t === '?') {
          listBlocks(ctx, (await askWord(ctx, '나열할 블록 입력 <*>:')) ?? '*');
          continue;
        }
        name = t;
        break;
      }
      const explode = name.startsWith('*');
      if (explode) name = name.slice(1);
      if (name.includes('=') || /[\\/]|\.dw[gt]$/i.test(name)) {
        ctx.print('이 웹 버전은 경로나 "블록이름=파일"로 도면 파일을 열 수 없습니다. 다른 도면의 블록은 디자인센터(ADCENTER)에서 가져오거나 그 도면을 열어 복사하십시오.', 'err');
        return;
      }
      const def = doc.blocks.get(tableKey(name));
      if (!def || isLayoutBlock(tableKey(name)) || def.name.startsWith('*')) {
        ctx.print(`블록 "${name}"을(를) 찾을 수 없습니다. 이 웹 버전은 같은 이름의 도면 파일(${name}.dwg)을 찾아 읽을 수 없습니다.`, 'err');
        return;
      }
      if (st.blockEdit && tableKey(st.blockEdit.name) === tableKey(def.name)) {
        ctx.print('블록을 자기 자신 안에 삽입할 수 없습니다.', 'err');
        return;
      }
      lastBlock.set(doc, def.name);
      const rec = doc.blockRecords.get(tableKey(def.name));
      const bu = rec?.insertUnits ?? 0;
      const f = insertUnitFactor(bu, Number(doc.header.get('$INSUNITS') ?? 0));
      ctx.print(`단위: ${UNIT_NAMES[bu] ?? '단위 없음'}   변환:   ${fmt4(f)}`);
      // 삽입점 전에 정할 수 있는 축척·회전·기준점
      const pre: { sx?: number; sy?: number; sz?: number; rot?: number } = {};
      let base: Vec3 = { ...def.basePoint };
      const ghostAt = (p: Pt): ReturnType<typeof previewOf> => {
        const sx = (pre.sx ?? 1) * f;
        const sy = (pre.sy ?? pre.sx ?? 1) * f;
        const scale = { x: sx, y: sy, z: Math.abs(sx) };
        const rot = pre.rot ?? 0;
        return previewOf(app, [{ ...entityDefaults(), type: 'INSERT', handle: '', block: def.name, insert: insertPointFor(def, base, p, scale, rot), scale, rotation: rot, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] } as InsertEntity]);
      };
      let at: Pt;
      for (;;) {
        const r = await ctx.getPoint('삽입점 지정 또는 [기준점(B)/축척(S)/X/Y/Z/회전(R)]:', { keywords: INSERT_KW, ghost: ghostAt });
        if ('point' in r) {
          at = r.point;
          break;
        }
        if (!('keyword' in r)) {
          ctx.print('점 또는 옵션 키워드가 필요합니다.', 'err');
          continue;
        }
        switch (r.keyword) {
          case 'B': {
            const b = await ctx.getPoint('기준점 지정:');
            if ('point' in b) base = { x: b.point.x, y: b.point.y, z: 0 };
            break;
          }
          case 'S': {
            const v = await askReal(ctx, `모든 축 축척 비율 지정 <${fmt4(1)}>:`, 1, nonZero);
            pre.sx = pre.sy = pre.sz = v;
            break;
          }
          case 'X':
            pre.sx = await askReal(ctx, `X 축척 비율 지정 <${fmt4(1)}>:`, 1, nonZero);
            break;
          case 'Y':
            pre.sy = await askReal(ctx, `Y 축척 비율 지정 <${fmt4(1)}>:`, 1, nonZero);
            break;
          case 'Z':
            pre.sz = await askReal(ctx, `Z 축척 비율 지정 <${fmt4(1)}>:`, 1, nonZero);
            break;
          case 'R':
            pre.rot = await askAngleDeg(ctx, '회전 각도 지정 <0>:', null, 0);
            break;
        }
      }
      // 축척
      let sx = pre.sx;
      let sy = pre.sy;
      let sz = pre.sz;
      const anyPreset = sx !== undefined || sy !== undefined || sz !== undefined;
      if (explode) {
        if (!anyPreset) sx = sy = await askReal(ctx, `축척 비율 지정 <${fmt4(1)}>:`, 1, nonZero);
      } else if (!anyPreset) {
        const corner = (p: Pt): boolean => {
          const x = p.x - at.x;
          const y = p.y - at.y;
          if (Math.abs(x) < 1e-12 || Math.abs(y) < 1e-12) {
            ctx.print('값은 0이 아니어야 합니다.', 'err');
            return false;
          }
          sx = x;
          sy = y;
          return true;
        };
        for (;;) {
          const r = await ctx.getPoint(`X 축척 비율 입력, 반대 구석 지정, 또는 [구석(C)/XYZ(XYZ)] <${fmt4(1)}>:`, {
            base: at,
            preferNumber: true,
            allowText: true,
            keywords: [
              { key: 'C', label: '구석' },
              { key: 'XYZ', label: 'XYZ' },
            ],
            rubber: (q) => [{ pts: [at.x, at.y, q.x, at.y, q.x, q.y, at.x, q.y], closed: true, dashed: true }],
          });
          if ('enter' in r) {
            sx = 1;
            break;
          }
          if ('point' in r) {
            if (corner(r.point)) break;
            continue;
          }
          if ('keyword' in r && r.keyword === 'C') {
            const q = await ctx.getPoint('반대 구석 지정:', { base: at, rubber: (q) => [{ pts: [at.x, at.y, q.x, at.y, q.x, q.y, at.x, q.y], closed: true, dashed: true }] });
            if ('point' in q && corner(q.point)) break;
            continue;
          }
          if ('keyword' in r && r.keyword === 'XYZ') {
            sx = await askReal(ctx, `X 축척 비율 지정 <${fmt4(1)}>:`, 1, nonZero);
            sy = await askReal(ctx, 'Y 축척 비율 지정 <X 축척 비율 사용>:', sx, nonZero);
            sz = await askReal(ctx, 'Z 축척 비율 지정 <X 축척 비율 사용>:', sx, nonZero);
            break;
          }
          if ('text' in r) {
            const v = Number(r.text.trim());
            if (Number.isFinite(v) && v !== 0) {
              sx = v;
              break;
            }
            ctx.print(Number.isFinite(v) ? '값은 0이 아니어야 합니다.' : '숫자 값, 점 또는 옵션 키워드가 필요합니다.', 'err');
          }
        }
        if (sy === undefined) sy = await askReal(ctx, 'Y 축척 비율 입력 <X 축척 비율 사용>:', sx!, nonZero);
      }
      const ux = sx ?? sy ?? 1;
      const scale: Vec3 = { x: ux * f, y: (sy ?? ux) * f, z: (sz ?? Math.abs(ux)) * f };
      const rot = pre.rot ?? (await askAngleDeg(ctx, '회전 각도 지정 <0>:', at, 0));
      // 속성 값(ATTREQ 0이면 기본값)
      const values = new Map<string, string>();
      const attdefs = def.entities.filter((e): e is AttribEntity => e.type === 'ATTDEF' && !((e as AttribEntity).attFlags & 2));
      const askThese = attdefs.filter((d) => !(d.attFlags & 8));
      if (!explode && askThese.length && Number(doc.header.get('$ATTREQ') ?? 1) !== 0) {
        ctx.print('속성 값 입력');
        const ask = (d: AttribEntity, cur: string) => askLine(ctx, `${d.prompt || d.tag}${cur ? ` <${cur}>` : ''}:`, cur);
        for (const d of askThese) values.set(d.tag, await ask(d, d.text));
        const verify = askThese.filter((d) => d.attFlags & 4);
        if (verify.length) {
          ctx.print('속성 값 확인');
          for (const d of verify) values.set(d.tag, await ask(d, values.get(d.tag) ?? ''));
        }
      }
      const insert = insertPointFor(def, base, at, scale, rot);
      const handle = explode ? '' : st.session.newHandle();
      const ins: InsertEntity = {
        ...entityDefaults(),
        ...currentProps(app),
        type: 'INSERT',
        handle,
        block: def.name,
        insert,
        scale,
        rotation: rot,
        columnCount: 1,
        rowCount: 1,
        columnSpacing: 0,
        rowSpacing: 0,
        attribs: [],
      };
      if (explode) {
        const r = explodeEntity(ins, doc);
        if (!r.add?.length) {
          ctx.print(r.message ?? '분해할 수 없는 블록입니다.', 'err');
          return;
        }
        const res = commitResults(app, ctx, [{ add: r.add, blocks: r.blocks }], 'INSERT', { quiet: true });
        app.lastCreated = res.added;
        return;
      }
      ins.attribs = makeAttribs(app, def, insert, scale, rot, values, handle);
      app.lastCreated = addEntities(app, ctx, [ins], 'INSERT');
    },
  });

  // ------------------------------------------------------------- -ATTEDIT
  app.register({
    name: '-ATTEDIT',
    aliases: ['-ATE'],
    title: '속성 편집(명령행)',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const one = await askYN(ctx, '속성을 한 번에 하나씩 편집하시겠습니까?', true);
      let visibleOnly = true;
      if (!one) {
        ctx.print('전역 속성 값 편집 수행 중.');
        visibleOnly = await askYN(ctx, '화면에 보이는 속성만 편집하시겠습니까?', true);
      }
      const bspec = (await askWord(ctx, '블록 이름 사양 입력 <*>:')) ?? '*';
      const tspec = (await askWord(ctx, '속성 태그 사양 입력 <*>:')) ?? '*';
      const vspec = (await askWord(ctx, '속성 값 사양 입력 <*>:')) ?? '*';
      const like = (s: string, spec: string) => matchNameList([s], spec).names.length > 0 || (spec === '\\' && s === '');
      // 후보 블록 참조
      let inserts: InsertEntity[];
      if (one || visibleOnly) {
        const hs = await ctx.getSelection('속성 선택:', { noPickfirst: true });
        app.clearSelection();
        inserts = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is InsertEntity => e?.type === 'INSERT');
      } else {
        inserts = [];
        for (const [k, b] of doc.blocks) if (isLayoutBlock(k)) for (const e of b.entities) if (e.type === 'INSERT') inserts.push(e);
      }
      const items: { handle: string; index: number }[] = [];
      for (const e of inserts) {
        if (!like(e.block, bspec)) continue;
        if (doc.layers.get(tableKey(e.layer))?.locked) continue;
        e.attribs.forEach((a, i) => {
          if (a.attFlags & 2) return;
          if (visibleOnly && a.attFlags & 1) return;
          if (like(a.tag, tspec) && like(a.text, vspec)) items.push({ handle: e.handle, index: i });
        });
      }
      ctx.print(`${items.length}개의 속성이 선택됨.`);
      if (!items.length) return;
      /** 속성 하나 고치기(명령 취소 한 단계) */
      const patch = (it: { handle: string; index: number }, f: (a: AttribEntity) => void): void => {
        const e = doc.entityIndex.get(it.handle);
        if (e?.type !== 'INSERT' || !e.attribs[it.index]) return;
        const c = cloneEntity(e);
        f(c.attribs[it.index]!);
        if (JSON.stringify(c) === JSON.stringify(e)) return;
        const block = st.session.ownerOf(it.handle);
        if (block) st.session.commit({ label: 'ATTEDIT', ops: [{ kind: 'modify', block, before: e, after: c }], group: ctx.group });
      };
      const setValue = (a: AttribEntity, v: string) => {
        a.text = v.replace(/\r?\n/g, ' ');
        if (a.mtext) a.mtext.text = v.replace(/\r?\n/g, '\\P');
      };
      const attrOf = (it: { handle: string; index: number }) => {
        const e = doc.entityIndex.get(it.handle);
        return e?.type === 'INSERT' ? e.attribs[it.index] : undefined;
      };
      if (!one) {
        const from = await askLine(ctx, '변경할 문자열 입력:', '');
        const to = await askLine(ctx, '새 문자열 입력:', '');
        const ops = [];
        // 같은 블록 참조의 여러 속성은 한 번에
        const byInsert = new Map<string, number[]>();
        for (const it of items) byInsert.set(it.handle, [...(byInsert.get(it.handle) ?? []), it.index]);
        let n = 0;
        for (const [h, idx] of byInsert) {
          const e = doc.entityIndex.get(h);
          if (e?.type !== 'INSERT') continue;
          const c = cloneEntity(e);
          for (const i of idx) {
            const a = c.attribs[i]!;
            const v = from ? a.text.split(from).join(to) : to;
            if (v !== a.text) {
              setValue(a, v);
              n++;
            }
          }
          const block = st.session.ownerOf(h);
          if (block && JSON.stringify(c) !== JSON.stringify(e)) ops.push({ kind: 'modify' as const, block, before: e, after: c });
        }
        if (ops.length) st.session.commit({ label: 'ATTEDIT', ops, group: ctx.group });
        ctx.print(`속성 ${n}개를 바꿨습니다.`);
        return;
      }
      const OPTS: Keyword[] = [
        { key: 'V', label: '값' },
        { key: 'P', label: '위치' },
        { key: 'H', label: '높이' },
        { key: 'A', label: '각도' },
        { key: 'S', label: '스타일' },
        { key: 'L', label: '도면층' },
        { key: 'C', label: '색상' },
        { key: 'N', label: '다음' },
      ];
      for (const it of items) {
        for (;;) {
          const a = attrOf(it);
          if (!a) break;
          ctx.print(`속성: ${a.tag} = "${a.text}"`);
          const k = await askOption(ctx, '속성 편집 옵션 입력 [값(V)/위치(P)/높이(H)/각도(A)/스타일(S)/도면층(L)/색상(C)/다음(N)] <다음>:', OPTS, 'N');
          if (k === 'N' || k === null) break;
          switch (k) {
            case 'V': {
              const how = await askOption(
                ctx,
                '값 수정 유형 입력 [변경(C)/대치(R)] <대치>:',
                [
                  { key: 'C', label: '변경' },
                  { key: 'R', label: '대치' },
                ],
                'R',
              );
              if (how === 'C') {
                const from = await askLine(ctx, '변경할 문자열 입력:', '');
                const to = await askLine(ctx, '새 문자열 입력:', '');
                if (from) patch(it, (x) => setValue(x, x.text.split(from).join(to)));
              } else {
                const v = await askLine(ctx, '새 속성 값 입력:', '');
                patch(it, (x) => setValue(x, v));
              }
              break;
            }
            case 'P': {
              const r = await ctx.getPoint('새 문자 위치 지정 <변경 없음>:', { base: a.insert });
              if (!('point' in r)) break;
              const p = r.point;
              patch(it, (x) => {
                const dx = p.x - x.insert.x;
                const dy = p.y - x.insert.y;
                x.insert = { ...x.insert, x: p.x, y: p.y };
                if (x.alignPoint) x.alignPoint = { ...x.alignPoint, x: x.alignPoint.x + dx, y: x.alignPoint.y + dy };
                if (x.mtext) x.mtext.insert = { ...x.mtext.insert, x: x.mtext.insert.x + dx, y: x.mtext.insert.y + dy };
              });
              break;
            }
            case 'H': {
              const v = await askReal(ctx, `새 높이 지정 <${fmt4(a.height)}>:`, a.height, (x) => (x > 0 ? null : '값은 0보다 커야 합니다.'));
              patch(it, (x) => {
                x.height = v;
                if (x.mtext) x.mtext.height = v;
              });
              break;
            }
            case 'A': {
              const v = await askAngleDeg(ctx, `새 회전 각도 지정 <${+((a.rotation * 180) / Math.PI).toFixed(4)}>:`, null, a.rotation);
              patch(it, (x) => {
                x.rotation = v;
                if (x.mtext) x.mtext.rotation = v;
              });
              break;
            }
            case 'S': {
              const v = await askWord(ctx, `새 문자 스타일 입력 <${a.style}>:`);
              if (v === null) break;
              const ts = doc.textStyles.get(tableKey(v));
              if (!ts) {
                ctx.print(`문자 스타일 "${v}"을(를) 찾을 수 없습니다.`, 'err');
                break;
              }
              patch(it, (x) => {
                x.style = ts.name;
                if (x.mtext) x.mtext.style = ts.name;
              });
              break;
            }
            case 'L': {
              const v = await askWord(ctx, `새 도면층 이름 입력 <${a.layer}>:`);
              if (v === null) break;
              const l = doc.layers.get(tableKey(v));
              if (!l) {
                ctx.print(`도면층 "${v}"을(를) 찾을 수 없습니다.`, 'err');
                break;
              }
              patch(it, (x) => {
                x.layer = l.name;
              });
              break;
            }
            case 'C': {
              const c = await askColor(ctx, `새 색상 입력 [트루 컬러(T)/색상표(CO)] <${colorName(a.color)}>:`);
              if (c) patch(it, (x) => (x.color = c));
              break;
            }
          }
        }
      }
    },
  });
}

/** 색 이름(ByLayer·ByBlock·번호·r,g,b) */
export function colorName(c: CadColor): string {
  if (c.rgb !== undefined) return `${(c.rgb >> 16) & 255},${(c.rgb >> 8) & 255},${c.rgb & 255}`;
  if (c.aci === 256) return 'BYLAYER';
  if (c.aci === 0) return 'BYBLOCK';
  return String(c.aci);
}

/** 색 입력: 번호·이름·BYLAYER·BYBLOCK, T면 r,g,b. Enter면 null. first가 있으면 첫 답으로 쓴다 */
export async function askColor(ctx: CommandContext, prompt: string, first?: string): Promise<CadColor | null> {
  const kws: Keyword[] = [
    { key: 'T', label: '트루 컬러' },
    { key: 'CO', label: '색상표' },
  ];
  for (;;) {
    let t: string | null;
    if (first !== undefined) {
      t = first;
      first = undefined;
    } else t = await askWord(ctx, prompt, kws);
    if (t === null) return null;
    const k = matchKeyword(t, kws);
    if (k === 'T') {
      const v = await askWord(ctx, '빨강, 초록, 파랑:');
      const c = v ? parseTrueColor(v) : null;
      if (c) return c;
      ctx.print('0~255 사이 값 세 개를 쉼표로 입력하십시오. 예: 255,128,0', 'err');
      continue;
    }
    if (k === 'CO') {
      ctx.print('색상표(색상 책)는 이 웹 버전에서 쓸 수 없습니다. 색 번호나 트루 컬러(T)를 쓰십시오.', 'err');
      continue;
    }
    const up = t.toUpperCase();
    if (up === 'BYLAYER') return { aci: 256 };
    if (up === 'BYBLOCK') return { aci: 0 };
    const rgb = parseTrueColor(t);
    if (rgb) return rgb;
    const c = parseLayerColor(t);
    if (c && !c.off) return c.color;
    ctx.print('색 번호(1~255), 색 이름, BYLAYER, BYBLOCK 또는 트루 컬러(T)를 입력하십시오.', 'err');
  }
}
