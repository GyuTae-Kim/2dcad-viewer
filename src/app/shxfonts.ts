/**
 * SHX 글꼴 불러오기(SHXFONTS): 이 컴퓨터의 SHX 글꼴 파일·폴더를 골라 도면 문자를 원래 글꼴로 그린다.
 * 파일은 서버로 보내지 않고, 이 브라우저에만 보관한다.
 */
import type { CadDocument } from '../core/model';
import { isShxFont } from '../text/layout';
import { ShxLibrary } from '../text/shx';
import type { App } from './app';
import type { DocState } from './docstate';
import { clearFonts, loadFonts, saveFonts } from './fontstore';
import { dialog, h, toast } from './ui/dom';

/** 도면의 문자 스타일이 쓰는 SHX 글꼴 이름(소문자, .shx 붙임) */
export function usedShxFonts(doc: CadDocument): string[] {
  const out = new Set<string>();
  const norm = (n: string) => `${ShxLibrary.key(n)}.shx`;
  for (const s of doc.textStyles.values()) {
    if (s.font && !s.fontFamily && isShxFont(s.font)) out.add(norm(s.font));
    if (s.bigFont) out.add(norm(s.bigFont));
  }
  return [...out].sort();
}

function library(app: App): ShxLibrary {
  if (!app.text.shx) app.text.shx = new ShxLibrary();
  return app.text.shx;
}

export function missingShxFonts(app: App, doc: CadDocument): string[] {
  const lib = app.text.shx;
  return usedShxFonts(doc).filter((n) => !lib?.has(n));
}

/** SHX 파일들을 등록하고 열린 도면을 다시 그린다. 해석한 글꼴 수 */
export async function addShxFonts(app: App, files: { name: string; data: Uint8Array }[], persist: boolean): Promise<number> {
  const lib = library(app);
  const ok: { name: string; data: Uint8Array }[] = [];
  for (const f of files) if (lib.add(f.name, f.data)) ok.push(f);
  if (!ok.length) return 0;
  app.engine.shx(ok);
  if (persist) await saveFonts(ok);
  for (const st of app.docs) app.edits.rebuildEverything(st);
  return ok.length;
}

/** 시작할 때 보관해 둔 SHX 글꼴을 다시 등록한다 */
export async function restoreShxFonts(app: App): Promise<void> {
  const files = await loadFonts();
  if (files.length) await addShxFonts(app, files, false);
}

/** 파일(또는 폴더) 고르기 */
function pickFiles(folder: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, accept: '.shx', style: 'display:none' }) as HTMLInputElement;
    if (folder) input.setAttribute('webkitdirectory', '');
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

async function readShx(files: File[]): Promise<{ name: string; data: Uint8Array }[]> {
  const out: { name: string; data: Uint8Array }[] = [];
  let total = 0;
  for (const f of files) {
    if (!/\.shx$/i.test(f.name) || f.size > 16 * 1024 * 1024) continue;
    total += f.size;
    if (total > 256 * 1024 * 1024) break;
    out.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
  }
  return out;
}

/** 문서를 열었을 때: 빠진 SHX 글꼴 안내 */
export function noteMissingShx(app: App, st: DocState): void {
  const miss = missingShxFonts(app, st.doc);
  if (!miss.length) return;
  const list = miss.slice(0, 4).join(', ') + (miss.length > 4 ? ` 외 ${miss.length - 4}개` : '');
  app.cmd.print(`참고: SHX 글꼴 ${list}이(가) 없어 비슷한 단선 글꼴로 그렸습니다. SHXFONTS로 이 컴퓨터의 SHX 글꼴을 불러올 수 있습니다.`);
}

export function registerShxCommands(app: App): void {
  app.register({
    name: 'SHXFONTS',
    aliases: ['SHX'],
    title: 'SHX 글꼴 불러오기',
    noDoc: true,
    run(ctx) {
      const lib = library(app);
      const st = app.active;
      const used = st ? usedShxFonts(st.doc) : [];
      const body = h(
        'div',
        { class: 'shx-dialog' },
        h('p', {}, 'AutoCAD가 설치된 컴퓨터의 SHX 글꼴(예: Fonts 폴더)을 고르면 도면 문자를 원래 글꼴로 그립니다. 파일은 서버로 보내지 않고 이 브라우저에만 보관합니다.'),
        used.length
          ? h(
              'div',
              {},
              h('b', {}, '이 도면이 쓰는 SHX 글꼴'),
              h('ul', {}, ...used.map((n) => h('li', {}, `${n} — ${lib.has(n) ? '불러옴' : '없음(대체 글꼴로 그림)'}`))),
            )
          : null,
        h('div', { style: 'margin-top:6px;color:var(--text-dim)' }, `불러온 글꼴 ${lib.size}개${lib.size ? `: ${lib.names().slice(0, 12).join(', ')}${lib.size > 12 ? ' …' : ''}` : ''}`),
      );
      const load = async (folder: boolean) => {
        const files = await readShx(await pickFiles(folder));
        if (!files.length) return;
        const n = await addShxFonts(app, files, true);
        ctx.print(n ? `SHX 글꼴 ${n}개를 불러왔습니다. 도면을 다시 그립니다.` : 'SHX 글꼴로 읽을 수 있는 파일이 없습니다.', n ? undefined : 'err');
        if (n) toast(`SHX 글꼴 ${n}개를 불러왔습니다.`, 'info', 3000);
      };
      dialog('SHX 글꼴', body, [
        {
          label: '모두 지우기',
          run: () => {
            lib.clear();
            app.engine.shx([], true);
            void clearFonts();
            for (const d of app.docs) app.edits.rebuildEverything(d);
            ctx.print('불러온 SHX 글꼴을 모두 지웠습니다.');
          },
        },
        { label: '파일 고르기…', run: () => void load(false) },
        { label: '폴더 고르기…', primary: true, run: () => void load(true) },
      ]);
    },
  });
}
