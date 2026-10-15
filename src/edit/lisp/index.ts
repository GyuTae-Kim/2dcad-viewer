/**
 * AutoLISP 부분 집합(화면·DOM 없음): 평가기에 기본 함수·문자열 함수·앱 연결 함수를 단다.
 * 앱 연결은 src/app/lisp*.ts, 시험은 tests/lisp/.
 */
import { installCore } from './core';
import type { LispHost } from './host';
import { installHost } from './hostfns';
import { Interp, type InterpOptions } from './interp';
import { installText } from './text';
import { Real } from './types';

export { Interp, type Outcome } from './interp';
export type { LispHost, LispDrawing, AskKind, AskOptions, AskResult } from './host';

export function createInterp(host: LispHost, opts: InterpOptions): Interp {
  const it = new Interp(opts);
  installCore(it);
  installText(it, (n) => {
    const v = host.getvar(n);
    return typeof v === 'number' ? v : v instanceof Real ? v.v : undefined;
  });
  installHost(it, host);
  it.onDefun = (name) => {
    if (/^C:./i.test(name)) host.defineCommand(name.slice(2));
  };
  return it;
}
