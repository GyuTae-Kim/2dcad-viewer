/** 요약 JSON 비교(숫자는 허용 오차 안이면 같다고 본다) */
export interface Mismatch {
  path: string;
  expected: unknown;
  actual: unknown;
}

export function compareSummaries(expected: unknown, actual: unknown, tol = 1e-6, path = '', out: Mismatch[] = [], limit = 200): Mismatch[] {
  if (out.length >= limit) return out;
  // 기준이 null이면 비교하지 않는다(기준 도구가 값을 모르는 항목).
  if (expected === null) return out;
  if (typeof expected === 'number' && typeof actual === 'number') {
    const scale = Math.max(1, Math.abs(expected));
    if (Math.abs(expected - actual) > tol * scale) out.push({ path, expected, actual });
    return out;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push({ path, expected: `array(${expected.length})`, actual });
      return out;
    }
    if (expected.length !== actual.length) out.push({ path: path + '.length', expected: expected.length, actual: actual.length });
    const n = Math.min(expected.length, actual.length);
    for (let i = 0; i < n; i++) compareSummaries(expected[i], actual[i], tol, `${path}[${i}]`, out, limit);
    return out;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') {
      out.push({ path, expected: 'object', actual });
      return out;
    }
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!(k in a)) {
        if (e[k] !== null && e[k] !== undefined) out.push({ path: `${path}.${k}`, expected: e[k], actual: undefined });
        continue;
      }
      compareSummaries(e[k], a[k], tol, `${path}.${k}`, out, limit);
    }
    for (const k of Object.keys(a)) if (!(k in e) && a[k] !== undefined) out.push({ path: `${path}.${k}`, expected: undefined, actual: a[k] });
    return out;
  }
  if (expected !== actual) out.push({ path, expected, actual });
  return out;
}
