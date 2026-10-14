/**
 * 필드 코드: 문자 안의 %<\평가기 내용>% 조각을 찾고 나눈다.
 *
 * 예: %<\AcVar Date \f "yyyy-MM-dd">%, %<\AcVar Filename \f "%fn2">%,
 *     %<\AcObjProp Object(%<\_ObjId 2A7>%).Area \f "%lu2%pr2">%
 * 객체 필드의 _ObjId 값은 이 프로그램에서 객체 핸들(16진)이다.
 */

export interface FieldPart {
  kind: 'field';
  /** %< … >% 전체 */
  code: string;
  /** 평가기(AcVar, AcObjProp, AcDiesel …) */
  evaluator: string;
  /** 평가기 뒤 내용(\f 형식 앞까지) */
  body: string;
  /** \f "…" 형식(없으면 빈 문자열) */
  format: string;
}

export interface TextPart {
  kind: 'text';
  text: string;
}

export type Part = FieldPart | TextPart;

/** i에서 시작하는 %<의 짝 >% 다음 위치(중첩 허용, 짝이 없으면 -1) */
function closeOf(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length - 1; k++) {
    if (s[k] === '%' && s[k + 1] === '<') {
      depth++;
      k++;
    } else if (s[k] === '>' && s[k + 1] === '%') {
      depth--;
      k++;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

export function parseFieldCode(code: string): FieldPart {
  const inner = code.slice(2, -2).trim();
  const m = /^\\([A-Za-z_][\w.]*)\s*([\s\S]*)$/.exec(inner);
  const evaluator = m ? m[1]! : '';
  let rest = m ? m[2]! : inner;
  let format = '';
  // 형식 \f "…"(마지막 것)
  const fm = /\\f\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(rest);
  if (fm) {
    format = fm[1]!;
    rest = rest.slice(0, fm.index).trim();
  }
  return { kind: 'field', code, evaluator, body: rest.trim(), format };
}

/** 문자를 일반 문자와 필드로 나눈다 */
export function splitFields(s: string): Part[] {
  const out: Part[] = [];
  let i = 0;
  let last = 0;
  while (i < s.length - 1) {
    if (s[i] === '%' && s[i + 1] === '<' && s[i + 2] === '\\') {
      const end = closeOf(s, i);
      if (end > 0) {
        if (i > last) out.push({ kind: 'text', text: s.slice(last, i) });
        out.push(parseFieldCode(s.slice(i, end)));
        i = end;
        last = end;
        continue;
      }
    }
    i++;
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) });
  return out;
}

export function hasFieldCode(s: string): boolean {
  return splitFields(s).some((p) => p.kind === 'field');
}

export function countFields(s: string): number {
  return splitFields(s).filter((p) => p.kind === 'field').length;
}

/** 객체 필드의 객체 핸들(Object(%<\_ObjId H>%)) */
export function objectHandleOf(body: string): string | null {
  const m = /Object\(\s*%<\\_ObjId\s+([0-9A-Fa-f]+)\s*>%\s*\)/.exec(body);
  return m ? m[1]!.toUpperCase() : null;
}

/** 객체 필드의 특성 이름(Object(...).Area → Area) */
export function objectPropertyOf(body: string): string | null {
  const m = /\)\s*\.\s*([A-Za-z][\w]*)/.exec(body);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// 만들기
// ---------------------------------------------------------------------------

export function varField(name: string, format = ''): string {
  return format ? `%<\\AcVar ${name} \\f "${format}">%` : `%<\\AcVar ${name}>%`;
}

export function objectField(handle: string, prop: string, format = ''): string {
  const body = `Object(%<\\_ObjId ${handle.toUpperCase()}>%).${prop}`;
  return format ? `%<\\AcObjProp ${body} \\f "${format}">%` : `%<\\AcObjProp ${body}>%`;
}
