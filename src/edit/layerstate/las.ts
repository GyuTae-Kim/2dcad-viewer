/**
 * 도면층 상태 파일(.las) 읽기·쓰기.
 *
 * DXF처럼 그룹 코드 줄과 값 줄의 쌍이다: `0 LAYERSTATEDICTIONARY` 뒤 상태마다 `0 LAYERSTATE`, `1` 이름, `91` 마스크,
 * `301` 설명, `290` 배치에서 저장, `302` 현재 도면층, 도면층마다 `8` 이름·`90` 플래그·`62` 색·`370` 선가중치·`6` 선종류·
 * `2` 플롯 스타일·`440` 투명도(트루컬러는 끝에 `92`). AutoCAD는 시스템 코드 페이지(한국어판 CP949)의 글, CR LF,
 * 그룹 코드 3칸 오른쪽 맞춤으로 쓰고 파일 끝 표지가 없다. 쓰기는 같은 꼴(CP949, 그 코드 페이지에 없는 글자는 \U+XXXX)이다.
 * 읽기는 UTF-8이 아니면 CP949로 읽고 \U+XXXX를 푼다. 모르는 코드는 상태·도면층의 원본 태그로 남긴다.
 */
import type { RawTag } from '../../core/model';
import { decodeCadEscapes, decoderFor } from '../../core/codepage';
import { encoderFor } from '../../io/dwg/writer/codepage';
import { type LayerState, parseStateTags, stateFileTags } from './record';

export const LAS_DICT = 'LAYERSTATEDICTIONARY';
export const LAS_STATE = 'LAYERSTATE';
/** 읽는 파일 크기 상한 */
export const LAS_MAX_BYTES = 8 * 1024 * 1024;

export class LasFormatError extends Error {
  constructor() {
    super('도면층 상태 파일(LAS)의 형식이 올바르지 않습니다.');
  }
}

/** 바이트 → 글(UTF-8, 아니면 CP949) */
export function decodeLasText(bytes: Uint8Array): string {
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    s = decoderFor('euc-kr').decode(bytes);
  }
  return s.replace(/^﻿/, '');
}

/** 글 → 코드·값 쌍 */
function pairs(text: string): RawTag[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: RawTag[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = lines[i]!.trim();
    if (!/^-?\d+$/.test(c)) throw new LasFormatError();
    out.push({ code: Number(c), value: lines[i + 1]! });
  }
  return out;
}

const INT_CODES = new Set([62, 90, 91, 92, 290, 370, 440]);

/** .las 글 → 상태 목록 */
export function parseLas(text: string): LayerState[] {
  const tags = pairs(text);
  if (!tags.length || tags[0]!.code !== 0 || tags[0]!.value.toString().trim().toUpperCase() !== LAS_DICT) throw new LasFormatError();
  const groups: RawTag[][] = [];
  let open = false;
  for (const t of tags.slice(1)) {
    if (t.code === 0) {
      const v = String(t.value).trim().toUpperCase();
      if (v === LAS_STATE) {
        groups.push([]);
        open = true;
      } else if (v === 'EOF') open = false;
      else throw new LasFormatError();
      continue;
    }
    if (!open) continue;
    const raw = String(t.value);
    const value: string | number = INT_CODES.has(t.code) && /^\s*-?\d+\s*$/.test(raw) ? Number(raw.trim()) : decodeCadEscapes(raw.replace(/\s+$/, ''));
    groups[groups.length - 1]!.push({ code: t.code, value });
  }
  return groups.map((g) => parseStateTags('', g)).filter((s) => s.name);
}

/** 바이트 → 상태 목록(크기·형식이 틀리면 LasFormatError) */
export function readLas(bytes: Uint8Array): LayerState[] {
  if (bytes.length > LAS_MAX_BYTES) throw new LasFormatError();
  return parseLas(decodeLasText(bytes));
}

/** 상태들 → .las 글(CR LF, 코드 3칸 오른쪽 맞춤) */
export function lasText(states: readonly LayerState[]): string {
  const lines: string[] = [];
  const put = (code: number, v: string | number) => {
    lines.push(String(code).padStart(3, ' '));
    lines.push(String(v));
  };
  put(0, LAS_DICT);
  for (const s of states) {
    put(0, LAS_STATE);
    for (const t of stateFileTags(s)) put(t.code, typeof t.value === 'string' ? t.value.replace(/[\r\n]+/g, ' ') : t.value);
  }
  return lines.join('\r\n') + '\r\n';
}

/** 상태들 → .las 바이트(코드 페이지, 기본 한국어판 AutoCAD와 같은 CP949) */
export function writeLas(states: readonly LayerState[], codepage = 'ANSI_949'): Uint8Array {
  return encoderFor(codepage).encode(lasText(states));
}

/** 내려받을 파일 이름(쓸 수 없는 문자는 _) */
export function lasFileName(stateName: string): string {
  return `${stateName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'layerstate'}.las`;
}
