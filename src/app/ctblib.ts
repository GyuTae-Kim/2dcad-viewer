/**
 * 불러온 플롯 스타일 표(CTB). 펜 표만 이 브라우저(localStorage)에 보관한다.
 */
import { type CtbTable, readCtb } from '../render/ctb';
import { h } from './ui/dom';

const KEY = 'opencad.ctb';
const tables = new Map<string, CtbTable>();
let restored = false;

function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    for (const t of JSON.parse(raw) as CtbTable[]) if (t?.name && Array.isArray(t.pens)) tables.set(t.name.toLowerCase(), t);
  } catch {
    /* 보관소를 못 쓰면 이번 세션만 */
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...tables.values()]));
  } catch {
    /* 무시 */
  }
}

/** 표를 등록한다(보관소에도) */
export function addCtb(t: CtbTable): void {
  restore();
  tables.set(t.name.toLowerCase(), t);
  persist();
}

export function ctbList(): CtbTable[] {
  restore();
  return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function ctbByName(name: string | undefined): CtbTable | undefined {
  restore();
  return name ? tables.get(name.toLowerCase()) : undefined;
}

/** CTB 파일을 골라 불러온다. 불러온 표들 */
export function pickCtbFiles(): Promise<CtbTable[]> {
  restore();
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, accept: '.ctb', style: 'display:none' }) as HTMLInputElement;
    const done = async () => {
      const out: CtbTable[] = [];
      for (const f of [...(input.files ?? [])]) {
        if (f.size > 4 * 1024 * 1024) continue;
        const t = await readCtb(new Uint8Array(await f.arrayBuffer()), f.name);
        if (t) {
          tables.set(t.name.toLowerCase(), t);
          out.push(t);
        }
      }
      if (out.length) persist();
      input.remove();
      resolve(out);
    };
    input.addEventListener('change', () => void done());
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    document.body.append(input);
    input.click();
  });
}
