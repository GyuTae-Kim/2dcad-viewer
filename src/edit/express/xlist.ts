/**
 * XLIST·XDLIST·NCOPY(Express Tools 중첩 객체·확장 데이터) 계산(UI 없음).
 * - XLIST: 블록·외부 참조 안의 중첩 객체 하나의 유형·블록 이름·도면층·색상·선종류·선가중치.
 * - XDLIST: 객체의 확장 데이터를 응용 프로그램 이름별로(와일드카드로 고를 수 있다).
 * - NCOPY: 중첩 객체를 바깥 참조들의 변환(바깥부터 곱한 것)으로 지금 공간에 복사한다.
 */
import type { BlockDef, CadDocument, Entity, InsertEntity, XData, XDataValue } from '../../core/model';
import { colorText, lineweightText, typeLabel } from '../util/select';
import { wcmatch } from '../util/wildcard';
import { chainXf, xformEntity } from '../refedit/xform';
import { freshEntity } from '../geom/path';

/** 바깥부터 차례로 놓인 참조(블록 정의와 그 참조) */
export type NestChain = readonly { def: BlockDef; insert: InsertEntity; xref?: string }[];

export interface XListRow {
  label: string;
  value: string;
}

/** XLIST 표(외부 참조 안 객체의 도면층은 `참조이름|도면층`) */
export function xlistRows(e: Entity, chain: NestChain): XListRow[] {
  const inner = chain[chain.length - 1];
  const xref = [...chain].reverse().find((c) => c.xref)?.xref;
  const layer = xref && e.layer !== '0' ? `${xref}|${e.layer}` : e.layer;
  const lt = e.linetype || 'ByLayer';
  return [
    { label: '객체', value: `${typeLabel(e.type === 'UNKNOWN' ? e.originalType : e.type)} (${e.type === 'UNKNOWN' ? e.originalType : e.type})` },
    { label: '블록 이름', value: inner ? (inner.xref && chain.length === 1 ? `${inner.def.name} (외부 참조)` : inner.def.name) : '' },
    { label: '도면층', value: layer },
    { label: '색상', value: colorText(e.color) },
    { label: '선종류', value: xref && !/^(bylayer|byblock|continuous)$/i.test(lt) ? `${xref}|${lt}` : lt },
    { label: '선가중치', value: lineweightText(e.lineweight) },
  ];
}

const CODE_LABEL: Record<number, string> = {
  1000: 'ASCII 문자열',
  1001: '등록된 응용 프로그램 이름',
  1002: '제어 문자열',
  1003: '도면층 이름',
  1004: '이진 데이터',
  1005: '데이터베이스 핸들',
  1010: '3D 점',
  1011: '3D 월드 공간 위치',
  1012: '3D 월드 공간 변위',
  1013: '3D 월드 공간 방향',
  1040: '실수',
  1041: '거리',
  1042: '축척 비율',
  1070: '정수',
  1071: '긴 정수',
};

function valueText(v: XDataValue): string {
  if (v instanceof Uint8Array) return [...v].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  if (typeof v === 'object') return `(${v.x}, ${v.y}, ${v.z})`;
  return String(v);
}

/** XDLIST 줄(app = 응용 프로그램 이름 와일드카드, 기본 *) */
export function xdataLines(xdata: readonly XData[] | undefined, app = '*'): string[] {
  const pat = app.trim() || '*';
  const list = (xdata ?? []).filter((x) => wcmatch(x.app, pat));
  if (!list.length) return [];
  const out: string[] = [];
  for (const x of list) {
    out.push(`* 등록된 응용 프로그램 이름: ${x.app}`);
    for (const it of x.items) out.push(`* 코드 ${it.code}, ${CODE_LABEL[it.code] ?? '값'}: ${valueText(it.value)}`);
  }
  return out;
}

/** 확장 데이터의 응용 프로그램 이름들 */
export function xdataApps(xdata: readonly XData[] | undefined): string[] {
  return [...new Set((xdata ?? []).map((x) => x.app))];
}

/**
 * NCOPY: 중첩 객체를 바깥 공간 좌표로 옮긴 사본(새 객체, 핸들 '').
 * 옮길 수 없으면 안내 문구(배열 삽입·X·Y 축척이 다른 참조·기울어진 Z축).
 */
export function nestedCopy(e: Entity, chain: NestChain, doc: CadDocument): Entity | string {
  const xf = chainXf(chain);
  if (typeof xf === 'string') return xf;
  const r = xformEntity(e, xf, doc);
  if (!r) return '이 객체는 복사할 수 없습니다.';
  const out = freshEntity(structuredClone(r.entity), false);
  delete out.paperSpace;
  return out;
}
