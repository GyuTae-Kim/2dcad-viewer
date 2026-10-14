/**
 * 치수 스타일 관리자: DIMSTYLE(D, DST, DDIM, DIMSTY)
 * 스타일 목록에서 현재로 설정·새로 만들기(기준 스타일 복사)·수정·삭제. 스타일을 고치면 그 스타일을 쓰는 치수를 다시 만든다.
 * 탭 이름과 항목은 AutoCAD 2026 한국어판의 "치수 스타일 수정" 대화상자를 따른다.
 */
import { DIM_VAR_DEFAULTS } from '../core/dimvars';
import type { DimStyle, DimensionEntity, Entity } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import type { App } from './app';
import { dimensionBlockOps } from './dimcmds';
import type { DocState } from './docstate';
import { type FormField, dialog, form, h } from './ui/dom';

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

const val = (s: DimStyle, v: string): number | string => s.vars[v] ?? DIM_VAR_DEFAULTS[v] ?? 0;

/** 탭 하나의 입력 칸 */
function fieldsOf(st: DocState, s: DimStyle, tab: VarField[]): FormField[] {
  const styles = [...st.doc.textStyles.values()].filter((t) => t.name && !(t.flags & 1)).map((t) => ({ value: t.name, label: t.name }));
  return tab.map((f): FormField => {
    const cur = val(s, f.v);
    switch (f.kind) {
      case 'check':
        return { key: f.v, label: f.label, type: 'check', value: Number(cur) !== 0 };
      case 'select':
        return { key: f.v, label: f.label, type: 'select', value: String(cur), options: f.options! };
      case 'arrow': {
        const v = String(cur || (f.v !== 'DIMLDRBLK' ? val(s, 'DIMBLK') : '') || '').toUpperCase();
        const opts = ARROWS.some((a) => a.value === v) ? ARROWS : [...ARROWS, { value: v, label: `사용자 블록 ${v}` }];
        return { key: f.v, label: f.label, type: 'select', value: v, options: opts };
      }
      case 'style':
        return { key: f.v, label: f.label, type: 'select', value: String(cur || 'Standard'), options: styles.length ? styles : [{ value: 'Standard', label: 'Standard' }] };
      case 'text':
        return { key: f.v, label: f.label, type: 'text', value: String(cur) };
      case 'angle':
        return { key: f.v, label: f.label, type: 'number', value: +((Number(cur) * 180) / Math.PI).toFixed(6) };
      case 'lw':
        return { key: f.v, label: f.label, type: 'number', value: Number(cur) < 0 ? Number(cur) : Number(cur) / 100 };
      default:
        return { key: f.v, label: f.label, type: 'number', value: Number(cur) };
    }
  });
}

/** 입력 값 → 변수 */
function applyFields(s: DimStyle, tab: VarField[], v: Record<string, string | number | boolean>): DimStyle {
  const vars = { ...s.vars };
  for (const f of tab) {
    const x = v[f.v];
    if (x === undefined) continue;
    switch (f.kind) {
      case 'check':
        vars[f.v] = x ? 1 : 0;
        break;
      case 'select':
        vars[f.v] = Number(x);
        break;
      case 'arrow':
      case 'style':
      case 'text':
        vars[f.v] = String(x);
        break;
      case 'angle':
        vars[f.v] = (Number(x) * Math.PI) / 180;
        break;
      case 'int':
        vars[f.v] = Math.max(0, Math.round(Number(x)));
        break;
      case 'lw':
        vars[f.v] = Number(x) < 0 ? Math.round(Number(x)) : Math.round(Number(x) * 100);
        break;
      default:
        vars[f.v] = Number(x);
    }
  }
  // 화살촉을 따로 정하면 DIMSAH를 켠다(같으면 DIMBLK 하나로)
  if ('DIMBLK1' in vars || 'DIMBLK2' in vars) {
    if (vars.DIMBLK1 === vars.DIMBLK2) {
      vars.DIMBLK = vars.DIMBLK1 ?? '';
      vars.DIMSAH = 0;
    } else vars.DIMSAH = 1;
  }
  return { ...s, vars };
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

function usedStyles(st: DocState): Set<string> {
  const used = new Set<string>();
  for (const b of st.doc.blocks.values()) for (const e of b.entities) if (e.type === 'DIMENSION') used.add(tableKey(e.dimStyle || 'Standard'));
  return used;
}

export function registerDimStyleCommands(app: App): void {
  app.register({
    name: 'DIMSTYLE',
    aliases: ['D', 'DST', 'DDIM', 'DIMSTY'],
    title: '치수 스타일 관리자',
    run() {
      const st = app.active!;
      const curName = () => String(st.doc.header.get('$DIMSTYLE') ?? 'Standard') || 'Standard';
      let picked = curName();
      const body = h('div', {});
      const render = () => {
        body.replaceChildren();
        const used = usedStyles(st);
        const list = [...st.doc.dimStyles.values()].filter((s) => s.name).sort((a, b) => a.name.localeCompare(b.name));
        body.append(
          h('div', { style: 'margin-bottom:6px' }, `현재 치수 스타일: ${curName()}`),
          h(
            'table',
            { class: 'grid' },
            h('thead', {}, h('tr', {}, h('th', {}, '스타일'), h('th', {}, '치수 수'), h('th', {}, '문자 높이'), h('th', {}, '화살표'))),
            h(
              'tbody',
              {},
              ...list.map((s) => {
                const n = [...st.doc.blocks.values()].reduce((a, b) => a + b.entities.filter((e) => e.type === 'DIMENSION' && tableKey(e.dimStyle || 'Standard') === tableKey(s.name)).length, 0);
                const tr = h(
                  'tr',
                  { style: tableKey(picked) === tableKey(s.name) ? 'background:var(--sel, rgba(61,141,255,0.25))' : 'cursor:pointer' },
                  h('td', {}, `${s.name}${tableKey(s.name) === tableKey(curName()) ? ' (현재)' : ''}`),
                  h('td', {}, used.has(tableKey(s.name)) ? String(n) : '0'),
                  h('td', {}, String(+Number(val(s, 'DIMTXT')).toFixed(4))),
                  h('td', {}, String(+Number(val(s, 'DIMASZ')).toFixed(4))),
                );
                tr.addEventListener('click', () => {
                  picked = s.name;
                  render();
                });
                return tr;
              }),
            ),
          ),
        );
      };
      const edit = async (s: DimStyle, isNew: boolean): Promise<void> => {
        let next = s;
        for (;;) {
          const pick = await form(
            `치수 스타일 ${isNew ? '새로 만들기' : '수정'}: ${s.name}`,
            [{ key: 'tab', label: '탭', type: 'select', value: '선', options: [...TABS.map(([t]) => ({ value: t, label: t })), { value: '__done', label: '— 확인(저장) —' }] }],
            { ok: '열기' },
          );
          if (!pick) return;
          if (pick.tab === '__done') break;
          const tab = TABS.find(([t]) => t === pick.tab)![1];
          const v = await form(`${s.name} - ${pick.tab}`, fieldsOf(st, next, tab), { ok: '적용' });
          if (v) next = applyFields(next, tab, v);
        }
        const key = tableKey(next.name);
        st.session.commit({ label: 'DIMSTYLE', ops: [{ kind: 'dimStyle', key, before: isNew ? null : (st.doc.dimStyles.get(key) ?? null), after: next }] });
        if (!isNew) {
          const ops = regenOps(st, next.name);
          if (ops.length) st.session.commit({ label: 'DIMSTYLE', ops, rebuildNow: true });
        }
        picked = next.name;
        render();
      };
      render();
      dialog('치수 스타일 관리자', body, [
        {
          label: '새로 만들기…',
          run: () => {
            const base = st.doc.dimStyles.get(tableKey(picked));
            if (!base) return false;
            void form('새 치수 스타일 작성', [{ key: 'name', label: '새 스타일 이름', type: 'text', value: `${base.name}의 복사` }], {
              ok: '계속',
              validate: (v) => {
                const n = String(v.name).trim();
                if (!n || /[<>/\\":;?*|,=`]/.test(n)) return '스타일 이름이 올바르지 않습니다.';
                return st.doc.dimStyles.has(tableKey(n)) ? '같은 이름의 스타일이 있습니다.' : null;
              },
            }).then((v) => {
              if (!v) return;
              const s: DimStyle = { ...structuredClone(base), name: String(v.name).trim(), handle: st.session.newHandle(), flags: 0 };
              delete (s as { xdata?: unknown }).xdata;
              void edit(s, true);
            });
            return false;
          },
        },
        {
          label: '수정…',
          run: () => {
            const s = st.doc.dimStyles.get(tableKey(picked));
            if (s) void edit(structuredClone(s), false);
            return false;
          },
        },
        {
          label: '삭제',
          run: () => {
            const key = tableKey(picked);
            const s = st.doc.dimStyles.get(key);
            if (!s) return false;
            if (key === 'STANDARD' || key === tableKey(curName()) || usedStyles(st).has(key)) {
              app.cmd.print(`치수 스타일 "${s.name}"은(는) 현재 스타일이거나 사용 중이라 삭제할 수 없습니다.`, 'err');
              return false;
            }
            st.session.commit({ label: 'DIMSTYLE', ops: [{ kind: 'dimStyle', key, before: s, after: null }] });
            picked = curName();
            render();
            return false;
          },
        },
        {
          label: '현재로 설정',
          primary: true,
          run: () => {
            const s = st.doc.dimStyles.get(tableKey(picked));
            if (s) st.session.commit({ label: 'DIMSTYLE', ops: [{ kind: 'header', name: '$DIMSTYLE', before: st.doc.header.get('$DIMSTYLE'), after: s.name }] });
            render();
            return false;
          },
        },
        { label: '닫기' },
      ]);
    },
  });
}
