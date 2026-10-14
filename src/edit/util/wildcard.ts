/**
 * AutoCAD 와일드카드(WCMATCH) 비교와 이름 바꾸기 치환.
 * - `#` 숫자 하나, `@` 영문자 하나, `.` 영문자·숫자가 아닌 글자 하나, `*` 아무 글(빈 글 포함), `?` 아무 글자 하나
 * - `~` 맨 앞이면 부정, `[...]` 안의 글자 하나(`[~...]`는 그 밖의 글자, `-`는 범위), `` ` ``는 다음 글자를 그대로
 * - `,`로 여러 무늬를 나열한다(하나라도 맞으면 참)
 */

function patternRegex(p: string): string {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    switch (c) {
      case '#':
        out += '[0-9]';
        break;
      case '@':
        out += '\\p{L}';
        break;
      case '.':
        out += '[^\\p{L}\\p{N}]';
        break;
      case '*':
        out += '.*';
        break;
      case '?':
        out += '.';
        break;
      case '`':
        i++;
        if (i < p.length) out += escapeRe(p[i]!);
        break;
      case '[': {
        const end = p.indexOf(']', i + 2);
        if (end < 0) {
          out += '\\[';
          break;
        }
        let body = p.slice(i + 1, end);
        let neg = false;
        if (body.startsWith('~')) {
          neg = true;
          body = body.slice(1);
        }
        const cls = [...body].map((ch) => (ch === '-' ? '-' : escapeRe(ch))).join('');
        out += `[${neg ? '^' : ''}${cls}]`;
        i = end;
        break;
      }
      default:
        out += escapeRe(c);
    }
  }
  return out;
}

function escapeRe(c: string): string {
  return c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** 쉼표로 나눈다(`` ` ``로 막은 쉼표와 [] 안의 쉼표는 나누지 않는다) */
function splitPatterns(p: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inBr = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '`' && i + 1 < p.length) {
      cur += c + p[i + 1];
      i++;
      continue;
    }
    if (c === '[') inBr = true;
    else if (c === ']') inBr = false;
    if (c === ',' && !inBr) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

const cache = new Map<string, { re: RegExp; neg: boolean }[]>();

/** 글이 무늬에 맞는지(기본은 대소문자 무시 — 이름 비교) */
export function wcmatch(text: string, pattern: string, caseInsensitive = true): boolean {
  const key = `${caseInsensitive ? 'i' : 's'}:${pattern}`;
  let list = cache.get(key);
  if (!list) {
    list = splitPatterns(pattern).map((raw) => {
      const neg = raw.startsWith('~');
      const body = neg ? raw.slice(1) : raw;
      return { re: new RegExp(`^${patternRegex(body)}$`, caseInsensitive ? 'iu' : 'u'), neg };
    });
    if (cache.size > 200) cache.clear();
    cache.set(key, list);
  }
  return list.some((x) => x.re.test(text) !== x.neg);
}

/** 무늬에 와일드카드 글자가 있는지(이름 바꾸기·필터에서 그대로 비교할지 정한다) */
export function hasWildcard(pattern: string): boolean {
  return /[*?#@.~[\],`]/.test(pattern);
}

/**
 * 이름 바꾸기 치환: 기존 무늬의 `*`·`?`가 가리킨 글을 새 무늬의 같은 자리(순서대로)에 넣는다.
 * 예) `STAIR$*` → `S_*`이면 `STAIR$12`는 `S_12`. 맞지 않으면 null.
 */
export function wildRename(name: string, oldPattern: string, newPattern: string): string | null {
  let re = '';
  for (let i = 0; i < oldPattern.length; i++) {
    const c = oldPattern[i]!;
    if (c === '*') re += '(.*?)';
    else if (c === '?') re += '(.)';
    else if (c === '`' && i + 1 < oldPattern.length) re += escapeRe(oldPattern[++i]!);
    else re += escapeRe(c);
  }
  const m = new RegExp(`^${re}$`, 'iu').exec(name);
  if (!m) return null;
  let k = 1;
  let out = '';
  for (let i = 0; i < newPattern.length; i++) {
    const c = newPattern[i]!;
    if (c === '*' || c === '?') out += m[k++] ?? '';
    else if (c === '`' && i + 1 < newPattern.length) out += newPattern[++i];
    else out += c;
  }
  return out;
}
