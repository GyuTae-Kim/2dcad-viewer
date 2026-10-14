/**
 * -LAYER(명령행 도면층)의 순수 계산: 옵션 해석, 이름 리스트·와일드카드, 색상·선가중치·투명도 값.
 * 와일드카드 비교는 AutoCAD 규칙(WCMATCH)의 src/edit/util/wildcard를 쓴다 — `*`·`?`·`#`·`@`·`.`·`[...]`·맨 앞 `~`·`` ` ``.
 * 쉼표로 여러 패턴을 나열한다(대소문자 구분 없음).
 */
import type { CadColor } from '../core/model';
import { nearestAci } from '../core/color';
import { wcmatch } from './util/wildcard';

export interface DashLayerOption {
  key: string;
  label: string;
  /** 영어판 옵션 이름(스크립트의 `_MAKE` 꼴) */
  global: string;
}

/** 옵션 목록(프롬프트 순서) */
export const DASH_LAYER_OPTIONS: readonly DashLayerOption[] = [
  { key: '?', label: '?', global: '?' },
  { key: 'M', label: '만들기', global: 'MAKE' },
  { key: 'S', label: '설정', global: 'SET' },
  { key: 'N', label: '새로 만들기', global: 'NEW' },
  { key: 'R', label: '이름 바꾸기', global: 'RENAME' },
  { key: 'ON', label: '켜기', global: 'ON' },
  { key: 'OFF', label: '끄기', global: 'OFF' },
  { key: 'C', label: '색상', global: 'COLOR' },
  { key: 'L', label: '선종류', global: 'LTYPE' },
  { key: 'LW', label: '선가중치', global: 'LWEIGHT' },
  { key: 'TR', label: '투명도', global: 'TRANSPARENCY' },
  { key: 'MAT', label: '재료', global: 'MATERIAL' },
  { key: 'P', label: '플롯', global: 'PLOT' },
  { key: 'F', label: '동결', global: 'FREEZE' },
  { key: 'T', label: '동결 해제', global: 'THAW' },
  { key: 'LO', label: '잠금', global: 'LOCK' },
  { key: 'U', label: '잠금 해제', global: 'UNLOCK' },
  { key: 'A', label: '상태', global: 'STATE' },
  { key: 'D', label: '설명', global: 'DESCRIPTION' },
  { key: 'E', label: '조정', global: 'RECONCILE' },
];

/** 주 프롬프트 */
export function dashLayerPrompt(): string {
  return `옵션 입력 [${DASH_LAYER_OPTIONS.map((o) => (o.key === '?' ? '?' : `${o.label}(${o.key})`)).join('/')}]:`;
}

/**
 * 입력한 글을 옵션 열쇠로. 열쇠(대소문자 무관), 한국어 이름, 영어판 이름(앞의 `_` 허용)과 그 이름의 앞부분
 * (다른 옵션과 겹치지 않는 만큼, 예: `MA` → 만들기, `FR` → 동결)을 받는다. 모르면 null.
 */
export function resolveDashLayerOption(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const up = t.toUpperCase().replace(/^_/, '');
  for (const o of DASH_LAYER_OPTIONS) if (o.key === up || o.label === t || o.global === up) return o.key;
  const hits = DASH_LAYER_OPTIONS.filter((o) => o.global.startsWith(up));
  return hits.length === 1 ? hits[0]!.key : null;
}

// ---------------------------------------------------------------------------
// 이름 리스트·와일드카드
// ---------------------------------------------------------------------------

/** 쉼표 리스트를 나눈다(앞뒤 공백·따옴표를 떼고, 빈 항목은 버린다. `` `, ``와 [] 안의 쉼표는 나누지 않는다) */
export function splitNameList(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inBr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '`' && i + 1 < text.length) {
      cur += ch + text[i + 1]!;
      i++;
      continue;
    }
    if (ch === '[') inBr = true;
    else if (ch === ']') inBr = false;
    if (ch === ',' && !inBr) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => unquote(s.trim())).filter((s) => s.length > 0);
}

export function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * 리스트(쉼표로 나눈 패턴들)와 맞는 이름(원래 순서, 겹침 없음)과, 아무 이름과도 맞지 않은 패턴.
 */
export function matchNameList(all: readonly string[], list: string): { names: string[]; unmatched: string[] } {
  const pats = splitNameList(list);
  const hit = new Set<string>();
  const unmatched: string[] = [];
  for (const p of pats) {
    let any = false;
    for (const n of all)
      if (wcmatch(n, p)) {
        hit.add(n);
        any = true;
      }
    if (!any) unmatched.push(p);
  }
  return { names: all.filter((n) => hit.has(n)), unmatched };
}

// ---------------------------------------------------------------------------
// 색상·선가중치·투명도
// ---------------------------------------------------------------------------

const ACI_NAMES: Record<number, string> = { 1: '빨간색', 2: '노란색', 3: '초록색', 4: '하늘색', 5: '파란색', 6: '선홍색', 7: '흰색' };
const NAME_TO_ACI: Record<string, number> = {
  RED: 1, 빨간색: 1, 빨강: 1,
  YELLOW: 2, 노란색: 2, 노랑: 2,
  GREEN: 3, 초록색: 3, 초록: 3,
  CYAN: 4, 하늘색: 4,
  BLUE: 5, 파란색: 5, 파랑: 5,
  MAGENTA: 6, 선홍색: 6,
  WHITE: 7, 흰색: 7,
};

/** 색 이름 보기: `1 (빨간색)`, `30`, `255,128,0` */
export function layerColorText(c: CadColor): string {
  if (c.rgb !== undefined) return `${(c.rgb >> 16) & 255},${(c.rgb >> 8) & 255},${c.rgb & 255}`;
  const n = Math.abs(c.aci);
  return ACI_NAMES[n] ? `${n} (${ACI_NAMES[n]})` : String(n);
}

/** 도면층 색 입력: 1–255 번호(음수는 그 색으로 하고 도면층을 끈다), 색 이름. 모르면 null */
export function parseLayerColor(text: string): { color: CadColor; off: boolean } | null {
  const t = text.trim();
  const named = NAME_TO_ACI[t.toUpperCase()] ?? NAME_TO_ACI[t];
  if (named) return { color: { aci: named }, off: false };
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    const a = Math.abs(n);
    if (a >= 1 && a <= 255) return { color: { aci: a }, off: n < 0 };
  }
  return null;
}

/** 트루컬러 입력 `r,g,b` */
export function parseTrueColor(text: string): CadColor | null {
  const m = /^(\d{1,3}),(\d{1,3}),(\d{1,3})$/.exec(text.replace(/\s+/g, ''));
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  if (r > 255 || g > 255 || b > 255) return null;
  const rgb = (r << 16) | (g << 8) | b;
  return { aci: nearestAci(rgb), rgb };
}

/** 표준 선가중치(1/100 mm) */
export const LINEWEIGHTS: readonly number[] = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

/**
 * 선가중치 입력(mm, `0.3`·`0.30mm`·`.3`) → 가장 가까운 표준 값(1/100 mm). `기본값`·`DEFAULT`·`D`는 −3.
 * 0 ~ 2.11mm 밖이거나 숫자가 아니면 null.
 */
export function parseLineweight(text: string): number | null {
  const t = text.trim().toUpperCase();
  if (t === 'DEFAULT' || t === 'D' || t === '기본값' || t === '기본') return -3;
  const m = /^(\d*\.?\d+)\s*(MM)?$/.exec(t);
  if (!m) return null;
  const mm = Number(m[1]);
  if (!Number.isFinite(mm) || mm < 0 || mm > 2.11 + 1e-9) return null;
  const v = mm * 100;
  let best = LINEWEIGHTS[0]!;
  for (const w of LINEWEIGHTS) if (Math.abs(w - v) < Math.abs(best - v) - 1e-9) best = w;
  return best;
}

export function lineweightText(lw: number): string {
  if (lw === -3) return '기본값';
  if (lw === -1) return 'ByLayer';
  if (lw === -2) return 'ByBlock';
  return `${(lw / 100).toFixed(2)}mm`;
}

/** 투명도(0–90 %) → 도면층의 불투명도(0–255) */
export function opacityFromPercent(pct: number): number {
  return Math.round(255 * (1 - Math.min(90, Math.max(0, pct)) / 100));
}

/** 도면층 불투명도 → 투명도(%) */
export function percentFromOpacity(opacity: number): number {
  if (!(opacity >= 0) || opacity > 255) return 0;
  return Math.round((1 - opacity / 255) * 100);
}

/** 투명도 입력(0–90 정수 또는 소수, `%` 허용). 범위 밖이면 null */
export function parseTransparency(text: string): number | null {
  const t = text.trim().replace(/%$/, '');
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const v = Number(t);
  return v >= 0 && v <= 90 ? v : null;
}

/** 도면층 상태 글(? 목록) */
export function layerStateText(l: { off: boolean; frozen: boolean; locked: boolean }): string {
  const parts = [l.off ? '끄기' : '켜기'];
  if (l.frozen) parts.push('동결');
  if (l.locked) parts.push('잠금');
  return parts.join(' ');
}
