/**
 * 명령행 도면층 상태(-LAYERSTATE, -LAYER의 상태(A) 옵션):
 * `옵션입력 [?/저장(S)/복원(R)/편집(E)/이름(N)/삭제(D)/불러오기(I)/내보내기(EX)]:`을 Enter까지 되풀이한다.
 * 옵션 프롬프트와 `… 도면층 상태 이름 또는 [?] 입력:` 꼴은 AutoCAD 2026 한국어판에서 확인된 문구다.
 * 저장의 복원 특성 고르기와 편집의 하위 프롬프트는 한국어판 원문을 확인하지 못해 같은 꼴로 지었다.
 */
import type { CadColor } from '../core/model';
import { tableKey } from '../core/model';
import {
  layerColorText,
  lineweightText,
  matchNameList,
  opacityFromPercent,
  parseLayerColor,
  parseLineweight,
  parseTransparency,
  parseTrueColor,
  unquote,
} from '../edit/layercmd';
import {
  LSF_FROZEN,
  LSF_LOCKED,
  LSF_OFF,
  LSF_PLOT,
  LSM_ALL,
  LSM_COLOR,
  LSM_CURVP,
  LSM_FROZEN,
  LSM_LINETYPE,
  LSM_LINEWEIGHT,
  LSM_LOCKED,
  LSM_NEWVP,
  LSM_ON,
  LSM_PLOT,
  LSM_PLOTSTYLE,
  LSM_TRANSPARENCY,
  type LayerState,
  layerStateNameProblem,
  maskText,
} from '../edit/layerstate/record';
import { layerStateEntry } from '../edit/layerstate/store';
import type { App, CommandContext, Keyword } from './app';
import {
  captureNow,
  deleteLayerState,
  exportLayerState,
  importLayerStates,
  pickImportSource,
  putLayerState,
  renameLayerState,
  restoreLayerState,
  stateByName,
  visibleStates,
} from './layerstate-core';
import { askYesNo, padWide } from './util2-ui';

export const STATE_OPTIONS: Keyword[] = [
  { key: '?', label: '?' },
  { key: 'S', label: '저장' },
  { key: 'R', label: '복원' },
  { key: 'E', label: '편집' },
  { key: 'N', label: '이름' },
  { key: 'D', label: '삭제' },
  { key: 'I', label: '불러오기' },
  { key: 'EX', label: '내보내기' },
];

/** 영어판 옵션 이름(스크립트의 `_SAVE` 꼴)과 이 앱의 다른 이름 */
const GLOBAL: Record<string, string> = { SAVE: 'S', RESTORE: 'R', EDIT: 'E', NAME: 'N', DELETE: 'D', IMPORT: 'I', EXPORT: 'EX', 가져오기: 'I' };

export const STATE_PROMPT = '옵션입력 [?/저장(S)/복원(R)/편집(E)/이름(N)/삭제(D)/불러오기(I)/내보내기(EX)]:';

export function resolveStateOption(text: string): string | null {
  const t = text.trim();
  const up = t.toUpperCase().replace(/^_/, '');
  for (const k of STATE_OPTIONS) if (k.key === up || k.label === t) return k.key;
  if (GLOBAL[up]) return GLOBAL[up]!;
  if (GLOBAL[t]) return GLOBAL[t]!;
  const hits = Object.keys(GLOBAL).filter((g) => /^[A-Z]+$/.test(g) && up.length >= 2 && g.startsWith(up));
  return hits.length === 1 ? GLOBAL[hits[0]!]! : null;
}

/** 글 입력(Enter면 null) */
async function askWord(ctx: CommandContext, prompt: string, keywords?: Keyword[]): Promise<string | null> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { allowText: true, keywords });
    if ('text' in r) return r.text.trim();
    if ('keyword' in r) return r.keyword;
    if ('enter' in r) return null;
  }
}

/** 이름이 든 글 입력(공백 허용) */
async function askName(ctx: CommandContext, prompt: string): Promise<string | null> {
  const app = ctx.app;
  const prev = app.cmd.acceptSpaces;
  app.cmd.acceptSpaces = true;
  try {
    const r = await ctx.getPoint(prompt, { allowText: true });
    if ('text' in r) return unquote(r.text.trim());
    return null;
  } finally {
    app.cmd.acceptSpaces = prev;
  }
}

function listStates(app: App, ctx: CommandContext, pattern = '*'): void {
  const st = app.active!;
  const all = visibleStates(st.doc, false);
  const names = matchNameList(
    all.map((s) => s.key),
    pattern || '*',
  ).names;
  if (!names.length) {
    ctx.print('저장된 도면층 상태가 없습니다.');
    return;
  }
  const rows = all.filter((s) => names.includes(s.key)).map((s) => [`"${s.key}"`, s.state.paperSpace ? '배치' : '모형', s.state.description]);
  const head = ['도면층 상태 이름', '공간', '설명'];
  const widths = head.map((h, i) => Math.min(40, Math.max(h.length * 2, ...rows.map((r) => r[i]!.length + 2))));
  ctx.print(head.map((h, i) => padWide(h, widths[i]!)).join(' '));
  for (const r of rows) ctx.print(r.map((v, i) => padWide(v, widths[i]!)).join(' '));
}

/** `… 도면층 상태 이름 또는 [?] 입력:` — ?면 나열하고 다시 묻는다. 없는 이름이면 알리고 null */
async function askStateName(app: App, ctx: CommandContext, what: string): Promise<string | null> {
  for (;;) {
    const t = await askName(ctx, `${what} 도면층 상태 이름 또는 [?] 입력:`);
    if (t === null || t === '') return null;
    if (t === '?') {
      listStates(app, ctx);
      continue;
    }
    const s = stateByName(app, t);
    if (!s) {
      ctx.print(`도면층 상태 "${t}"을(를) 찾을 수 없습니다.`, 'err');
      return null;
    }
    return s.key;
  }
}

/** 복원 특성(저장의 켜고 끄기 키) */
const PROP_KEYS: { key: string; label: string; bit: number }[] = [
  { key: 'O', label: '켜기', bit: LSM_ON },
  { key: 'F', label: '동결', bit: LSM_FROZEN },
  { key: 'K', label: '잠금', bit: LSM_LOCKED },
  { key: 'P', label: '플롯', bit: LSM_PLOT },
  { key: 'N', label: '새 VP 동결', bit: LSM_NEWVP },
  { key: 'V', label: '현재 VP 가시성', bit: LSM_CURVP },
  { key: 'C', label: '색상', bit: LSM_COLOR },
  { key: 'L', label: '선종류', bit: LSM_LINETYPE },
  { key: 'W', label: '선가중치', bit: LSM_LINEWEIGHT },
  { key: 'T', label: '투명도', bit: LSM_TRANSPARENCY },
  { key: 'S', label: '플롯 스타일', bit: LSM_PLOTSTYLE },
];

async function chooseMask(ctx: CommandContext, start: number): Promise<number | null> {
  let mask = start;
  const kw: Keyword[] = PROP_KEYS.map((p) => ({ key: p.key, label: p.label }));
  const prompt = `켜거나 끌 복원 특성 입력 [${PROP_KEYS.map((p) => `${p.label}(${p.key})`).join('/')}] <종료>:`;
  for (;;) {
    ctx.print(`복원할 특성: ${maskText(mask)}`);
    const r = await ctx.getPoint(prompt, { keywords: kw, allowText: true });
    if ('enter' in r) return mask;
    const k = 'keyword' in r ? r.keyword : 'text' in r ? PROP_KEYS.find((p) => p.key === r.text.trim().toUpperCase() || p.label === r.text.trim())?.key : undefined;
    const p = PROP_KEYS.find((x) => x.key === k);
    if (!p) {
      ctx.print('옵션 키워드가 잘못되었습니다.', 'err');
      continue;
    }
    mask ^= p.bit;
  }
}

/** 편집(E): 상태 안 도면층의 저장 값 바꾸기 */
async function editState(app: App, ctx: CommandContext, name: string): Promise<void> {
  const st = app.active!;
  const s0 = stateByName(app, name);
  if (!s0) return;
  const s: LayerState = structuredClone(s0.state);
  let dirty = false;
  const kw: Keyword[] = [
    { key: 'ON', label: '켜기' },
    { key: 'OFF', label: '끄기' },
    { key: 'C', label: '색상' },
    { key: 'L', label: '선종류' },
    { key: 'LW', label: '선가중치' },
    { key: 'TR', label: '투명도' },
    { key: 'P', label: '플롯' },
    { key: 'F', label: '동결' },
    { key: 'T', label: '동결해제' },
    { key: 'LO', label: '잠금' },
    { key: 'U', label: '잠금해제' },
    { key: 'A', label: '추가' },
    { key: 'R', label: '제거' },
  ];
  const prompt = `옵션 입력 [${kw.map((k) => `${k.label}(${k.key})`).join('/')}] <종료>:`;
  /** 상태 안 도면층 이름 리스트 */
  const inState = async (what: string) => {
    const t = await askWord(ctx, `${what} 도면층의 이름 리스트 입력:`);
    if (!t) return [];
    const m = matchNameList(
      s.layers.filter((l) => l.name).map((l) => l.name),
      t,
    );
    if (m.unmatched.length) ctx.print(`상태에서 일치하는 도면층 이름을 찾지 못함: ${m.unmatched.join(', ')}`);
    const keys = new Set(m.names.map(tableKey));
    return s.layers.filter((l) => keys.has(tableKey(l.name)));
  };
  for (;;) {
    const r = await ctx.getPoint(prompt, { keywords: kw, allowText: true });
    if ('enter' in r) break;
    const k = 'keyword' in r ? r.keyword : 'text' in r ? kw.find((x) => x.key === r.text.trim().toUpperCase() || x.label === r.text.trim())?.key : undefined;
    if (!k) {
      ctx.print('옵션 키워드가 잘못되었습니다.', 'err');
      continue;
    }
    switch (k) {
      case 'ON':
      case 'OFF':
      case 'F':
      case 'T':
      case 'LO':
      case 'U': {
        const label = kw.find((x) => x.key === k)!.label;
        const ls = await inState(`${label}할`);
        const bit = k === 'ON' || k === 'OFF' ? LSF_OFF : k === 'F' || k === 'T' ? LSF_FROZEN : LSF_LOCKED;
        const on = k === 'OFF' || k === 'F' || k === 'LO';
        for (const l of ls) l.flags = on ? l.flags | bit : l.flags & ~bit;
        dirty ||= ls.length > 0;
        break;
      }
      case 'P': {
        const p = await ctx.getPoint('플롯 기본 설정 입력 [플롯(P)/플롯 안 함(N)] <플롯>:', {
          keywords: [
            { key: 'P', label: '플롯' },
            { key: 'N', label: '플롯 안 함' },
          ],
        });
        if (!('keyword' in p) && !('enter' in p)) break;
        const plot = !('keyword' in p) || p.keyword === 'P';
        const ls = await inState('이 플롯 기본 설정에 대한');
        for (const l of ls) l.flags = plot ? l.flags | LSF_PLOT : l.flags & ~LSF_PLOT;
        dirty ||= ls.length > 0;
        break;
      }
      case 'C': {
        let color: CadColor | null = null;
        while (!color) {
          const t = await askWord(ctx, '색상 이름 또는 번호(1-255) 입력 또는 [트루컬러(T)]:');
          if (t === null) break;
          if (t.toUpperCase() === 'T') {
            const tc = await askWord(ctx, '트루컬러 입력(빨간색,초록색,파란색):');
            if (tc === null) break;
            color = parseTrueColor(tc);
            if (!color) ctx.print('0에서 255 사이의 세 값을 쉼표로 입력하십시오.', 'err');
            continue;
          }
          const c = parseLayerColor(t);
          if (!c) ctx.print('1에서 255 사이의 색상 번호나 색상 이름을 입력하십시오.', 'err');
          else color = c.color;
        }
        if (!color) break;
        const ls = await inState(`색상 ${layerColorText(color)}에 대한`);
        for (const l of ls) l.color = { ...color };
        dirty ||= ls.length > 0;
        break;
      }
      case 'L': {
        const t = await askWord(ctx, '로드된 선종류 이름 입력 <Continuous>:');
        const n = t === null ? 'Continuous' : unquote(t);
        const lt = st.doc.linetypes.get(tableKey(n));
        if (!lt && tableKey(n) !== 'CONTINUOUS') {
          ctx.print(`선종류 ${n}을(를) 찾을 수 없습니다. LINETYPE 명령으로 로드하십시오.`, 'err');
          break;
        }
        const name2 = lt?.name ?? 'Continuous';
        const ls = await inState(`선종류 "${name2}"에 대한`);
        for (const l of ls) l.linetype = name2;
        dirty ||= ls.length > 0;
        break;
      }
      case 'LW': {
        const t = await askWord(ctx, '선가중치 입력 (0.0mm - 2.11mm):');
        const lw = t === null ? null : parseLineweight(t);
        if (lw === null) {
          if (t !== null) ctx.print('0.0mm에서 2.11mm 사이의 선가중치를 입력하십시오.', 'err');
          break;
        }
        const ls = await inState(`선가중치 ${lineweightText(lw)}에 대한`);
        for (const l of ls) l.lineweight = lw;
        dirty ||= ls.length > 0;
        break;
      }
      case 'TR': {
        const t = await askWord(ctx, '투명도 값 입력 (0-90):');
        const pct = t === null ? null : parseTransparency(t);
        if (pct === null) {
          if (t !== null) ctx.print('0에서 90 사이의 값을 입력하십시오.', 'err');
          break;
        }
        const ls = await inState(`투명도 ${pct}%에 대한`);
        for (const l of ls) l.transparency = opacityFromPercent(pct);
        dirty ||= ls.length > 0;
        break;
      }
      case 'A': {
        const t = await askWord(ctx, '상태에 추가할 도면층의 이름 리스트 입력:');
        if (!t) break;
        const have = new Set(s.layers.map((l) => tableKey(l.name)));
        const m = matchNameList(
          [...st.doc.layers.values()].map((l) => l.name),
          t,
        );
        if (m.unmatched.length) ctx.print(`일치하는 도면층 이름을 찾지 못함: ${m.unmatched.join(', ')}`);
        let n = 0;
        for (const nm of m.names) {
          if (have.has(tableKey(nm))) continue;
          s.layers.push(layerStateEntry(st.doc, st.doc.layers.get(tableKey(nm))!));
          n++;
        }
        dirty ||= n > 0;
        ctx.print(`도면층 ${n}개를 상태에 추가했습니다.`);
        break;
      }
      case 'R': {
        const ls = await inState('상태에서 제거할');
        const drop = new Set(ls);
        s.layers = s.layers.filter((l) => !drop.has(l));
        dirty ||= ls.length > 0;
        if (ls.length) ctx.print(`도면층 ${ls.length}개를 상태에서 제거했습니다.`);
        break;
      }
    }
  }
  if (dirty) putLayerState(app, s, ctx.group, '-LAYERSTATE');
}

/** 상태 옵션 되풀이(-LAYERSTATE, -LAYER의 상태(A)) */
export async function runLayerStateOptions(app: App, ctx: CommandContext): Promise<void> {
  for (;;) {
    const r = await ctx.getPoint(STATE_PROMPT, { keywords: STATE_OPTIONS, allowText: true });
    if ('enter' in r) return;
    if ('point' in r) continue;
    const key = 'keyword' in r ? r.keyword : resolveStateOption(r.text);
    if (!key) {
      ctx.print('옵션 키워드가 잘못되었습니다.', 'err');
      continue;
    }
    const st = app.active!;
    switch (key) {
      case '?': {
        const t = await askName(ctx, '나열할 도면층 상태 이름 입력 <*>:');
        listStates(app, ctx, t || '*');
        break;
      }
      case 'S': {
        const name = await askName(ctx, '저장할 새 도면층 상태 이름 입력:');
        if (!name) break;
        const bad = layerStateNameProblem(name);
        if (bad) {
          ctx.print(bad, 'err');
          break;
        }
        const old = stateByName(app, name);
        if (old && !(await askYesNo(ctx, `도면층 상태 "${old.key}"이(가) 이미 있습니다. 덮어쓰시겠습니까?`, false))) break;
        const mask = await chooseMask(ctx, old ? old.state.mask & LSM_ALL : LSM_ALL);
        if (mask === null) break;
        putLayerState(app, captureNow(st, name, old?.state.description ?? '', mask), ctx.group, '-LAYERSTATE');
        break;
      }
      case 'R': {
        const n = await askStateName(app, ctx, '복원할');
        if (!n) break;
        restoreLayerState(app, ctx.print, stateByName(app, n)!.state, { group: ctx.group });
        break;
      }
      case 'E': {
        const n = await askStateName(app, ctx, '편집할');
        if (n) await editState(app, ctx, n);
        break;
      }
      case 'N': {
        const n = await askStateName(app, ctx, '이름을 바꿀');
        if (!n) break;
        const nn = await askName(ctx, '새 도면층 상태 이름 입력:');
        if (!nn) break;
        const err = renameLayerState(app, n, nn, ctx.group);
        if (err) ctx.print(err, 'err');
        break;
      }
      case 'D': {
        const n = await askStateName(app, ctx, '삭제할');
        if (n) deleteLayerState(app, n, ctx.group);
        break;
      }
      case 'I': {
        ctx.print('가져올 도면층 상태 파일(.las) 또는 도면(.dwg·.dxf·.dws·.dwt)을 고르십시오.');
        const src = await pickImportSource(app, ctx.print);
        if (!src) break;
        if (!src.states.length) {
          ctx.print(`${src.file}에 가져올 도면층 상태가 없습니다.`);
          break;
        }
        // 같은 이름은 하나씩 묻는다
        const yes = new Set<string>();
        for (const s of src.states) {
          const old = stateByName(app, s.name);
          if (old && (await askYesNo(ctx, `도면층 상태 "${old.key}"이(가) 이미 있습니다. 덮어쓰시겠습니까?`, false))) yes.add(s.name.toUpperCase());
        }
        const got = importLayerStates(app, ctx.print, src, src.states, (n) => yes.has(n.toUpperCase()), ctx.group);
        ctx.print(got.length ? `도면층 상태 ${got.length}개를 가져왔습니다: ${got.join(', ')}` : '가져온 도면층 상태가 없습니다.');
        break;
      }
      case 'EX': {
        const n = await askStateName(app, ctx, '내보낼');
        if (n) exportLayerState(app, n);
        break;
      }
    }
  }
}
