/**
 * REDIR(Express Tools 경로 바꾸기) 계산(UI 없음).
 * 외부 참조(블록의 경로), 이미지·PDF·DWF·DGN 참고(정의 객체의 파일 이름), 문자 스타일 글꼴 파일의 경로에서
 * 옛 폴더를 새 폴더로 바꾼다. 옛 폴더가 *이면 폴더 부분 전체를 새 폴더로(파일 이름만 남긴다).
 * 폴더는 대소문자를 무시해 찾고 / 와 \ 를 같게 본다. 문자 스타일 글꼴은 폴더가 적힌 것만 바꾼다
 * (폴더 없는 "txt"·"romans.shx" 같은 이름에 폴더를 붙이면 AutoCAD 글꼴 찾기 규칙이 바뀐다).
 */
import type { CadDocument, ImageDefObject, TextStyle, UnderlayDefObject } from '../../core/model';
import type { EditOp } from '../session';

export interface RedirMode {
  styles: boolean;
  xrefs: boolean;
  images: boolean;
  rtext: boolean;
}

export const REDIR_DEFAULT: RedirMode = { styles: true, xrefs: true, images: true, rtext: true };

export function redirModeText(m: RedirMode): string {
  const p: string[] = [];
  if (m.styles) p.push('스타일');
  if (m.xrefs) p.push('외부 참조');
  if (m.images) p.push('이미지');
  if (m.rtext) p.push('RTEXT');
  return p.join(' ') || '(없음)';
}

const sep = (s: string) => (s.includes('\\') && !s.includes('/') ? '\\' : '/');

/** 경로의 폴더 부분과 파일 이름 */
export function splitPath(p: string): { dir: string; file: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? { dir: '', file: p } : { dir: p.slice(0, i + 1), file: p.slice(i + 1) };
}

const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();

/** 경로 하나 바꾸기(바뀌지 않으면 null) */
export function redirPath(path: string, oldDir: string, newDir: string, requireDir = false): string | null {
  if (!path) return null;
  const { dir, file } = splitPath(path);
  if (requireDir && !dir) return null;
  const o = oldDir.trim();
  let nd = newDir.trim();
  if (o === '*') {
    if (nd && !/[\\/]$/.test(nd)) nd += sep(nd);
    const next = nd + file;
    return next === path ? null : next;
  }
  if (!o) return null;
  const i = norm(dir).indexOf(norm(o));
  if (i < 0) return null;
  const next = dir.slice(0, i) + nd + dir.slice(i + o.length) + file;
  return next === path ? null : next;
}

export interface RedirChange {
  kind: 'xref' | 'image' | 'style';
  name: string;
  before: string;
  after: string;
}

/** 바꿀 작업과 바뀐 목록 */
export function redirOps(doc: CadDocument, oldDir: string, newDir: string, mode: RedirMode): { ops: EditOp[]; changes: RedirChange[] } {
  const ops: EditOp[] = [];
  const changes: RedirChange[] = [];
  if (mode.xrefs)
    for (const [key, b] of doc.blocks) {
      if (!(b.flags & 4) || !b.xrefPath) continue;
      const p = redirPath(b.xrefPath, oldDir, newDir);
      if (p === null) continue;
      ops.push({ kind: 'blockDef', key, before: b, after: { ...b, xrefPath: p } });
      changes.push({ kind: 'xref', name: b.name, before: b.xrefPath, after: p });
    }
  if (mode.images)
    for (const [key, o] of doc.objects) {
      if (o.type !== 'IMAGEDEF' && o.type !== 'PDFDEFINITION' && o.type !== 'DWFDEFINITION' && o.type !== 'DGNDEFINITION') continue;
      const d = o as ImageDefObject | UnderlayDefObject;
      const p = redirPath(d.fileName, oldDir, newDir);
      if (p === null) continue;
      ops.push({ kind: 'object', key, before: o, after: { ...d, fileName: p } });
      changes.push({ kind: 'image', name: 'name' in d && d.name ? d.name : splitPath(d.fileName).file, before: d.fileName, after: p });
    }
  if (mode.styles)
    for (const [key, s] of doc.textStyles) {
      const font = redirPath(s.font, oldDir, newDir, true);
      const big = redirPath(s.bigFont, oldDir, newDir, true);
      if (font === null && big === null) continue;
      const after: TextStyle = { ...s, font: font ?? s.font, bigFont: big ?? s.bigFont };
      ops.push({ kind: 'textStyle', key, before: s, after });
      if (font !== null) changes.push({ kind: 'style', name: s.name, before: s.font, after: font });
      if (big !== null) changes.push({ kind: 'style', name: s.name, before: s.bigFont, after: big });
    }
  return { ops, changes };
}

/** 경로 목록(? 옵션): 종류별 지금 경로 */
export function redirList(doc: CadDocument, mode: RedirMode): RedirChange[] {
  const out: RedirChange[] = [];
  if (mode.xrefs) for (const b of doc.blocks.values()) if (b.flags & 4 && b.xrefPath) out.push({ kind: 'xref', name: b.name, before: b.xrefPath, after: b.xrefPath });
  if (mode.images)
    for (const o of doc.objects.values()) {
      if (o.type !== 'IMAGEDEF' && o.type !== 'PDFDEFINITION' && o.type !== 'DWFDEFINITION' && o.type !== 'DGNDEFINITION') continue;
      const d = o as ImageDefObject | UnderlayDefObject;
      if (d.fileName) out.push({ kind: 'image', name: splitPath(d.fileName).file, before: d.fileName, after: d.fileName });
    }
  if (mode.styles)
    for (const s of doc.textStyles.values()) {
      if (splitPath(s.font).dir) out.push({ kind: 'style', name: s.name, before: s.font, after: s.font });
      if (splitPath(s.bigFont).dir) out.push({ kind: 'style', name: s.name, before: s.bigFont, after: s.bigFont });
    }
  return out;
}
