/**
 * 데이터 추출(DATAEXTRACTION): 객체를 행으로 모은다. 블록 참조는 이름과 속성 값, 그 밖의 객체는 종류.
 * 같은 행은 묶어 개수를 센다. 화면과 떨어진 순수 함수.
 */
import type { CadDocument, Entity, InsertEntity } from '../core/model';
import { tableKey } from '../core/model';

export interface ExtractOptions {
  /** 블록 참조만(아니면 모든 객체를 종류별로) */
  blocksOnly: boolean;
  /** 블록 속성 값 열 */
  attributes: boolean;
  /** 도면층 열 */
  layer: boolean;
  /** 같은 행을 묶어 개수로 */
  combine: boolean;
}

export interface ExtractResult {
  columns: string[];
  rows: string[][];
}

/** 블록 참조의 보이는 이름(익명 동적 블록이면 본래 이름) */
export function blockDisplayName(doc: CadDocument, e: InsertEntity): string {
  if (!/^\*U/i.test(e.block)) return e.block;
  const rec = doc.blockRecords.get(tableKey(e.block));
  const tn = rec?.xdata?.find((x) => x.app.toUpperCase() === 'ACDBDYNAMICBLOCKTRUENAME')?.items.find((i) => i.code === 1000)?.value;
  return typeof tn === 'string' && tn ? tn : e.block;
}

/** 객체 종류의 한국어 이름 */
const KIND: Record<string, string> = {
  LINE: '선',
  LWPOLYLINE: '폴리선',
  POLYLINE: '폴리선',
  CIRCLE: '원',
  ARC: '호',
  ELLIPSE: '타원',
  SPLINE: '스플라인',
  POINT: '점',
  TEXT: '문자',
  MTEXT: '여러 줄 문자',
  INSERT: '블록 참조',
  DIMENSION: '치수',
  LEADER: '지시선',
  MULTILEADER: '다중 지시선',
  HATCH: '해치',
  SOLID: '2D 솔리드',
  XLINE: '구성선',
  RAY: '광선',
  ACAD_TABLE: '표',
  MLINE: '여러 줄',
  IMAGE: '래스터 이미지',
  WIPEOUT: '가리기',
  VIEWPORT: '뷰포트',
  TOLERANCE: '공차',
};

export function kindName(type: string): string {
  return KIND[type] ?? type;
}

export function extractData(doc: CadDocument, entities: readonly Entity[], opt: ExtractOptions): ExtractResult {
  const list = opt.blocksOnly ? entities.filter((e): e is InsertEntity => e.type === 'INSERT') : entities;
  // 속성 태그(처음 나온 순서)
  const tags: string[] = [];
  if (opt.attributes)
    for (const e of list)
      if (e.type === 'INSERT')
        for (const a of e.attribs) {
          const t = a.tag?.toUpperCase();
          if (t && !tags.includes(t)) tags.push(t);
        }
  const columns = [opt.combine ? '개수' : null, opt.blocksOnly ? '이름' : '종류', opt.blocksOnly ? null : '이름', opt.layer ? '도면층' : null, ...tags].filter((c): c is string => c !== null);
  const rowsOf = (e: Entity): string[] => {
    const ins = e.type === 'INSERT' ? (e as InsertEntity) : null;
    const name = ins ? blockDisplayName(doc, ins) : '';
    const vals = tags.map((t) => {
      const a = ins?.attribs.find((x) => x.tag?.toUpperCase() === t);
      return a ? (a.mtext?.text ?? a.text ?? '') : '';
    });
    const head = opt.blocksOnly ? [name] : [kindName(e.type), name];
    return [...head, ...(opt.layer ? [e.layer] : []), ...vals];
  };
  const raw = list.map(rowsOf);
  let rows: string[][];
  if (opt.combine) {
    const count = new Map<string, { row: string[]; n: number }>();
    for (const r of raw) {
      const k = JSON.stringify(r);
      const c = count.get(k);
      if (c) c.n++;
      else count.set(k, { row: r, n: 1 });
    }
    rows = [...count.values()].map((c) => [String(c.n), ...c.row]);
  } else rows = raw;
  const off = opt.combine ? 1 : 0;
  rows.sort((a, b) => {
    for (let i = off; i < a.length; i++) {
      const d = (a[i] ?? '').localeCompare(b[i] ?? '', 'ko', { numeric: true });
      if (d) return d;
    }
    return 0;
  });
  return { columns, rows };
}

/** CSV(엑셀이 한글을 알아보도록 BOM과 CRLF) */
export function toCsv(r: ExtractResult): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return '﻿' + [r.columns, ...r.rows].map((row) => row.map(q).join(',')).join('\r\n') + '\r\n';
}
