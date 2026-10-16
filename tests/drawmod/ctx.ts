/**
 * 시험 도우미: tests/cmds2/harness.ts의 명령을 Shift 고르기·빈 곳 클릭(getEntity의 emptyPick)까지 흘려 넣는 실행기.
 * 입력: '' = Enter, 키워드, "x,y" 점, { pick, at, shift? }, { empty: [x, y], shift? }, { sel }.
 */
import type { Command, CommandContext, Keyword } from '../../src/app/app';
import { parsePointInput } from '../../src/app/commandline';
import type { Harness } from '../cmds2/harness';

export type Input2 = string | { pick: string; at: [number, number]; shift?: boolean } | { empty: [number, number]; shift?: boolean } | { sel: string[] };

export async function runWith(h: Harness, name: string, inputs: Input2[], group = 77): Promise<string[]> {
  const queue = [...inputs];
  const prompts: string[] = [];
  const next = (p: string): Input2 => {
    prompts.push(p);
    if (!queue.length) throw new Error(`입력이 모자랍니다: ${p}`);
    return queue.shift()!;
  };
  const kwOf = (t: string, kws: Keyword[]) => kws.find((k) => k.key.toUpperCase() === t.trim().toUpperCase() || k.label === t.trim());
  const ctx = {
    app: h.app,
    group,
    print: (t: string) => h.printed.push(t),
    async getPoint(prompt: string, opt: { keywords?: Keyword[]; base?: { x: number; y: number } | null; allowText?: boolean; preferNumber?: boolean } = {}) {
      const x = next(prompt);
      if (typeof x !== 'string') throw new Error(`점 프롬프트에 맞지 않는 입력 (${prompt})`);
      const t = x.trim();
      if (!t) return { enter: true };
      const kw = kwOf(t, opt.keywords ?? []);
      if (kw) return { keyword: kw.key };
      if (opt.preferNumber && /^-?[\d.]+$/.test(t)) return { text: t };
      const p = parsePointInput(t, opt.base ?? null, null);
      if (p) return { point: p, snap: null };
      return { text: t };
    },
    async getEntity(prompt: string, kws: Keyword[] = [], opt: { emptyPick?: boolean } = {}) {
      const x = next(prompt);
      if (typeof x === 'string') {
        if (!x.trim()) return { enter: true };
        const kw = kwOf(x, kws);
        if (kw) return { keyword: kw.key };
        throw new Error(`객체 프롬프트에 글: ${x}`);
      }
      if ('pick' in x) return { handle: x.pick, point: { x: x.at[0], y: x.at[1] }, ...(x.shift ? { shift: true } : {}) };
      if ('empty' in x) {
        if (!opt.emptyPick) throw new Error(`빈 곳 클릭을 받지 않는 프롬프트 (${prompt})`);
        return { point: { x: x.empty[0], y: x.empty[1] }, empty: true, ...(x.shift ? { shift: true } : {}) };
      }
      throw new Error(`객체 프롬프트에 맞지 않는 입력 (${prompt})`);
    },
    async getSelection(prompt = '객체 선택:') {
      const x = next(prompt);
      if (typeof x === 'string') return [];
      if ('sel' in x) return x.sel;
      throw new Error(`선택 프롬프트에 맞지 않는 입력 (${prompt})`);
    },
  } as unknown as CommandContext;
  const c = (h.app as unknown as { commands: Map<string, Command> }).commands.get(name.toUpperCase());
  if (!c) throw new Error(`명령 없음: ${name}`);
  await c.run(ctx);
  if (queue.length) throw new Error(`남은 입력 ${queue.length}개: ${JSON.stringify(queue)}`);
  return prompts;
}
