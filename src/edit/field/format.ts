/**
 * 필드 값 형식: 날짜(M/d/yyyy …), 숫자(%lu 단위·%pr 정밀도·%ct 변환·%ps 접두·접미),
 * 대소문자(%tc1 대문자·%tc2 소문자·%tc3 첫 글자 대문자·%tc4 제목 대소문자), 파일 이름(%fn 비트: 1 경로, 2 이름, 4 확장자).
 */

const KO_DAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
const KO_DAYS_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

/** AutoCAD 날짜 형식(.NET 형식 문자열과 같은 글자) */
export function formatDate(d: Date, fmt: string): string {
  const f = fmt || 'yyyy-MM-dd';
  let out = '';
  for (let i = 0; i < f.length; ) {
    const ch = f[i]!;
    if (ch === "'" || ch === '"') {
      const j = f.indexOf(ch, i + 1);
      out += f.slice(i + 1, j < 0 ? f.length : j);
      i = j < 0 ? f.length : j + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < f.length) {
      out += f[i + 1];
      i += 2;
      continue;
    }
    let n = 1;
    while (f[i + n] === ch) n++;
    const pad = (v: number, w: number) => String(v).padStart(w, '0');
    switch (ch) {
      case 'y':
        out += n <= 2 ? pad(d.getFullYear() % 100, 2) : pad(d.getFullYear(), n);
        break;
      case 'M':
        out += n === 1 ? String(d.getMonth() + 1) : n === 2 ? pad(d.getMonth() + 1, 2) : `${d.getMonth() + 1}월`;
        break;
      case 'd':
        out += n === 1 ? String(d.getDate()) : n === 2 ? pad(d.getDate(), 2) : n === 3 ? KO_DAYS_SHORT[d.getDay()]! : KO_DAYS[d.getDay()]!;
        break;
      case 'h': {
        const h12 = d.getHours() % 12 || 12;
        out += n === 1 ? String(h12) : pad(h12, 2);
        break;
      }
      case 'H':
        out += n === 1 ? String(d.getHours()) : pad(d.getHours(), 2);
        break;
      case 'm':
        out += n === 1 ? String(d.getMinutes()) : pad(d.getMinutes(), 2);
        break;
      case 's':
        out += n === 1 ? String(d.getSeconds()) : pad(d.getSeconds(), 2);
        break;
      case 't':
        out += d.getHours() < 12 ? (n === 1 ? 'A' : '오전') : n === 1 ? 'P' : '오후';
        break;
      default:
        out += ch.repeat(n);
    }
    i += n;
  }
  return out;
}

/** 율리우스 날짜($TDCREATE 등) → Date */
export function julianToDate(jd: number): Date | null {
  if (!(Number.isFinite(jd) && jd > 0)) return null;
  return new Date((jd - 2440587.5) * 86400000);
}

export function textCase(s: string, fmt: string): string {
  const m = /%tc(\d)/.exec(fmt);
  if (!m) return s;
  switch (m[1]) {
    case '1':
      return s.toUpperCase();
    case '2':
      return s.toLowerCase();
    case '3':
      return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    case '4':
      return s.toLowerCase().replace(/(^|[\s_-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
    default:
      return s;
  }
}

/** 파일 이름 형식: %fn 비트(1 경로, 2 이름, 4 확장자). 형식이 없으면 이름과 확장자 */
export function formatFileName(fullPath: string, fmt: string): string {
  const m = /%fn(\d+)/.exec(fmt);
  const bits = m ? Number(m[1]) : 6;
  const norm = fullPath.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  const dir = slash >= 0 ? fullPath.slice(0, slash + 1) : '';
  const file = slash >= 0 ? fullPath.slice(slash + 1) : fullPath;
  const dot = file.lastIndexOf('.');
  const name = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  let out = '';
  if (bits & 1) out += dir;
  if (bits & 2) out += name;
  if (bits & 4) out += ext;
  return textCase(out, fmt);
}

export interface NumberFormatContext {
  /** 기본 정밀도(LUPREC) */
  luprec: number;
  /** 기본 단위(LUNITS) */
  lunits: number;
}

/** 숫자 형식: %luN(1 과학, 2 십진, 3 공학, 4 건축, 5 분수 — 3~5는 십진으로), %prN, %ct8[k] 곱하기, %ps[앞,뒤], %th 천 단위 구분 */
export function formatNumber(v: number, fmt: string, ctx: NumberFormatContext): string {
  let x = v;
  const ct = /%ct8\[([^\]]+)\]/.exec(fmt);
  if (ct) {
    const k = Number(ct[1]);
    if (Number.isFinite(k)) x *= k;
  }
  const pr = /%pr(\d+)/.exec(fmt);
  const prec = pr ? Math.min(8, Number(pr[1])) : ctx.luprec;
  const lu = /%lu(\d)/.exec(fmt);
  const unit = lu ? Number(lu[1]) : ctx.lunits;
  let s: string;
  if (unit === 1) s = x.toExponential(prec).replace(/e([+-])(\d+)$/, (_, sg: string, d: string) => `E${sg}${d.padStart(2, '0')}`);
  else s = x.toFixed(prec);
  if (/%th/.test(fmt)) {
    const [a, b] = s.split('.');
    s = a!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (b !== undefined ? '.' + b : '');
  }
  const ps = /%ps\[([^,\]]*),?([^\]]*)\]/.exec(fmt);
  if (ps) s = ps[1]! + s + ps[2]!;
  return s;
}

/** 각도 형식(라디안 값, %au0 도 …, %pr 정밀도) */
export function formatAngleValue(rad: number, fmt: string, ctx: NumberFormatContext): string {
  const deg = (rad * 180) / Math.PI;
  const pr = /%pr(\d+)/.exec(fmt);
  const prec = pr ? Number(pr[1]) : Math.min(ctx.luprec, 4);
  return `${deg.toFixed(prec)}°`;
}
