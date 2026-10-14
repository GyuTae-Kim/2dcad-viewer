/**
 * 도면 비교 시스템 변수(COMPARECOLOR1 …): 이 브라우저의 localStorage에 둔다(AutoCAD는 레지스트리와 도면).
 * 변수 이름이 곧 명령이다(투명 명령, 도면이 없어도 된다): `COMPARETEXT에 대한 새 값 입력 <1>:`.
 */
import type { App, CommandContext } from './app';
import { COMPARE_VARS, type CompareSettings, type CompareVar, compareVar, normalizeStored, parseInput, settingsFrom } from '../edit/compare/settings';

const PREFIX = 'opencad.compare.';
/** localStorage를 못 쓸 때 이번 세션만 */
const memory = new Map<string, string>();
const listeners = new Set<(names: string[]) => void>();

function readRaw(name: string): string | null {
  try {
    const v = localStorage.getItem(PREFIX + name);
    if (v !== null) return v;
  } catch {
    /* 저장소를 못 쓴다 */
  }
  return memory.get(name) ?? null;
}

/** 변수 값(범위를 벗어난 저장값은 가장 가까운 허용 값) */
export function getCompareVar(name: string): string | number {
  const v = compareVar(name);
  if (!v) throw new Error(`알 수 없는 변수 ${name}`);
  return normalizeStored(v, readRaw(v.name));
}

/** 값을 저장하고 알린다(검사는 부르는 쪽이 한다) */
export function setCompareVars(values: Record<string, string | number>): void {
  const changed: string[] = [];
  for (const [k, val] of Object.entries(values)) {
    const v = compareVar(k);
    if (!v) continue;
    const before = getCompareVar(v.name);
    const s = String(val);
    memory.set(v.name, s);
    try {
      localStorage.setItem(PREFIX + v.name, s);
    } catch {
      /* 이번 세션만 */
    }
    if (String(before) !== String(getCompareVar(v.name))) changed.push(v.name);
  }
  if (changed.length) for (const f of listeners) f(changed);
}

export function compareSettings(): CompareSettings {
  return settingsFrom(getCompareVar);
}

/** 변수가 바뀌면(설정 창·명령) 부른다. 돌려준 함수로 끊는다 */
export function onCompareVarsChange(f: (names: string[]) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** 변수 값을 묻고 저장한다(-COMPARE 설정에서도 쓴다) */
export async function askCompareVar(ctx: CommandContext, name: string, arg?: string): Promise<void> {
  const v = compareVar(name);
  if (v) await askVar(ctx, v, arg);
}

async function askVar(ctx: CommandContext, v: CompareVar, arg?: string): Promise<void> {
  const cur = getCompareVar(v.name);
  let text = arg?.trim();
  for (;;) {
    if (text === undefined) {
      const r = await ctx.getPoint(`${v.name}에 대한 새 값 입력 <${cur}>:`, { allowText: true, preferNumber: true });
      if ('enter' in r) return;
      if ('keyword' in r) return;
      if ('point' in r) {
        // "255,0,0"은 점으로 읽힌다: 트루컬러는 RGB: 를 붙여야 한다
        ctx.print('색상 번호(1–255)나 RGB:r,g,b 또는 #rrggbb를 입력하십시오.', 'err');
        continue;
      }
      text = r.text;
    }
    if (text === '' || text === undefined) return;
    const p = parseInput(v, text);
    if ('error' in p) {
      ctx.print(p.error, 'err');
      if (arg !== undefined) return;
      text = undefined;
      continue;
    }
    setCompareVars({ [v.name]: p.value });
    return;
  }
}

/** 변수 명령 등록 */
export function registerCompareVarCommands(app: App): void {
  for (const v of COMPARE_VARS) {
    app.register({
      name: v.name,
      title: `도면 비교: ${v.title}`,
      transparent: true,
      noDoc: true,
      run: (ctx, arg) => askVar(ctx, v, arg),
    });
  }
}
