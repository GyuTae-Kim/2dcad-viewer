/**
 * ATTOUT·ATTIN(Express Tools, UI 없음): 블록 속성 값을 탭으로 나눈 글 파일로 내보내고, 고친 파일을 읽어 값을 되돌려 넣는다.
 *
 * 파일 꼴(AutoCAD 도움말이 설명하는 꼴):
 * - 첫 줄은 머리 `HANDLE  BLOCKNAME  태그1  태그2 …`(탭 구분). 태그는 고른 블록들에 나온 순서대로 모은다.
 * - 한 블록 참조 = 한 줄. 첫 칸은 핸들 앞에 작은따옴표(')를 붙인 값(스프레드시트가 숫자로 바꾸지 않게), 둘째 칸은 블록 이름.
 * - 그 블록에 없는 태그의 칸은 `<>`. 한 블록에 같은 태그가 여러 번 있으면 두 번째부터 `태그(1)`, `태그(2)` … 열이 된다.
 * ATTIN은 핸들로 블록을 찾고, 머리의 태그 열 값으로 속성을 바꾼다(`<>`인 칸은 건너뛴다).
 */
import type { AttribEntity, CadDocument, InsertEntity } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { cloneEntity } from '../session';

/** 칸에 넣을 수 없는 탭·줄바꿈은 빈칸으로 */
const cell = (s: string) => s.replace(/[\t\r\n]+/g, ' ');

/** 속성의 보이는 값(여러 줄 속성은 \P를 빈칸으로) */
export function attribText(a: AttribEntity): string {
  if (a.mtext) return a.mtext.text.replace(/\\P/g, ' ');
  return a.text;
}

/** 블록 참조의 열 이름(같은 태그가 다시 나오면 태그(1)·태그(2)…)과 그 속성 */
export function attribColumns(ins: InsertEntity): { column: string; attrib: AttribEntity }[] {
  const seen = new Map<string, number>();
  const out: { column: string; attrib: AttribEntity }[] = [];
  for (const a of ins.attribs) {
    const t = (a.tag ?? '').toUpperCase();
    if (!t) continue;
    const n = seen.get(t) ?? 0;
    seen.set(t, n + 1);
    out.push({ column: n ? `${t}(${n})` : t, attrib: a });
  }
  return out;
}

/** ATTOUT 글(줄 끝 CRLF). 속성이 없는 블록 참조는 뺀다 */
export function attOutText(inserts: readonly InsertEntity[]): { text: string; rows: number; columns: string[] } {
  const list = inserts.filter((e) => e.attribs.some((a) => a.tag));
  const columns: string[] = [];
  const colSet = new Set<string>();
  const per = list.map((e) => {
    const cols = attribColumns(e);
    for (const c of cols)
      if (!colSet.has(c.column)) {
        colSet.add(c.column);
        columns.push(c.column);
      }
    return new Map(cols.map((c) => [c.column, attribText(c.attrib)]));
  });
  const lines = [['HANDLE', 'BLOCKNAME', ...columns].join('\t')];
  list.forEach((e, i) => {
    const m = per[i]!;
    lines.push([`'${e.handle}`, cell(e.block), ...columns.map((c) => (m.has(c) ? cell(m.get(c)!) : '<>'))].join('\t'));
  });
  return { text: `${lines.join('\r\n')}\r\n`, rows: list.length, columns };
}

export interface AttInRow {
  /** 줄 번호(1부터, 머리 포함) */
  line: number;
  handle: string;
  block: string;
  /** 열 이름(대문자) → 값. `<>`인 칸은 넣지 않는다 */
  values: Map<string, string>;
}

export interface AttInParse {
  columns: string[];
  rows: AttInRow[];
  /** 읽을 수 없는 줄 */
  errors: string[];
}

/** ATTIN 파일 읽기(탭 구분, 첫 줄 머리). 따옴표로 감싼 칸(스프레드시트가 CSV처럼 저장한 경우)도 푼다 */
export function parseAttIn(text: string): AttInParse {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const errors: string[] = [];
  const rows: AttInRow[] = [];
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const head = (lines[i] ?? '').split('\t').map(unquote);
  if (head.length < 2 || head[0]!.trim().toUpperCase() !== 'HANDLE' || head[1]!.trim().toUpperCase() !== 'BLOCKNAME') {
    errors.push('첫 줄이 HANDLE, BLOCKNAME으로 시작하지 않습니다(ATTOUT으로 만든 파일이 아닙니다).');
    return { columns: [], rows, errors };
  }
  const columns = head.slice(2).map((c) => c.trim().toUpperCase());
  for (let n = i + 1; n < lines.length; n++) {
    const raw = lines[n]!;
    if (!raw.trim()) continue;
    const parts = raw.split('\t').map(unquote);
    const h = parts[0]!.trim().replace(/^'/, '');
    if (!/^[0-9A-Fa-f]+$/.test(h)) {
      errors.push(`${n + 1}번째 줄: 핸들 "${parts[0]}"을(를) 읽을 수 없습니다.`);
      continue;
    }
    const values = new Map<string, string>();
    columns.forEach((c, k) => {
      const v = parts[k + 2];
      if (v === undefined || v === '<>' || !c) return;
      values.set(c, v);
    });
    rows.push({ line: n + 1, handle: normalizeHandle(h), block: (parts[1] ?? '').trim(), values });
  }
  return { columns, rows, errors };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"');
  return s;
}

export interface AttInResult {
  ops: EditOp[];
  /** 값이 바뀐 블록 참조 */
  updated: number;
  /** 값이 그대로인 블록 참조 */
  unchanged: number;
  /** 핸들이 도면에 없거나 블록 참조가 아닌 줄 */
  missing: string[];
  /** 잠긴 도면층에 있어 건너뛴 블록 참조 */
  locked: number;
  /** 그 블록에 없는 열(태그) 이름 */
  unknownTags: Set<string>;
}

/** ATTIN: 읽은 행으로 속성 값을 바꾸는 작업. 같은 블록 참조가 여러 줄에 있으면 뒤 줄이 이긴다 */
export function attInOps(doc: CadDocument, rows: readonly AttInRow[], ownerOf: (handle: string) => string | null): AttInResult {
  const res: AttInResult = { ops: [], updated: 0, unchanged: 0, missing: [], locked: 0, unknownTags: new Set() };
  const byHandle = new Map<string, AttInRow>();
  for (const r of rows) byHandle.set(r.handle, r);
  for (const r of byHandle.values()) {
    const e = doc.entityIndex.get(r.handle);
    if (e?.type !== 'INSERT') {
      res.missing.push(r.handle);
      continue;
    }
    const block = ownerOf(r.handle);
    if (!block) {
      res.missing.push(r.handle);
      continue;
    }
    if (doc.layers.get(tableKey(e.layer))?.locked) {
      res.locked++;
      continue;
    }
    const after = cloneEntity(e);
    let changed = false;
    const cols = new Map(attribColumns(after).map((c) => [c.column, c.attrib]));
    for (const [col, v] of r.values) {
      const a = cols.get(col);
      if (!a) {
        res.unknownTags.add(col);
        continue;
      }
      if (attribText(a) === v) continue;
      a.text = v;
      if (a.mtext) a.mtext.text = v;
      delete a.dwgRaw;
      changed = true;
    }
    if (!changed) {
      res.unchanged++;
      continue;
    }
    delete after.dwgRaw;
    res.ops.push({ kind: 'modify', block, before: e, after });
    res.updated++;
  }
  return res;
}
