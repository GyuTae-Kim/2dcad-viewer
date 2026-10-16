/**
 * 치수 스타일 관리자: DIMSTYLE(D, DST, DDIM, DIMSTY)
 * 한 대화상자 안의 스타일 목록(모든·사용 중인 스타일, 현재 스타일 아래 <스타일 재지정>)·미리보기·설명과
 * 현재로 설정·새로 만들기·수정·재지정·비교. 목록의 오른쪽 클릭(또는 F2·Delete)으로 이름 바꾸기·삭제,
 * <스타일 재지정>은 현재 스타일에 저장·이름 바꾸기(새 스타일)·삭제.
 * 수정·새 스타일·재지정 대화상자는 선·기호 및 화살표·문자·맞춤·1차 단위·대체 단위·공차 7탭이 한 대화상자 안에 있고
 * 값을 바꾸면 미리보기가 따라간다. 스타일을 고치면 그 스타일을 쓰는 치수를 다시 만든다.
 * 재지정은 머리말 치수 변수(AutoCAD가 재지정을 두는 자리)에 두고, 새 치수(dimcmds.addDimension)가 그 값을 재지정으로 지닌다.
 * 탭 이름과 항목은 AutoCAD 2026 한국어판의 "치수 스타일 수정" 대화상자를 따른다.
 */
import { DIM_VAR_DEFAULTS } from '../core/dimvars';
import type { CadDocument, DimStyle, DimensionEntity, Entity, HeaderValue } from '../core/model';
import { tableKey } from '../core/model';
import { createLinearDimension, createRadialDimension, generateDimensionGeometry } from '../edit/dim';
import { DIM_VAR_BY_NAME, type Overrides } from '../edit/annot/override';
import type { EditOp } from '../edit/session';
import type { App } from './app';
import { drawGeometry } from './blockpreview';
import { dimensionBlockOps } from './dimcmds';
import type { DocState } from './docstate';
import { ask, dialog, form, h, showMenu } from './ui/dom';
import { annotativeFlag, withAnnotativeFlag } from '../edit/annoscale/xdata';

type Opt = { value: string; label: string };
interface VarField {
  v: string;
  label: string;
  kind: 'num' | 'int' | 'angle' | 'check' | 'select' | 'text' | 'style' | 'arrow' | 'color' | 'lw';
  options?: Opt[];
}

const ARROWS: Opt[] = [
  { value: '', label: '닫고 채움' },
  { value: '_CLOSEDBLANK', label: '닫힌 공백' },
  { value: '_CLOSED', label: '닫힘' },
  { value: '_DOT', label: '점' },
  { value: '_ARCHTICK', label: '건축 눈금' },
  { value: '_OBLIQUE', label: '기울기' },
  { value: '_OPEN', label: '열기' },
  { value: '_ORIGIN', label: '원점 표시기' },
  { value: '_OPEN90', label: '직각' },
  { value: '_OPEN30', label: '열린 30도' },
  { value: '_DOTSMALL', label: '작은 점' },
  { value: '_DOTBLANK', label: '공백 점' },
  { value: '_SMALL', label: '작은 표식' },
  { value: '_BOXBLANK', label: '상자' },
  { value: '_BOXFILLED', label: '채워진 상자' },
  { value: '_DATUMBLANK', label: '데이텀 삼각형' },
  { value: '_DATUMFILLED', label: '채워진 데이텀 삼각형' },
  { value: '_INTEGRAL', label: '적분' },
  { value: '_NONE', label: '없음' },
];

const TABS: [string, VarField[]][] = [
  [
    '선',
    [
      { v: 'DIMCLRD', label: '치수선 색상(ACI, 0 블록별·256 도면층별)', kind: 'color' },
      { v: 'DIMLWD', label: '치수선 선가중치(mm, -1 도면층별·-2 블록별)', kind: 'lw' },
      { v: 'DIMDLE', label: '눈금 너머로 연장', kind: 'num' },
      { v: 'DIMDLI', label: '기준선 간격', kind: 'num' },
      { v: 'DIMSD1', label: '치수선 1 억제', kind: 'check' },
      { v: 'DIMSD2', label: '치수선 2 억제', kind: 'check' },
      { v: 'DIMCLRE', label: '치수보조선 색상', kind: 'color' },
      { v: 'DIMLWE', label: '치수보조선 선가중치(mm)', kind: 'lw' },
      { v: 'DIMSE1', label: '치수보조선 1 억제', kind: 'check' },
      { v: 'DIMSE2', label: '치수보조선 2 억제', kind: 'check' },
      { v: 'DIMEXE', label: '치수선 너머로 연장', kind: 'num' },
      { v: 'DIMEXO', label: '원점에서 간격띄우기', kind: 'num' },
      { v: 'DIMFXLON', label: '고정 길이 치수보조선', kind: 'check' },
      { v: 'DIMFXL', label: '고정 길이', kind: 'num' },
    ],
  ],
  [
    '기호 및 화살표',
    [
      { v: 'DIMBLK1', label: '첫 번째 화살촉', kind: 'arrow' },
      { v: 'DIMBLK2', label: '두 번째 화살촉', kind: 'arrow' },
      { v: 'DIMLDRBLK', label: '지시선 화살촉', kind: 'arrow' },
      { v: 'DIMASZ', label: '화살표 크기', kind: 'num' },
      { v: 'DIMTSZ', label: '눈금 크기(0이면 화살촉)', kind: 'num' },
      { v: 'DIMCEN', label: '중심 표식(양수 표식, 음수 선, 0 없음)', kind: 'num' },
      {
        v: 'DIMARCSYM',
        label: '호 길이 기호',
        kind: 'select',
        options: [
          { value: '0', label: '앞의 치수 문자' },
          { value: '1', label: '위의 치수 문자' },
          { value: '2', label: '없음' },
        ],
      },
      { v: 'DIMJOGANG', label: '꺾기 각도(도)', kind: 'angle' },
    ],
  ],
  [
    '문자',
    [
      { v: 'DIMTXSTY', label: '문자 스타일', kind: 'style' },
      { v: 'DIMCLRT', label: '문자 색상', kind: 'color' },
      {
        v: 'DIMTFILL',
        label: '채우기 색상',
        kind: 'select',
        options: [
          { value: '0', label: '없음' },
          { value: '1', label: '배경' },
          { value: '2', label: '색상 지정(DIMTFILLCLR)' },
        ],
      },
      { v: 'DIMTFILLCLR', label: '채우기 색상 번호', kind: 'color' },
      { v: 'DIMTXT', label: '문자 높이', kind: 'num' },
      {
        v: 'DIMTAD',
        label: '수직 배치',
        kind: 'select',
        options: [
          { value: '0', label: '중심' },
          { value: '1', label: '위' },
          { value: '2', label: '외부' },
          { value: '3', label: 'JIS' },
          { value: '4', label: '아래' },
        ],
      },
      {
        v: 'DIMJUST',
        label: '수평 배치',
        kind: 'select',
        options: [
          { value: '0', label: '중심' },
          { value: '1', label: '치수보조선 1에' },
          { value: '2', label: '치수보조선 2에' },
          { value: '3', label: '치수보조선 1 너머' },
          { value: '4', label: '치수보조선 2 너머' },
        ],
      },
      { v: 'DIMGAP', label: '치수선에서 간격띄우기', kind: 'num' },
      { v: 'DIMTIH', label: '치수보조선 안쪽 문자 수평', kind: 'check' },
      { v: 'DIMTOH', label: '치수보조선 바깥쪽 문자 수평', kind: 'check' },
    ],
  ],
  [
    '맞춤',
    [
      {
        v: 'DIMATFIT',
        label: '맞춤 옵션(공간이 모자랄 때 밖으로)',
        kind: 'select',
        options: [
          { value: '3', label: '문자 또는 화살표(최대로 맞춤)' },
          { value: '1', label: '화살표' },
          { value: '2', label: '문자' },
          { value: '0', label: '문자와 화살표 모두' },
        ],
      },
      { v: 'DIMTIX', label: '항상 치수보조선 사이에 문자 유지', kind: 'check' },
      { v: 'DIMSOXD', label: '화살표가 맞지 않으면 억제', kind: 'check' },
      {
        v: 'DIMTMOVE',
        label: '문자가 기본 위치에 있지 않을 때',
        kind: 'select',
        options: [
          { value: '0', label: '치수선 옆에 배치' },
          { value: '1', label: '치수선 위, 지시선 사용' },
          { value: '2', label: '치수선 위, 지시선 없음' },
        ],
      },
      { v: 'DIMSCALE', label: '전체 축척 사용', kind: 'num' },
      { v: 'DIMTOFL', label: '치수보조선 사이에 치수선 그리기', kind: 'check' },
      { v: 'DIMUPT', label: '수동으로 문자 배치', kind: 'check' },
    ],
  ],
  [
    '1차 단위',
    [
      {
        v: 'DIMLUNIT',
        label: '단위 형식',
        kind: 'select',
        options: [
          { value: '1', label: '과학' },
          { value: '2', label: '십진' },
          { value: '3', label: '공학' },
          { value: '4', label: '건축' },
          { value: '5', label: '분수' },
          { value: '6', label: 'Windows 바탕 화면' },
        ],
      },
      { v: 'DIMDEC', label: '정밀도(소수 자릿수)', kind: 'int' },
      {
        v: 'DIMDSEP',
        label: '소수 구분 기호',
        kind: 'select',
        options: [
          { value: '46', label: "'.' (마침표)" },
          { value: '44', label: "',' (쉼표)" },
          { value: '32', label: "' ' (공백)" },
        ],
      },
      { v: 'DIMRND', label: '반올림', kind: 'num' },
      { v: 'DIMPOST', label: '머리말·꼬리말(<>가 값 자리)', kind: 'text' },
      { v: 'DIMLFAC', label: '측정 축척 비율', kind: 'num' },
      { v: 'DIMZIN', label: '0 억제(DIMZIN: 4 선행, 8 후행, 12 둘 다)', kind: 'int' },
      {
        v: 'DIMAUNIT',
        label: '각도 단위 형식',
        kind: 'select',
        options: [
          { value: '0', label: '십진 도수' },
          { value: '1', label: '도/분/초' },
          { value: '2', label: '그라디안' },
          { value: '3', label: '라디안' },
        ],
      },
      { v: 'DIMADEC', label: '각도 정밀도', kind: 'int' },
    ],
  ],
  [
    '대체 단위',
    [
      { v: 'DIMALT', label: '대체 단위 표시', kind: 'check' },
      { v: 'DIMALTF', label: '대체 단위 승수', kind: 'num' },
      { v: 'DIMALTD', label: '대체 단위 정밀도', kind: 'int' },
      { v: 'DIMAPOST', label: '대체 단위 머리말·꼬리말([]가 값 자리)', kind: 'text' },
    ],
  ],
  [
    '공차',
    [
      {
        v: 'DIMTOL',
        label: '공차 형식',
        kind: 'select',
        options: [
          { value: '0', label: '없음' },
          { value: '1', label: '대칭·편차' },
        ],
      },
      { v: 'DIMLIM', label: '한계 치수', kind: 'check' },
      { v: 'DIMTP', label: '위 값', kind: 'num' },
      { v: 'DIMTM', label: '아래 값', kind: 'num' },
      { v: 'DIMTDEC', label: '공차 정밀도', kind: 'int' },
      { v: 'DIMTFAC', label: '높이 축척', kind: 'num' },
      {
        v: 'DIMTOLJ',
        label: '수직 위치',
        kind: 'select',
        options: [
          { value: '0', label: '아래' },
          { value: '1', label: '중간' },
          { value: '2', label: '위' },
        ],
      },
    ],
  ],
];


type Vars = Record<string, number | string>;

/** 스타일의 변수(없는 것은 기본값) */
export function styleVars(s: DimStyle | undefined): Vars {
  return { ...DIM_VAR_DEFAULTS, ...(s?.vars ?? {}) };
}

const sameVal = (a: number | string | undefined, b: number | string | undefined): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();
};

/** 재지정으로 쓰는 변수(이름을 핸들로 바꿔야 하는 화살촉·선종류는 빼고 문자 스타일은 이름으로) */
const OVERRIDE_VARS = Object.keys(DIM_VAR_DEFAULTS).filter((n) => !/^DIM(BLK\d?|LDRBLK|LTYPE|LTEX\d)$/.test(n));

/** 머리말 치수 변수 중 스타일 값과 다른 것(<스타일 재지정>) */
export function headerOverrides(doc: CadDocument, styleName: string): Vars {
  const s = doc.dimStyles.get(tableKey(styleName));
  if (!s) return {};
  const sv = styleVars(s);
  const out: Vars = {};
  for (const n of OVERRIDE_VARS) {
    const hv = doc.header.get(`$${n}`);
    if (hv === undefined || typeof hv === 'object') continue;
    if (!sameVal(hv as number | string, sv[n])) out[n] = hv as number | string;
  }
  return out;
}

/** 재지정 변수 → 치수 객체의 재지정(그룹 코드 → 값). 문자 스타일은 핸들로 */
export function overridesOf(doc: CadDocument, ov: Vars): Overrides {
  const out: Overrides = {};
  for (const [n, v] of Object.entries(ov)) {
    const code = DIM_VAR_BY_NAME.get(n);
    if (code === undefined) continue;
    if (n === 'DIMTXSTY') {
      const ts = doc.textStyles.get(tableKey(String(v)));
      if (ts?.handle) out[code] = ts.handle;
      continue;
    }
    if (code >= 340) continue;
    out[code] = v;
  }
  return out;
}

/** 머리말 치수 변수를 vars로 맞추는 작업(머리말에 있는 변수만) */
function headerVarOps(doc: CadDocument, vars: Vars, only?: readonly string[]): EditOp[] {
  const ops: EditOp[] = [];
  for (const n of only ?? OVERRIDE_VARS) {
    const key = `$${n}`;
    const before = doc.header.get(key);
    if (before === undefined && !(only && only.includes(n))) continue;
    const after = vars[n];
    if (after === undefined || (before !== undefined && typeof before !== 'object' && sameVal(before as number | string, after))) continue;
    ops.push({ kind: 'header', name: key, before, after: after as HeaderValue });
  }
  return ops;
}

/** 이 스타일을 쓰는 치수(모든 공간·블록)를 다시 만드는 편집 */
function regenOps(st: DocState, styleName: string): EditOp[] {
  const ops: EditOp[] = [];
  const extra = new Set<string>();
  const key = tableKey(styleName);
  for (const [bk, b] of st.doc.blocks) {
    if (/^\*D\d+$/i.test(b.name)) continue;
    for (const e of b.entities) {
      if (e.type !== 'DIMENSION' || tableKey(e.dimStyle || 'Standard') !== key) continue;
      const copy = structuredClone(e) as DimensionEntity;
      try {
        const bo = dimensionBlockOps(st, copy, true, extra);
        ops.push(...bo, { kind: 'modify', block: bk, before: e, after: copy as Entity });
      } catch {
        /* 생성기가 못 다루는 치수는 그대로 둔다 */
      }
    }
  }
  return ops;
}

function usedStyles(st: DocState): Map<string, number> {
  const used = new Map<string, number>();
  for (const b of st.doc.blocks.values())
    for (const e of b.entities)
      if (e.type === 'DIMENSION' || e.type === 'LEADER' || e.type === 'TOLERANCE') {
        const k = tableKey((e as { dimStyle?: string }).dimStyle || 'Standard');
        used.set(k, (used.get(k) ?? 0) + 1);
      }
  return used;
}

/** 스타일 이름 바꾸기: 스타일 레코드와 그 이름을 쓰는 치수·지시선·공차, 머리말 $DIMSTYLE */
export function dimStyleRenameOps(st: DocState, from: string, to: string): EditOp[] {
  const doc = st.doc;
  const fk = tableKey(from);
  const s = doc.dimStyles.get(fk);
  if (!s) return [];
  const ops: EditOp[] = [
    { kind: 'dimStyle', key: fk, before: s, after: null },
    { kind: 'dimStyle', key: tableKey(to), before: null, after: { ...s, name: to } },
  ];
  for (const [bk, b] of doc.blocks)
    for (const e of b.entities) {
      if ((e.type === 'DIMENSION' || e.type === 'LEADER' || e.type === 'TOLERANCE') && tableKey((e as { dimStyle: string }).dimStyle || 'Standard') === fk) ops.push({ kind: 'modify', block: bk, before: e, after: { ...structuredClone(e), dimStyle: to } as Entity });
    }
  if (tableKey(String(doc.header.get('$DIMSTYLE') ?? '')) === fk) ops.push({ kind: 'header', name: '$DIMSTYLE', before: doc.header.get('$DIMSTYLE'), after: to });
  return ops;
}

/** 변수 설명(대화상자 항목 이름) */
const LABELS = new Map<string, string>(TABS.flatMap(([, fs]) => fs.map((f) => [f.v, f.label] as const)));

export interface VarDiff {
  name: string;
  label: string;
  a: string;
  b: string;
}

const show = (v: number | string | undefined): string => (v === undefined ? '' : typeof v === 'number' ? String(+v.toFixed(6)) : v === '' ? '""' : v);

/** 두 스타일의 다른 변수(b가 없으면 a의 모든 변수) */
export function compareVars(a: Vars, b: Vars | null): VarDiff[] {
  const names = [...new Set([...Object.keys(a), ...(b ? Object.keys(b) : [])])].filter((n) => /^DIM/.test(n)).sort();
  const out: VarDiff[] = [];
  for (const n of names) {
    if (b && sameVal(a[n], b[n])) continue;
    out.push({ name: n, label: LABELS.get(n) ?? n, a: show(a[n]), b: b ? show(b[n]) : '' });
  }
  return out;
}

const PREVIEW = '__OPENCAD_PREVIEW__';

/** 치수 스타일 미리보기(선형 두 개·반지름 하나)를 캔버스에 */
export function drawDimPreview(app: App, canvas: HTMLCanvasElement, base: DimStyle | undefined, vars: Vars): void {
  const st = app.active;
  if (!st) return;
  const style: DimStyle = { ...(base ?? { handle: '0', flags: 0 }), name: PREVIEW, vars } as DimStyle;
  const pd = { ...st.doc, dimStyles: new Map(st.doc.dimStyles).set(tableKey(PREVIEW), style) } as CadDocument;
  const s = (Number(vars.DIMTXT) || 2.5) * (Number(vars.DIMSCALE) || 1);
  const L = s * 10;
  const ents: Entity[] = [];
  try {
    const ds = [
      createLinearDimension(pd, { x: 0, y: 0, z: 0 }, { x: L, y: 0, z: 0 }, { x: L / 2, y: L * 0.85, z: 0 }, { style: PREVIEW }),
      createLinearDimension(pd, { x: L, y: 0, z: 0 }, { x: L, y: L * 0.6, z: 0 }, { x: L + s * 3, y: L * 0.3, z: 0 }, { style: PREVIEW }),
      createRadialDimension(pd, { x: L * 0.35, y: L * 0.3, z: 0 }, L * 0.2, Math.PI / 4, { style: PREVIEW }),
    ];
    for (const d of ds) ents.push(...generateDimensionGeometry(pd, d).entities);
    const ln = (x0: number, y0: number, x1: number, y1: number) => ents.push({ type: 'LINE', handle: '', layer: '0', color: { aci: 256 }, linetype: 'ByLayer', lineweight: -1, ltscale: 1, transparency: -1, start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } } as Entity);
    ln(0, 0, L, 0);
    ln(L, 0, L, L * 0.6);
    ln(L, L * 0.6, 0, L * 0.6);
    ln(0, L * 0.6, 0, 0);
    ents.push({ type: 'CIRCLE', handle: '', layer: '0', color: { aci: 256 }, linetype: 'ByLayer', lineweight: -1, ltscale: 1, transparency: -1, center: { x: L * 0.35, y: L * 0.3, z: 0 }, radius: L * 0.2 } as Entity);
  } catch {
    /* 그릴 수 없는 값 */
  }
  let g = null;
  try {
    g = ents.length ? (app.picker()?.geometryOf(ents) ?? null) : null;
  } catch {
    g = null;
  }
  drawGeometry(canvas, g, '#cfd6e0');
}

// ---------------------------------------------------------------------------
// 수정·새 스타일·재지정 대화상자(7탭)
// ---------------------------------------------------------------------------

const CSS_IN = 'height:24px;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;font:inherit;padding:0 4px';

/** 탭 하나의 입력 칸(값이 바뀌면 vars를 고치고 change를 부른다) */
function tabPanel(st: DocState, vars: Vars, tab: VarField[], change: () => void): HTMLElement {
  const styles = [...st.doc.textStyles.values()].filter((t) => t.name && !(t.flags & 1)).map((t) => t.name);
  const rows = tab.map((f) => {
    const cur = vars[f.v] ?? DIM_VAR_DEFAULTS[f.v] ?? 0;
    let el: HTMLInputElement | HTMLSelectElement;
    const set = (v: number | string) => {
      vars[f.v] = v;
      // 화살촉을 따로 정하면 DIMSAH를 켠다(같으면 DIMBLK 하나로)
      if (f.v === 'DIMBLK1' || f.v === 'DIMBLK2') {
        const b1 = String(vars.DIMBLK1 ?? vars.DIMBLK ?? '');
        const b2 = String(vars.DIMBLK2 ?? vars.DIMBLK ?? '');
        if (b1.toUpperCase() === b2.toUpperCase()) {
          vars.DIMBLK = b1;
          vars.DIMSAH = 0;
        } else vars.DIMSAH = 1;
      }
      change();
    };
    switch (f.kind) {
      case 'check': {
        const c = h('input', { type: 'checkbox', 'aria-label': f.label }) as HTMLInputElement;
        c.checked = Number(cur) !== 0;
        c.addEventListener('change', () => set(c.checked ? 1 : 0));
        el = c;
        break;
      }
      case 'select':
      case 'arrow':
      case 'style': {
        let opts: Opt[] = f.options ?? [];
        let v = String(cur);
        if (f.kind === 'arrow') {
          v = String(cur || (f.v !== 'DIMLDRBLK' ? (vars.DIMBLK ?? '') : '') || '').toUpperCase();
          opts = ARROWS.some((a) => a.value === v) ? ARROWS : [...ARROWS, { value: v, label: `사용자 블록 ${v}` }];
        } else if (f.kind === 'style') {
          opts = (styles.length ? styles : ['Standard']).map((n) => ({ value: n, label: n }));
          v = opts.find((o) => tableKey(o.value) === tableKey(v || 'Standard'))?.value ?? opts[0]!.value;
        }
        const sel = h('select', { 'aria-label': f.label, style: CSS_IN }, ...opts.map((o) => h('option', { value: o.value }, o.label))) as HTMLSelectElement;
        sel.value = v;
        sel.addEventListener('change', () => set(f.kind === 'select' ? Number(sel.value) : sel.value));
        el = sel;
        break;
      }
      default: {
        const i = h('input', { 'aria-label': f.label, style: `${CSS_IN};width:110px`, inputmode: f.kind === 'text' ? undefined : 'decimal' }) as HTMLInputElement;
        i.value = f.kind === 'angle' ? String(+((Number(cur) * 180) / Math.PI).toFixed(6)) : f.kind === 'lw' ? String(Number(cur) < 0 ? Number(cur) : Number(cur) / 100) : String(cur);
        i.addEventListener('keydown', (ev) => ev.stopPropagation());
        i.addEventListener('change', () => {
          if (f.kind === 'text') return set(i.value);
          const n = Number(i.value.trim());
          if (!Number.isFinite(n)) {
            i.style.borderColor = 'var(--danger)';
            return;
          }
          i.style.borderColor = '';
          if (f.kind === 'angle') set((n * Math.PI) / 180);
          else if (f.kind === 'int') set(Math.max(0, Math.round(n)));
          else if (f.kind === 'lw') set(n < 0 ? Math.round(n) : Math.round(n * 100));
          else if (f.kind === 'color') set(Math.max(0, Math.min(256, Math.round(n))));
          else set(n);
        });
        el = i;
      }
    }
    return h('label', { class: 'form-row', style: 'display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin:3px 0' }, h('span', {}, f.label), el);
  });
  return h('div', { class: 'ds-panel' }, ...rows);
}

/** 7탭 대화상자. 확인하면 변수와 주석 여부 */
function editDialog(app: App, title: string, base: DimStyle | undefined, start: Vars, annotative: boolean | undefined): Promise<{ vars: Vars; annotative: boolean | undefined } | null> {
  const st = app.active!;
  const vars: Vars = { ...start };
  let anno = annotative;
  return new Promise((resolve) => {
    let done = false;
    const canvas = h('canvas', { width: 240, height: 180, style: 'width:240px;height:180px;background:var(--canvas-model);border:1px solid var(--border-soft);border-radius:4px' }) as HTMLCanvasElement;
    const redraw = () => drawDimPreview(app, canvas, base, vars);
    const tabs = h('div', { role: 'tablist', style: 'display:flex;flex-wrap:wrap;gap:2px;margin-bottom:6px' });
    const panel = h('div', { style: 'min-height:300px;max-height:52vh;overflow:auto;padding-right:6px' });
    let active = TABS[0]![0];
    const showTab = (name: string) => {
      active = name;
      tabs.replaceChildren(
        ...TABS.map(([t]) => {
          const b = h('button', { type: 'button', role: 'tab', class: `btn ${t === active ? 'primary' : ''}`, 'aria-selected': t === active ? 'true' : 'false' }, t);
          b.addEventListener('click', () => showTab(t));
          return b;
        }),
      );
      const fields = TABS.find(([t]) => t === name)![1];
      const p = tabPanel(st, vars, fields, redraw);
      if (name === '맞춤') {
        // 치수 피쳐 축척의 "주석"(AcadAnnotative)
        const c = h('input', { type: 'checkbox', 'aria-label': '주석' }) as HTMLInputElement;
        c.checked = !!anno;
        c.addEventListener('change', () => (anno = c.checked));
        p.append(h('label', { class: 'form-row', style: 'display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin:3px 0' }, h('span', {}, '주석(축척은 주석 축척을 따름)'), c));
      }
      panel.replaceChildren(p);
    };
    showTab(active);
    const body = h('div', { style: 'display:grid;grid-template-columns:minmax(300px,1fr) 240px;gap:12px;align-items:start' }, h('div', {}, tabs, panel), h('div', {}, h('div', { style: 'color:var(--text-dim);margin-bottom:4px' }, '미리보기'), canvas));
    const back = dialog(title, body, [
      { label: '취소', run: () => ((done = true), resolve(null)) },
      { label: '확인', primary: true, run: () => ((done = true), resolve({ vars, annotative: anno })) },
    ]);
    const box = back.querySelector('.dialog') as HTMLElement | null;
    if (box) box.style.width = 'min(720px, 100%)';
    setTimeout(redraw);
    new MutationObserver((_, obs) => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    }).observe(document.body, { childList: true });
  });
}

/** 비교 대화상자 */
function compareDialog(app: App, first: string): void {
  const st = app.active!;
  const names = [...st.doc.dimStyles.values()].filter((s) => s.name).map((s) => s.name).sort((a, b) => a.localeCompare(b));
  const a = h('select', { 'aria-label': '비교', style: CSS_IN }, ...names.map((n) => h('option', { value: n }, n))) as HTMLSelectElement;
  const b = h('select', { 'aria-label': '대상', style: CSS_IN }, h('option', { value: '' }, '<없음>'), ...names.map((n) => h('option', { value: n }, n))) as HTMLSelectElement;
  a.value = names.find((n) => tableKey(n) === tableKey(first)) ?? names[0] ?? '';
  b.value = names.find((n) => tableKey(n) !== tableKey(a.value)) ?? '';
  const out = h('div', { style: 'max-height:50vh;overflow:auto;margin-top:8px' });
  let rows: VarDiff[] = [];
  const render = () => {
    const va = styleVars(st.doc.dimStyles.get(tableKey(a.value)));
    const vb = b.value ? styleVars(st.doc.dimStyles.get(tableKey(b.value))) : null;
    rows = compareVars(va, vb);
    out.replaceChildren(
      h('div', { style: 'color:var(--text-dim);margin-bottom:4px' }, vb ? (rows.length ? `다른 점 ${rows.length}개` : '두 스타일이 같습니다.') : `${a.value}의 모든 특성`),
      h(
        'table',
        { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', {}, '설명'), h('th', {}, '변수'), h('th', {}, a.value), ...(vb ? [h('th', {}, b.value)] : []))),
        h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', {}, r.label), h('td', { style: 'font-family:var(--mono)' }, r.name), h('td', {}, r.a), ...(vb ? [h('td', {}, r.b)] : [])))),
      ),
    );
  };
  a.addEventListener('change', render);
  b.addEventListener('change', render);
  render();
  const body = h('div', {}, h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, h('span', {}, '비교'), a, h('span', {}, '대상'), b), out);
  dialog('치수 스타일 비교', body, [
    {
      label: '클립보드로 복사',
      run: () => {
        const text = rows.map((r) => [r.label, r.name, r.a, r.b].join('\t')).join('\n');
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        return true;
      },
    },
    { label: '닫기', primary: true },
  ]);
}

const BAD_NAME = /[<>/\\":;?*|,=`]/;

export function registerDimStyleCommands(app: App): void {
  app.register({
    name: 'DIMSTYLE',
    aliases: ['D', 'DST', 'DDIM', 'DIMSTY'],
    title: '치수 스타일 관리자',
    run() {
      const st = app.active!;
      const doc = st.doc;
      const curName = () => doc.dimStyles.get(tableKey(String(doc.header.get('$DIMSTYLE') ?? 'Standard')))?.name ?? String(doc.header.get('$DIMSTYLE') ?? 'Standard');
      /** 고른 줄: 스타일 이름, 또는 null = <스타일 재지정> */
      let picked: string | null = curName();
      let filter: 'all' | 'used' = 'all';
      const list = h('div', { tabindex: '0', role: 'listbox', 'aria-label': '스타일', style: 'min-height:220px;max-height:46vh;overflow:auto;border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input);padding:2px' });
      const filterSel = h('select', { 'aria-label': '리스트', style: CSS_IN }, h('option', { value: 'all' }, '모든 스타일'), h('option', { value: 'used' }, '사용 중인 스타일')) as HTMLSelectElement;
      const canvas = h('canvas', { width: 240, height: 180, style: 'width:240px;height:180px;background:var(--canvas-model);border:1px solid var(--border-soft);border-radius:4px' }) as HTMLCanvasElement;
      const desc = h('div', { style: 'color:var(--text-dim);margin-top:6px;white-space:pre-wrap;max-width:240px' });
      const head = h('div', { style: 'margin-bottom:6px' });
      const pickedStyle = () => doc.dimStyles.get(tableKey(picked ?? curName()));
      const render = () => {
        const cur = curName();
        const ov = headerOverrides(doc, cur);
        const used = usedStyles(st);
        head.textContent = `현재 치수 스타일: ${cur}`;
        const styles = [...doc.dimStyles.values()].filter((s) => s.name && (filter === 'all' || used.has(tableKey(s.name)) || tableKey(s.name) === tableKey(cur))).sort((a, b) => a.name.localeCompare(b.name));
        if (picked !== null && !doc.dimStyles.has(tableKey(picked))) picked = cur;
        if (picked === null && !Object.keys(ov).length) picked = cur;
        list.replaceChildren();
        const row = (label: string, key: string | null, indent: boolean) => {
          const sel = key === null ? picked === null : picked !== null && tableKey(picked) === tableKey(key);
          const r = h('div', { role: 'option', 'aria-selected': sel ? 'true' : 'false', style: `padding:3px 6px;${indent ? 'padding-left:22px;' : ''}cursor:pointer;border-radius:3px;${sel ? 'background:var(--accent-soft);outline:1px solid var(--accent)' : ''}` }, label);
          r.addEventListener('click', () => {
            picked = key;
            render();
          });
          r.addEventListener('dblclick', () => void rename());
          r.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            picked = key;
            render();
            showMenu(ev.clientX, ev.clientY, key === null
              ? [
                  { label: '현재 스타일에 저장', run: () => saveOverrides() },
                  { label: '이름 바꾸기', run: () => void rename() },
                  { label: '삭제', run: () => clearOverrides() },
                ]
              : [
                  { label: '현재로 설정', run: () => void setCurrent() },
                  { label: '이름 바꾸기', kbd: 'F2', run: () => void rename() },
                  { label: '삭제', kbd: 'Del', run: () => void remove() },
                ]);
          });
          list.append(r);
        };
        for (const s of styles) {
          const isCur = tableKey(s.name) === tableKey(cur);
          row(`${s.name}${isCur ? ' (현재)' : ''}${used.get(tableKey(s.name)) ? `  · ${used.get(tableKey(s.name))}` : ''}`, s.name, false);
          if (isCur && Object.keys(ov).length) row('<스타일 재지정>', null, true);
        }
        const base = pickedStyle();
        const vars = picked === null ? { ...styleVars(base), ...ov } : styleVars(base);
        drawDimPreview(app, canvas, base, vars);
        if (picked === null) desc.textContent = `설명: ${cur} + ${Object.entries(ov).map(([k, v]) => `${LABELS.get(k) ?? k} = ${show(v)}`).join(', ')}`;
        else if (base) {
          const n = used.get(tableKey(base.name)) ?? 0;
          desc.textContent = `설명: ${base.name}\n문자 높이 ${show(vars.DIMTXT)}, 화살표 크기 ${show(vars.DIMASZ)}, 전체 축척 ${show(vars.DIMSCALE)}\n이 스타일을 쓰는 객체 ${n}개`;
        } else desc.textContent = '';
      };
      filterSel.addEventListener('change', () => {
        filter = filterSel.value as 'all' | 'used';
        render();
      });
      list.addEventListener('keydown', (ev) => {
        const k = (ev as KeyboardEvent).key;
        ev.stopPropagation();
        if (k === 'F2') void rename();
        else if (k === 'Delete') void (picked === null ? clearOverrides() : remove());
      });
      // ------------------------------------------------------------------ 동작
      const commitStyle = (next: DimStyle, isNew: boolean, label = 'DIMSTYLE') => {
        const key = tableKey(next.name);
        const ops: EditOp[] = [{ kind: 'dimStyle', key, before: isNew ? null : (doc.dimStyles.get(key) ?? null), after: next }];
        // 현재 스타일을 고치면 머리말도 따라간다(재지정 유지)
        if (!isNew && key === tableKey(curName())) {
          const ov = headerOverrides(doc, next.name);
          ops.push(...headerVarOps(doc, { ...styleVars(next), ...ov }));
        }
        st.session.commit({ label, ops });
        if (!isNew) {
          const rg = regenOps(st, next.name);
          if (rg.length) st.session.commit({ label, ops: rg, rebuildNow: true });
        }
      };
      const setCurrent = async () => {
        const s = picked === null ? null : doc.dimStyles.get(tableKey(picked));
        if (!s) return;
        const cur = curName();
        const ov = headerOverrides(doc, cur);
        if (tableKey(s.name) !== tableKey(cur) && Object.keys(ov).length) {
          const a = await ask('치수 스타일 관리자', '현재 스타일의 재지정을 버리시겠습니까?', [
            { label: '확인', value: 'ok', primary: true },
            { label: '취소', value: 'cancel' },
          ]);
          if (a !== 'ok') return;
        }
        const ops: EditOp[] = [{ kind: 'header', name: '$DIMSTYLE', before: doc.header.get('$DIMSTYLE'), after: s.name }, ...headerVarOps(doc, styleVars(s))];
        st.session.commit({ label: 'DIMSTYLE', ops });
        picked = s.name;
        render();
      };
      const create = async () => {
        const base = pickedStyle();
        if (!base) return;
        const v = await form(
          '새 치수 스타일 작성',
          [
            { key: 'name', label: '새 스타일 이름', type: 'text', value: `${base.name} 사본` },
            { key: 'start', label: '시작', type: 'select', value: base.name, options: [...doc.dimStyles.values()].filter((s) => s.name).map((s) => ({ value: s.name, label: s.name })) },
            { key: 'anno', label: '주석', type: 'check', value: annotativeFlag(base.xdata) ?? false },
          ],
          {
            ok: '계속',
            validate: (x) => {
              const n = String(x.name).trim();
              if (!n || BAD_NAME.test(n)) return '스타일 이름이 올바르지 않습니다.';
              return doc.dimStyles.has(tableKey(n)) ? '같은 이름의 스타일이 있습니다.' : null;
            },
          },
        );
        if (!v) return;
        const src = doc.dimStyles.get(tableKey(String(v.start))) ?? base;
        const name = String(v.name).trim();
        const r = await editDialog(app, `새 치수 스타일: ${name}`, src, styleVars(src), !!v.anno);
        if (!r) return;
        let s: DimStyle = { ...structuredClone(src), name, handle: st.session.newHandle(), flags: 0, vars: r.vars };
        delete (s as { xdata?: unknown }).xdata;
        if (r.annotative) s = { ...s, xdata: withAnnotativeFlag(s.xdata, true) };
        commitStyle(s, true);
        picked = name;
        render();
      };
      const modify = async () => {
        if (picked === null) return override();
        const s = pickedStyle();
        if (!s) return;
        const r = await editDialog(app, `치수 스타일 수정: ${s.name}`, s, styleVars(s), annotativeFlag(s.xdata));
        if (!r) return;
        let next: DimStyle = { ...structuredClone(s), vars: { ...s.vars, ...diffFrom(styleVars(s), r.vars) } };
        if (r.annotative !== undefined && (r.annotative || annotativeFlag(next.xdata) !== undefined)) next = { ...next, xdata: withAnnotativeFlag(next.xdata, r.annotative) };
        commitStyle(next, false);
        render();
      };
      const override = async () => {
        const cur = curName();
        const s = doc.dimStyles.get(tableKey(cur));
        if (!s) return;
        const ov = headerOverrides(doc, cur);
        const r = await editDialog(app, `현재 스타일 재지정: ${cur}`, s, { ...styleVars(s), ...ov }, annotativeFlag(s.xdata));
        if (!r) return;
        const ops = headerVarOps(doc, r.vars, OVERRIDE_VARS.filter((n) => !sameVal(r.vars[n], { ...styleVars(s), ...ov }[n]) || ov[n] !== undefined));
        if (ops.length) st.session.commit({ label: 'DIMSTYLE', ops });
        picked = Object.keys(headerOverrides(doc, cur)).length ? null : cur;
        render();
      };
      const saveOverrides = () => {
        const cur = curName();
        const s = doc.dimStyles.get(tableKey(cur));
        const ov = headerOverrides(doc, cur);
        if (!s || !Object.keys(ov).length) return;
        commitStyle({ ...structuredClone(s), vars: { ...s.vars, ...ov } }, false);
        picked = cur;
        render();
      };
      const clearOverrides = () => {
        const cur = curName();
        const s = doc.dimStyles.get(tableKey(cur));
        if (!s) return;
        const ops = headerVarOps(doc, styleVars(s));
        if (ops.length) st.session.commit({ label: 'DIMSTYLE', ops });
        picked = cur;
        render();
      };
      const rename = async () => {
        if (picked === null) {
          // <스타일 재지정> 이름 바꾸기: 현재 스타일 + 재지정으로 새 스타일을 만들어 현재로
          const cur = curName();
          const s = doc.dimStyles.get(tableKey(cur));
          if (!s) return;
          const v = await form('새 스타일 이름', [{ key: 'name', label: '새 스타일 이름', type: 'text', value: `${cur} 재지정` }], {
            validate: (x) => {
              const n = String(x.name).trim();
              if (!n || BAD_NAME.test(n)) return '스타일 이름이 올바르지 않습니다.';
              return doc.dimStyles.has(tableKey(n)) ? '같은 이름의 스타일이 있습니다.' : null;
            },
          });
          if (!v) return;
          const name = String(v.name).trim();
          const ns: DimStyle = { ...structuredClone(s), name, handle: st.session.newHandle(), flags: 0, vars: { ...s.vars, ...headerOverrides(doc, cur) } };
          st.session.commit({ label: 'DIMSTYLE', ops: [{ kind: 'dimStyle', key: tableKey(name), before: null, after: ns }, { kind: 'header', name: '$DIMSTYLE', before: doc.header.get('$DIMSTYLE'), after: name }] });
          picked = name;
          render();
          return;
        }
        const s = pickedStyle();
        if (!s) return;
        if (tableKey(s.name) === 'STANDARD') {
          app.cmd.print('Standard 치수 스타일의 이름은 바꿀 수 없습니다.', 'err');
          return;
        }
        if (s.name.includes('|')) {
          app.cmd.print('외부 참조의 치수 스타일은 이름을 바꿀 수 없습니다.', 'err');
          return;
        }
        const v = await form('이름 바꾸기', [{ key: 'name', label: '새 이름', type: 'text', value: s.name }], {
          validate: (x) => {
            const n = String(x.name).trim();
            if (!n || BAD_NAME.test(n)) return '스타일 이름이 올바르지 않습니다.';
            if (tableKey(n) !== tableKey(s.name) && doc.dimStyles.has(tableKey(n))) return '같은 이름의 스타일이 있습니다.';
            return null;
          },
        });
        if (!v) return;
        const to = String(v.name).trim();
        if (to === s.name) return;
        st.session.commit({ label: 'RENAME', ops: dimStyleRenameOps(st, s.name, to) });
        picked = to;
        render();
      };
      const remove = async () => {
        const s = pickedStyle();
        if (!s || picked === null) return;
        const key = tableKey(s.name);
        if (key === 'STANDARD' || key === tableKey(curName()) || usedStyles(st).has(key)) {
          app.cmd.print(`치수 스타일 "${s.name}"은(는) 현재 스타일이거나 사용 중이라 삭제할 수 없습니다.`, 'err');
          return;
        }
        const a = await ask('치수 스타일 - 삭제', `치수 스타일 "${s.name}"을(를) 삭제하시겠습니까?`, [
          { label: '예', value: 'yes', primary: true },
          { label: '아니오', value: 'no' },
        ]);
        if (a !== 'yes') return;
        st.session.commit({ label: 'DIMSTYLE', ops: [{ kind: 'dimStyle', key, before: s, after: null }] });
        picked = curName();
        render();
      };
      const btn = (label: string, run: () => void) => {
        const b = h('button', { class: 'btn', type: 'button', style: 'width:100%;margin-bottom:4px' }, label);
        b.addEventListener('click', run);
        return b;
      };
      const body = h(
        'div',
        {},
        head,
        h(
          'div',
          { style: 'display:grid;grid-template-columns:minmax(160px,1fr) 240px 120px;gap:10px;align-items:start' },
          h('div', {}, h('div', { style: 'color:var(--text-dim);margin-bottom:2px' }, '스타일'), list, h('div', { style: 'margin-top:6px;display:flex;gap:6px;align-items:center' }, h('span', { style: 'color:var(--text-dim)' }, '리스트'), filterSel)),
          h('div', {}, h('div', { style: 'color:var(--text-dim);margin-bottom:2px' }, '미리보기'), canvas, desc),
          h(
            'div',
            {},
            btn('현재로 설정', () => void setCurrent()),
            btn('새로 만들기...', () => void create()),
            btn('수정...', () => void modify()),
            btn('재지정...', () => void override()),
            btn('비교...', () => compareDialog(app, picked ?? curName())),
          ),
        ),
      );
      const back = dialog('치수 스타일 관리자', body, [{ label: '닫기', primary: true }]);
      const box = back.querySelector('.dialog') as HTMLElement | null;
      if (box) box.style.width = 'min(720px, 100%)';
      render();
    },
  });
}

/** b에서 a와 다른 값만 */
function diffFrom(a: Vars, b: Vars): Vars {
  const out: Vars = {};
  for (const [k, v] of Object.entries(b)) if (!sameVal(a[k], v)) out[k] = v;
  return out;
}
