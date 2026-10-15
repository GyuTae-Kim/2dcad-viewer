/**
 * 도면층 상태(LAYERSTATE) 레코드: 도면의 XRECORD 태그와 도면층 상태 모델 사이의 변환.
 *
 * AutoCAD는 도면층 상태를 LAYER 표의 확장 사전 → `ACAD_LAYERSTATES` 사전 → 상태 이름마다 XRECORD로 둔다.
 * XRECORD 자료(AutoCAD 표본 sample_AC1015~AC1032·DynamicBlocks 도면에서 확인):
 *   91 마스크, 301 설명, 290 배치에서 저장(0/1), 302 현재 도면층 이름,
 *   도면층마다 330 도면층 핸들, 90 플래그, 62 색 번호, 370 선가중치, 331 선종류 핸들, 1 플롯 스타일 이름,
 *   440 투명도(AcCmTransparency 값, R2011 이후), [92 트루컬러(0xC2RRGGBB), 300 색상표 이름].
 * 상태 파일(.las)은 같은 코드를 쓰되 핸들 대신 이름(8 도면층, 6 선종류)과 2 플롯 스타일을 쓴다(las.ts).
 */
import type { CadColor, RawTag } from '../../core/model';
import { decodeCadEscapes } from '../../core/codepage';

/** 마스크(91): 복원할 특성 */
export const LSM_ON = 1;
export const LSM_FROZEN = 2;
export const LSM_LOCKED = 4;
export const LSM_PLOT = 8;
export const LSM_NEWVP = 16;
export const LSM_COLOR = 32;
export const LSM_LINETYPE = 64;
export const LSM_LINEWEIGHT = 128;
export const LSM_PLOTSTYLE = 256;
/** 현재 뷰포트에서 동결(AutoCAD가 늘 켠다) */
export const LSM_CURVP = 512;
export const LSM_TRANSPARENCY = 1024;
export const LSM_ALL = 2047;
/** 숨은 상태(명명된 뷰의 도면층 스냅샷 `ACAD_VIEWS_…` 등 — 관리자에 나오지 않는다) */
export const LSM_HIDDEN = 0x8000;

/** 도면층 플래그(90) */
export const LSF_OFF = 1;
export const LSF_FROZEN = 2;
export const LSF_LOCKED = 4;
export const LSF_PLOT = 8;
export const LSF_NEWVP = 16;
export const LSF_VPFROZEN = 32;

/** 복원할 특성(관리자의 "복원할 도면층 특성" 순서) */
export const RESTORE_PROPS: readonly { bit: number; label: string }[] = [
  { bit: LSM_ON, label: '켜기/끄기' },
  { bit: LSM_FROZEN, label: '동결/동결 해제' },
  { bit: LSM_CURVP, label: '현재 VP의 가시성' },
  { bit: LSM_LOCKED, label: '잠금/잠금 해제' },
  { bit: LSM_PLOT, label: '플롯/플롯 안 함' },
  { bit: LSM_NEWVP, label: '새 VP 동결/동결 해제' },
  { bit: LSM_COLOR, label: '색상' },
  { bit: LSM_LINETYPE, label: '선종류' },
  { bit: LSM_LINEWEIGHT, label: '선가중치' },
  { bit: LSM_TRANSPARENCY, label: '투명도' },
  { bit: LSM_PLOTSTYLE, label: '플롯 스타일' },
];

export interface LayerStateLayer {
  /** 도면층 이름(도면 레코드에서 핸들을 풀지 못했으면 빈 글) */
  name: string;
  /** 도면 레코드의 도면층 핸들(이름으로 다시 찾지 못할 때 그대로 쓴다) */
  handle?: string;
  flags: number;
  /** 색(1~255, 트루컬러면 rgb, 색상표면 name) */
  color: CadColor;
  lineweight: number;
  linetype: string;
  /** 플롯 스타일 이름(색상 종속 도면은 Color_n) */
  plotStyle: string;
  /** 0..255 불투명도(255 = 불투명) */
  transparency: number;
  /** 모르는 태그(그대로 다시 쓴다) */
  extra?: RawTag[];
}

export interface LayerState {
  name: string;
  mask: number;
  description: string;
  /** 290: 배치에서 저장한 상태 */
  paperSpace: boolean;
  /** 302: 저장할 때의 현재 도면층 */
  currentLayer: string;
  layers: LayerStateLayer[];
  /** 머리 부분의 모르는 태그 */
  extra?: RawTag[];
}

// ---------------------------------------------------------------------------
// 값 변환
// ---------------------------------------------------------------------------

/** 92(AcCmEntityColor 값, 0xC2RRGGBB)의 RGB. 트루컬러가 아니면 null */
export function trueColorOf(v: number): number | null {
  const u = v >>> 0;
  return u >>> 24 === 0xc2 ? u & 0xffffff : null;
}

/** RGB → 92 값(부호 있는 32비트 정수) */
export function trueColorValue(rgb: number): number {
  return ((0xc2 << 24) | (rgb & 0xffffff)) | 0;
}

/** 440(AcCmTransparency 값) → 0..255 불투명도. 값이 없거나 0이면 불투명 */
export function opacityOf(v: number): number {
  const u = v >>> 0;
  return u & 0x02000000 ? u & 0xff : 255;
}

/** 0..255 불투명도 → 440 값(불투명이면 0 — AutoCAD 표본과 같다) */
export function transparencyValue(opacity: number): number {
  if (!(opacity >= 0) || opacity >= 255) return 0;
  return (0x02000000 | Math.round(opacity)) | 0;
}

const num = (v: string | number | undefined, def = 0): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : def;
};
/** 글 값(R2007 이전 DXF가 코드 페이지 밖 글자를 \\U+XXXX로 쓴 것은 푼다) */
const str = (v: string | number | undefined): string => (v === undefined ? '' : decodeCadEscapes(String(v)));

// ---------------------------------------------------------------------------
// 태그 → 상태
// ---------------------------------------------------------------------------

export interface TagResolver {
  /** 도면층 핸들 → 이름(없으면 null) */
  layer?(handle: string): string | null;
  /** 선종류 핸들 → 이름(없으면 null) */
  linetype?(handle: string): string | null;
}

/**
 * 상태 태그(도면 XRECORD의 자료 또는 .las의 LAYERSTATE 뒤 태그)를 읽는다. 이름은 name에 준다(.las는 1에서 읽는다).
 * 도면층 항목은 330(핸들) 또는 8(이름)로 시작한다.
 */
export function parseStateTags(name: string, tags: readonly RawTag[], r: TagResolver = {}): LayerState {
  const st: LayerState = { name, mask: LSM_ALL, description: '', paperSpace: false, currentLayer: '0', layers: [] };
  let cur: LayerStateLayer | null = null;
  const extra = (t: RawTag) => {
    if (cur) (cur.extra ??= []).push({ code: t.code, value: t.value });
    else (st.extra ??= []).push({ code: t.code, value: t.value });
  };
  for (const t of tags) {
    if (t.code === 330 || t.code === 8) {
      const handle = t.code === 330 ? str(t.value).trim().toUpperCase() : undefined;
      const lname = t.code === 8 ? str(t.value) : handle && handle !== '0' ? (r.layer?.(handle) ?? '') : '';
      cur = { name: lname, flags: LSF_PLOT, color: { aci: 7 }, lineweight: -3, linetype: 'Continuous', plotStyle: '', transparency: 255 };
      if (handle !== undefined) cur.handle = handle;
      st.layers.push(cur);
      continue;
    }
    if (!cur) {
      switch (t.code) {
        case 1:
          if (!name) st.name = str(t.value);
          else extra(t);
          break;
        case 91:
          st.mask = num(t.value, LSM_ALL);
          break;
        case 301:
          st.description = str(t.value);
          break;
        case 290:
          st.paperSpace = num(t.value) !== 0;
          break;
        case 302:
          st.currentLayer = str(t.value);
          break;
        default:
          extra(t);
      }
      continue;
    }
    switch (t.code) {
      case 90:
        cur.flags = num(t.value);
        break;
      case 62: {
        const a = Math.abs(num(t.value, 7));
        cur.color = { ...cur.color, aci: a >= 1 && a <= 255 ? a : 7 };
        break;
      }
      case 370:
        cur.lineweight = num(t.value, -3);
        break;
      case 331: {
        const h = str(t.value).trim().toUpperCase();
        cur.linetype = (h && h !== '0' ? r.linetype?.(h) : null) ?? 'Continuous';
        break;
      }
      case 6:
        cur.linetype = str(t.value) || 'Continuous';
        break;
      case 1:
      case 2:
        cur.plotStyle = str(t.value);
        break;
      case 440:
        cur.transparency = opacityOf(num(t.value));
        break;
      case 92: {
        const rgb = trueColorOf(num(t.value));
        if (rgb !== null) cur.color = { ...cur.color, rgb };
        else extra(t);
        break;
      }
      case 300:
        cur.color = { ...cur.color, name: str(t.value) };
        break;
      default:
        extra(t);
    }
  }
  return st;
}

// ---------------------------------------------------------------------------
// 상태 → 태그
// ---------------------------------------------------------------------------

export interface TagNamer {
  /** 도면층 이름 → 핸들(없으면 null — 그 항목은 원래 핸들 또는 0) */
  layer(name: string): string | null;
  /** 선종류 이름 → 핸들(없으면 null — Continuous의 핸들) */
  linetype(name: string): string | null;
}

/** 머리 태그(91·301·290·302) */
function headTags(s: LayerState): RawTag[] {
  return [
    { code: 91, value: s.mask | 0 },
    { code: 301, value: s.description },
    { code: 290, value: s.paperSpace ? 1 : 0 },
    { code: 302, value: s.currentLayer || '0' },
    ...(s.extra ?? []),
  ];
}

/** 도면층 항목 뒤쪽 태그(62 뒤의 공통 부분) */
function colorAci(c: CadColor): number {
  const a = Math.abs(c.aci);
  return a >= 1 && a <= 255 ? a : 7;
}

/** 도면 XRECORD의 자료(280 복제 플래그 뒤) */
export function stateRecordTags(s: LayerState, n: TagNamer): RawTag[] {
  const out = headTags(s);
  for (const l of s.layers) {
    const h = (l.name ? n.layer(l.name) : null) ?? l.handle ?? '0';
    out.push({ code: 330, value: h });
    out.push({ code: 90, value: l.flags | 0 });
    out.push({ code: 62, value: colorAci(l.color) });
    out.push({ code: 370, value: l.lineweight });
    out.push({ code: 331, value: n.linetype(l.linetype) ?? n.linetype('Continuous') ?? '0' });
    out.push({ code: 1, value: l.plotStyle });
    out.push({ code: 440, value: transparencyValue(l.transparency) });
    if (l.color.rgb !== undefined) out.push({ code: 92, value: trueColorValue(l.color.rgb) });
    if (l.color.name) out.push({ code: 300, value: l.color.name });
    if (l.extra) out.push(...l.extra);
  }
  return out;
}

/** .las의 LAYERSTATE 한 개(0 LAYERSTATE 뒤 태그) */
export function stateFileTags(s: LayerState): RawTag[] {
  const out: RawTag[] = [{ code: 1, value: s.name }, ...headTags(s)];
  for (const l of s.layers) {
    if (!l.name) continue;
    out.push({ code: 8, value: l.name });
    out.push({ code: 90, value: l.flags | 0 });
    out.push({ code: 62, value: colorAci(l.color) });
    out.push({ code: 370, value: l.lineweight });
    out.push({ code: 6, value: l.linetype || 'Continuous' });
    out.push({ code: 2, value: l.plotStyle });
    out.push({ code: 440, value: transparencyValue(l.transparency) });
    if (l.color.rgb !== undefined) out.push({ code: 92, value: trueColorValue(l.color.rgb) });
    if (l.color.name) out.push({ code: 300, value: l.color.name });
    if (l.extra) out.push(...l.extra);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 이름
// ---------------------------------------------------------------------------

/** 쓸 수 없는 상태 이름 문자(도면층 이름과 같은 규칙) */
const BAD = /[<>/\\":;?*|,=`]/;

/** 상태 이름 검사(문제가 없으면 null) */
export function layerStateNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return '이름이 비어 있습니다.';
  if (n.length > 255) return '이름이 너무 깁니다.';
  if (BAD.test(n)) return '이름에 < > / \\ " : ; ? * | , = ` 문자는 쓸 수 없습니다.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(n)) return '이름에 제어 문자는 쓸 수 없습니다.';
  return null;
}

/** 마스크 글(켜진 특성 이름) */
export function maskText(mask: number): string {
  const parts = RESTORE_PROPS.filter((p) => mask & p.bit).map((p) => p.label);
  return parts.length ? parts.join(', ') : '없음';
}
