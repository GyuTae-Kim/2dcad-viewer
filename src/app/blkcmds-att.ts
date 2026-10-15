/**
 * 블록 속성 파일 명령: ATTOUT·ATTIN(Express Tools, 탭 구분 글), ATTEXT·-ATTEXT(CDF·SDF·DXF 속성 추출), ATTREDEF.
 * 파일 꼴과 계산은 src/edit/blkcmds(attout·attext·attredef)의 순수 함수가 한다.
 * 브라우저에서는 출력 파일을 내려받기로 쓰고, 입력 파일은 고르기 상자(스크립트·FILEDIA 0이면 이 세션에 고른 파일 이름)로 읽는다.
 */
import type { Entity, InsertEntity } from '../core/model';
import { tableKey } from '../core/model';
import { attInOps, attOutText, parseAttIn } from '../edit/blkcmds/attout';
import { type ExtractBlock, type Template, collectBlocks, formatDxx, formatRecords, parseTemplate, templateTags } from '../edit/blkcmds/attext';
import { attRedefOps } from '../edit/blkcmds/attredef';
import { blockDisplayName } from '../edit/extract';
import type { App, CommandContext } from './app';
import { askOption } from './dashcmds-ask';
import { baseName } from './export';
import { unlockedOnly } from './layers';
import { commandLineMode } from './script';
import { form } from './ui/dom';
import { askText } from './util2-ui';
import { outputName, pickOneFile, readTextFile, registerOnce, saveText } from './blkcmds-io';

const TXT_ACCEPT = '.txt,.TXT,.tsv,.TSV,.csv,.CSV';

/** 지금 도면의 모든 공간(모형·배치)의 객체 */
function allSpaceEntities(app: App): Entity[] {
  const doc = app.active!.doc;
  const out: Entity[] = [];
  for (const [k, b] of doc.blocks) if (/^\*(MODEL|PAPER)_SPACE/i.test(k)) out.push(...b.entities);
  return out;
}

/** 도면에 나오는 속성 태그(처음 나온 순서) */
function drawingTags(app: App): string[] {
  const tags: string[] = [];
  for (const e of allSpaceEntities(app))
    if (e.type === 'INSERT')
      for (const a of e.attribs) {
        const t = a.tag?.toUpperCase();
        if (t && !tags.includes(t)) tags.push(t);
      }
  return tags;
}

/** 이 도면의 태그로 만든 보기 템플릿 */
function sampleTemplate(app: App): string {
  const lines = ['BL:NAME C032000', 'BL:X N012004', 'BL:Y N012004', 'BL:LAYER C032000'];
  for (const t of drawingTags(app).slice(0, 12)) lines.push(`${t} C040000`);
  return lines.join('\n');
}

function printTemplateErrors(ctx: CommandContext, t: Template): boolean {
  for (const e of t.errors.slice(0, 6)) ctx.print(`** ${e}`, 'err');
  if (t.errors.length > 6) ctx.print(`… 오류 ${t.errors.length - 6}개 더`, 'err');
  return !t.errors.length;
}

/** 추출해서 내려받는다 */
function writeExtract(app: App, ctx: CommandContext, format: 'CDF' | 'SDF' | 'DXF', top: Entity[], template: Template | null, fileName: string): void {
  const doc = app.active!.doc;
  const tags = template ? templateTags(template) : null;
  const blocks = collectBlocks(doc, top, tags);
  const name = (b: ExtractBlock) => blockDisplayName(doc, b.entity);
  const out = format === 'DXF' ? formatDxx(blocks) : formatRecords(blocks, template!, format, name);
  for (const w of out.warnings.slice(0, 6)) ctx.print(`** ${w}`, 'err');
  if (out.warnings.length > 6) ctx.print(`… 알림 ${out.warnings.length - 6}개 더`);
  if (!out.records) {
    ctx.print(tags && tags.size ? '템플릿의 속성 태그를 가진 블록이 없습니다. 추출 파일을 만들지 않았습니다.' : '추출할 속성이 있는 블록이 없습니다.', 'err');
    return;
  }
  saveText(fileName, out.text, false, format === 'DXF' ? 'application/dxf' : 'text/plain;charset=utf-8');
  ctx.print(`추출 파일 ${fileName}에 ${out.records}개 레코드가 있습니다.`);
}

/** 템플릿 파일 고르기·읽기 */
async function pickTemplate(app: App, ctx: CommandContext): Promise<Template | null> {
  const f = await pickOneFile(app, ctx, TXT_ACCEPT, '템플릿 파일 이름 입력:', ['.txt']);
  if (!f) return null;
  const { text } = await readTextFile(f);
  const t = parseTemplate(text);
  if (!printTemplateErrors(ctx, t)) return null;
  ctx.print(`템플릿 ${f.name}: 필드 ${t.fields.length}개`);
  return t;
}

export function registerBlkAttCommands(app: App): void {
  // ------------------------------------------------------------- ATTOUT
  registerOnce(app, {
    name: 'ATTOUT',
    title: '속성 내보내기(탭 구분 파일)',
    async run(ctx) {
      const st = app.active!;
      const fileName = await outputName(app, ctx, '출력 파일 이름 입력', `${baseName(st.saveName)}.txt`, '.txt');
      const hs = await ctx.getSelection('객체 선택:');
      if (!hs.length) return;
      const ins = hs.map((h) => st.doc.entityIndex.get(h)).filter((e): e is InsertEntity => e?.type === 'INSERT');
      const r = attOutText(ins);
      if (!r.rows) {
        ctx.print('고른 객체 중에 속성이 있는 블록이 없습니다.', 'err');
        return;
      }
      saveText(fileName, r.text, true);
      ctx.print(`블록 ${r.rows}개의 속성(태그 ${r.columns.length}개)을 ${fileName}(으)로 내보냈습니다. 값을 고친 뒤 ATTIN으로 다시 읽으십시오.`);
    },
  });

  // ------------------------------------------------------------- ATTIN
  registerOnce(app, {
    name: 'ATTIN',
    title: '속성 가져오기(탭 구분 파일)',
    async run(ctx) {
      const st = app.active!;
      const f = await pickOneFile(app, ctx, TXT_ACCEPT, '입력 파일 이름 입력:', ['.txt']);
      if (!f) return;
      const { text, encoding } = await readTextFile(f);
      if (encoding === 'cp949') ctx.print(`참고: ${f.name}은(는) CP949(한국어 Windows) 인코딩으로 읽었습니다.`);
      const p = parseAttIn(text);
      for (const e of p.errors.slice(0, 5)) ctx.print(e, 'err');
      if (!p.rows.length) {
        if (!p.errors.length) ctx.print('파일에 블록 행이 없습니다.', 'err');
        return;
      }
      const r = attInOps(st.doc, p.rows, (h) => st.session.ownerOf(h));
      if (r.ops.length) st.session.commit({ label: 'ATTIN', ops: r.ops, group: ctx.group });
      ctx.print(`블록 ${r.updated}개의 속성 값을 바꿨습니다${r.unchanged ? `(그대로인 블록 ${r.unchanged}개)` : ''}.`);
      if (r.missing.length) ctx.print(`핸들 ${r.missing.slice(0, 8).join(', ')}${r.missing.length > 8 ? ' …' : ''}에 해당하는 블록 참조가 이 도면에 없습니다(${r.missing.length}개).`, 'err');
      if (r.locked) ctx.print(`잠긴 도면층의 블록 ${r.locked}개는 건너뛰었습니다.`);
      if (r.unknownTags.size) ctx.print(`참고: 블록에 없는 태그 열 ${[...r.unknownTags].slice(0, 8).join(', ')}은(는) 무시했습니다.`);
    },
  });

  // ------------------------------------------------------------- -ATTEXT
  const dashAttext = async (ctx: CommandContext) => {
    const st = app.active!;
    let top: Entity[] | null = null;
    let format: 'CDF' | 'SDF' | 'DXF' | null = null;
    while (!format) {
      const k = await askOption(
        ctx,
        '추출 유형 입력 또는 객체 선택 사용 [CDF(C)/SDF(S)/DXF(D)/객체(O)] <C>:',
        [
          { key: 'C', label: 'CDF' },
          { key: 'S', label: 'SDF' },
          { key: 'D', label: 'DXF' },
          { key: 'O', label: '객체' },
        ],
        'C',
      );
      if (k === 'O') {
        const hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
        top = hs.map((h) => st.doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
        ctx.print(`객체 ${top.length}개를 골랐습니다.`);
        continue;
      }
      format = k === 'S' ? 'SDF' : k === 'D' ? 'DXF' : 'CDF';
    }
    let template: Template | null = null;
    if (format !== 'DXF') {
      template = await pickTemplate(app, ctx);
      if (!template) return;
    }
    const fileName = await outputName(app, ctx, '추출 파일 이름 입력', `${baseName(st.saveName)}.${format === 'DXF' ? 'dxx' : 'txt'}`, format === 'DXF' ? '.dxx' : '.txt');
    writeExtract(app, ctx, format, top ?? allSpaceEntities(app), template, fileName);
  };
  registerOnce(app, { name: '-ATTEXT', title: '속성 추출(명령행)', run: (ctx) => dashAttext(ctx) });

  // ------------------------------------------------------------- ATTEXT
  registerOnce(app, {
    name: 'ATTEXT',
    aliases: ['DDATTEXT'],
    title: '속성 추출',
    async run(ctx) {
      if (commandLineMode(app)) return dashAttext(ctx);
      const st = app.active!;
      const v = await form(
        '속성 추출',
        [
          {
            key: 'format',
            label: '파일 형식',
            type: 'select',
            value: 'CDF',
            options: [
              { value: 'CDF', label: '쉼표 구분 파일(CDF)' },
              { value: 'SDF', label: '공백 구분 파일(SDF)' },
              { value: 'DXF', label: 'DXF 형식 추출 파일(DXX)' },
            ],
          },
          {
            key: 'scope',
            label: '객체',
            type: 'select',
            value: st.selection.size ? 'select' : 'all',
            options: [
              { value: 'all', label: '도면의 모든 블록' },
              { value: 'select', label: '객체 선택' },
            ],
          },
          {
            key: 'tsrc',
            label: '템플릿',
            type: 'select',
            value: 'text',
            options: [
              { value: 'text', label: '아래 템플릿 글 사용' },
              { value: 'file', label: '템플릿 파일 고르기' },
            ],
          },
          { key: 'template', label: '템플릿 글(CDF·SDF)', type: 'textarea', value: sampleTemplate(app) },
          { key: 'file', label: '출력 파일 이름', type: 'text', value: `${baseName(st.saveName)}.txt` },
        ],
        {
          ok: '확인',
          note: '템플릿 한 줄 = "필드 이름  형식". 형식은 C(문자)·N(숫자) + 폭 세 자리 + 소수 세 자리(예: BL:X N012004). 블록 필드는 BL:NAME·BL:X·BL:Y·BL:Z·BL:LAYER·BL:HANDLE·BL:ORIENT·BL:NUMBER·BL:LEVEL·BL:XSCALE 등, 나머지는 속성 태그입니다. DXF 형식은 템플릿을 쓰지 않습니다.',
          validate: (x) => {
            if (x.format !== 'DXF' && x.tsrc === 'text') {
              const t = parseTemplate(String(x.template));
              if (t.errors.length) return t.errors[0]!;
            }
            return String(x.file).trim() ? null : '출력 파일 이름을 입력하십시오.';
          },
        },
      );
      if (!v) return;
      const format = String(v.format) as 'CDF' | 'SDF' | 'DXF';
      let template: Template | null = null;
      if (format !== 'DXF') {
        if (v.tsrc === 'file') {
          template = await pickTemplate(app, ctx);
          if (!template) return;
        } else template = parseTemplate(String(v.template));
      }
      let top = allSpaceEntities(app);
      if (v.scope === 'select') {
        const hs = await ctx.getSelection('객체 선택:');
        if (!hs.length) return;
        top = hs.map((h) => st.doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
      }
      let fileName = String(v.file).trim().replace(/^.*[\\/]/, '');
      const ext = format === 'DXF' ? '.dxx' : '.txt';
      if (format === 'DXF') fileName = fileName.replace(/\.txt$/i, '');
      if (!/\.[A-Za-z0-9]{1,4}$/.test(fileName)) fileName += ext;
      writeExtract(app, ctx, format, top, template, fileName);
    },
  });

  // ------------------------------------------------------------- ATTREDEF
  registerOnce(app, {
    name: 'ATTREDEF',
    title: '속성을 유지하며 블록 재정의',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      let name = '';
      while (!name) {
        const t = (await askText(ctx, '재정의할 블록의 이름 입력:', '')).trim().replace(/^"(.*)"$/, '$1');
        if (!t) return;
        const b = doc.blocks.get(tableKey(t));
        if (!b || b.name.startsWith('*') || b.flags & 4) {
          ctx.print(`블록 "${t}"을(를) 찾을 수 없습니다.`, 'err');
          continue;
        }
        name = b.name;
      }
      ctx.print('새 블록에 대한 객체 선택...');
      const hs = unlockedOnly(app, await ctx.getSelection('객체 선택:', { noPickfirst: true }));
      if (!hs.length) {
        ctx.print('선택된 객체가 없습니다.', 'err');
        return;
      }
      const p = await ctx.getPoint('새 블록의 삽입 기준점 지정:');
      if (!('point' in p)) return;
      try {
        const r = attRedefOps(doc, name, st.space, hs, { x: p.point.x, y: p.point.y, z: 0 }, () => st.session.newHandle());
        st.selection.clear();
        st.session.commit({ label: 'ATTREDEF', ops: r.ops, group: ctx.group });
        ctx.print(`블록 "${name}"을(를) 다시 정의했습니다(객체 ${r.entities}개). 참조 ${r.references}개의 속성을 새 정의에 맞췄습니다.`);
        if (r.locked) ctx.print(`잠긴 도면층의 참조 ${r.locked}개는 속성을 맞추지 않았습니다.`);
      } catch (e) {
        ctx.print(e instanceof Error ? e.message : String(e), 'err');
      }
    },
  });
}
