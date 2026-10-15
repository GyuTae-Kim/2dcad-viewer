/**
 * 순수 평가기 시험용 가짜 연결: 도면 없음, 입력은 미리 넣어 둔 답, 변수는 Map.
 */
import { createInterp, type Interp, type LispHost } from '../../src/edit/lisp';
import type { AskResult } from '../../src/edit/lisp/host';
import { prin1 } from '../../src/edit/lisp/printer';
import type { Value } from '../../src/edit/lisp/types';

export interface PureLisp {
  it: Interp;
  printed: string[];
  prompts: string[];
  defined: string[];
  inputs: AskResult[];
  vars: Map<string, Value>;
  files: Map<string, { name: string; text: string }>;
  /** 글을 평가해 결과를 prin1 글로(오류면 "ERR:메시지") */
  ev(text: string): Promise<string>;
}

export function pureLisp(): PureLisp {
  const printed: string[] = [];
  const prompts: string[] = [];
  const defined: string[] = [];
  const inputs: AskResult[] = [];
  const files = new Map<string, { name: string; text: string }>();
  const vars = new Map<string, Value>([
    ['LUNITS', 2],
    ['LUPREC', 4],
    ['DIMZIN', 0],
    ['AUNITS', 0],
    ['AUPREC', 0],
  ]);
  const host: LispHost = {
    alert: (t) => void printed.push(`[alert] ${t}`),
    ask: async (_kind, prompt) => {
      prompts.push(prompt);
      const r = inputs.shift();
      if (!r) throw Object.assign(new Error('취소'), { name: 'CancelError' });
      return r;
    },
    command: async () => null,
    getvar: (n) => vars.get(n.toUpperCase()),
    setvar: (n, v) => {
      if (!vars.has(n.toUpperCase())) return '';
      vars.set(n.toUpperCase(), v);
      return null;
    },
    drawing: () => null,
    select: async () => [],
    selectWindow: () => [],
    pickAt: () => null,
    implied: () => [],
    setImplied() {},
    previous: () => [],
    setPrevious() {},
    lastCreated: () => null,
    ucs: () => ({ ox: 0, oy: 0, angle: 0 }),
    defineCommand: (n) => void defined.push(n),
    findFile: async (n) => files.get(n.toLowerCase()) ?? files.get(`${n.toLowerCase()}.lsp`) ?? null,
  };
  const it = createInterp(host, { print: (t, cls) => void printed.push(cls ? `${cls}:${t}` : t) });
  return {
    it,
    printed,
    prompts,
    defined,
    inputs,
    vars,
    files,
    async ev(text: string) {
      const o = await it.evalText(text, false);
      return o.ok ? prin1(o.value) : `ERR:${o.error.message}`;
    },
  };
}
