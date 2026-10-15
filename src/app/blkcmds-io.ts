/**
 * 블록·참조 명령(blkcmds)이 함께 쓰는 파일 도우미: 파일 고르기(스크립트·FILEDIA 0이면 이 세션에 연 파일을 이름으로 찾기),
 * 글 파일 읽기(UTF-8·UTF-16·CP949 자동), 내려받기, 명령 등록(이미 있는 이름·별칭은 건너뛴다).
 */
import type { App, Command, CommandContext } from './app';
import { pickFiles } from './drawingfiles';
import { download } from './export';
import { fileNameMode } from './script';
import { sessionFile } from './sessionfiles';
import { askText } from './util2-ui';
import { decodeScript } from '../edit/script/reader';

/** 이미 등록된 이름은 건너뛰고, 다른 명령이 쓰는 별칭은 뺀다 */
export function registerOnce(app: App, c: Command): void {
  if (app.commands.has(c.name.toUpperCase())) return;
  // findCommand는 앞의 -를 떼고도 찾으므로(-XB → XB) 그 이름·별칭이 정확히 같을 때만 쓰인 것으로 본다
  const taken = (a: string) => {
    const hit = app.findCommand(a);
    const A = a.toUpperCase();
    return !!hit && (hit.name.toUpperCase() === A || (hit.aliases ?? []).some((x) => x.toUpperCase() === A));
  };
  const aliases = (c.aliases ?? []).filter((a) => !taken(a));
  app.register({ ...c, aliases });
}

/**
 * 파일 하나 고르기. 스크립트 안이나 FILEDIA 0이면 prompt로 이름을 묻고 이 세션에 고른 같은 이름의 파일을 찾는다
 * (브라우저는 경로로 파일을 열 수 없다). 취소·없음이면 null
 */
export async function pickOneFile(app: App, ctx: CommandContext, accept: string, prompt: string, exts: string[] = []): Promise<File | null> {
  if (fileNameMode(app)) {
    const t = (await askText(ctx, prompt, '')).trim().replace(/^"(.*)"$/, '$1');
    if (!t) return null;
    const cands = [t, ...exts.map((e) => `${t}${e}`)];
    for (const n of cands) {
      const b = sessionFile(n);
      if (b) return b instanceof File ? b : new File([b], n.replace(/^.*[\\/]/, ''));
    }
    ctx.print(`파일 "${t}"을(를) 찾을 수 없습니다. 이 웹 버전은 경로로 파일을 열 수 없어 이번 세션에서 고른 파일만 이름으로 찾습니다.`, 'err');
    return null;
  }
  const files = await pickFiles(accept, false);
  return files[0] ?? null;
}

/** 출력 파일 이름: 스크립트 안이나 FILEDIA 0이면 묻고, 아니면 기본값. 확장자가 없으면 붙인다 */
export async function outputName(app: App, ctx: CommandContext, prompt: string, def: string, ext: string): Promise<string> {
  let n = def;
  if (fileNameMode(app)) {
    const t = (await askText(ctx, `${prompt} <${def}>:`, def)).trim().replace(/^"(.*)"$/, '$1');
    if (t) n = t.replace(/^.*[\\/]/, '');
  }
  if (!new RegExp(`\\${ext}$`, 'i').test(n)) n += ext;
  return n;
}

/** 글 파일 읽기(인코딩 자동 판별) */
export async function readTextFile(f: Blob): Promise<{ text: string; encoding: string }> {
  return decodeScript(new Uint8Array(await f.arrayBuffer()));
}

/** 글을 파일로 내려받는다(bom이면 UTF-8 BOM을 앞에 붙인다 — 스프레드시트가 한글을 바로 읽는다) */
export function saveText(name: string, text: string, bom = false, type = 'text/plain;charset=utf-8'): void {
  download(new Blob([bom ? `﻿${text}` : text], { type }), name);
}
