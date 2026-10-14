/** 도면 단위·숫자 표시(LUNITS·LUPREC·AUNITS·AUPREC·INSUNITS) */
import type { CadDocument } from './model';

export const INSUNITS_NAMES: Record<number, { name: string; abbr: string; mm?: number }> = {
  0: { name: '단위 없음', abbr: '' },
  1: { name: '인치', abbr: 'in', mm: 25.4 },
  2: { name: '피트', abbr: 'ft', mm: 304.8 },
  3: { name: '마일', abbr: 'mi', mm: 1609344 },
  4: { name: '밀리미터', abbr: 'mm', mm: 1 },
  5: { name: '센티미터', abbr: 'cm', mm: 10 },
  6: { name: '미터', abbr: 'm', mm: 1000 },
  7: { name: '킬로미터', abbr: 'km', mm: 1e6 },
  8: { name: '마이크로인치', abbr: 'µin', mm: 25.4e-6 },
  9: { name: '밀', abbr: 'mil', mm: 0.0254 },
  10: { name: '야드', abbr: 'yd', mm: 914.4 },
  11: { name: '옹스트롬', abbr: 'Å', mm: 1e-7 },
  12: { name: '나노미터', abbr: 'nm', mm: 1e-6 },
  13: { name: '마이크로미터', abbr: 'µm', mm: 1e-3 },
  14: { name: '데시미터', abbr: 'dm', mm: 100 },
  15: { name: '데카미터', abbr: 'dam', mm: 1e4 },
  16: { name: '헥토미터', abbr: 'hm', mm: 1e5 },
  17: { name: '기가미터', abbr: 'Gm', mm: 1e12 },
  18: { name: '천문단위', abbr: 'AU' },
  19: { name: '광년', abbr: 'ly' },
  20: { name: '파섹', abbr: 'pc' },
  21: { name: '미국 측량 피트', abbr: 'ft', mm: 304.8006096 },
};

export interface UnitSettings {
  lunits: number;
  luprec: number;
  aunits: number;
  auprec: number;
  insunits: number;
  /** 각도 0의 방향(라디안) */
  angbase: number;
  /** 1이면 시계 방향 */
  angdir: number;
  measurement: number;
}

export function unitSettings(doc: CadDocument): UnitSettings {
  const n = (k: string, d: number) => {
    const v = doc.header.get(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  return {
    lunits: n('$LUNITS', 2),
    luprec: Math.max(0, Math.min(8, n('$LUPREC', 4))),
    aunits: n('$AUNITS', 0),
    auprec: Math.max(0, Math.min(8, n('$AUPREC', 0))),
    insunits: n('$INSUNITS', 0),
    angbase: n('$ANGBASE', 0),
    angdir: n('$ANGDIR', 0),
    measurement: n('$MEASUREMENT', 1),
  };
}

function trimZeros(s: string): string {
  return s;
}

function fraction(v: number, prec: number): string {
  // 분모 2^prec
  const den = 1 << Math.max(0, Math.min(8, prec));
  const neg = v < 0;
  let a = Math.abs(v);
  let whole = Math.floor(a);
  let num = Math.round((a - whole) * den);
  if (num === den) {
    whole++;
    num = 0;
  }
  let d = den;
  while (num && num % 2 === 0 && d % 2 === 0) {
    num /= 2;
    d /= 2;
  }
  a = whole;
  const s = num ? (whole ? `${whole} ${num}/${d}` : `${num}/${d}`) : `${whole}`;
  return neg ? '-' + s : s;
}

/** 길이 표시 */
export function formatLength(v: number, u: Pick<UnitSettings, 'lunits' | 'luprec'>, prec = u.luprec): string {
  if (!Number.isFinite(v)) return '-';
  switch (u.lunits) {
    case 1:
      return v.toExponential(prec).replace('e', 'E');
    case 3: {
      // 공학: 피트-인치(소수)
      const neg = v < 0;
      const a = Math.abs(v);
      const ft = Math.floor(a / 12);
      const inch = a - ft * 12;
      const s = `${ft}'-${inch.toFixed(prec)}"`;
      return neg ? '-' + s : s;
    }
    case 4: {
      const neg = v < 0;
      const a = Math.abs(v);
      let ft = Math.floor(a / 12);
      let inchStr = fraction(a - ft * 12, prec);
      if (inchStr.startsWith('12')) {
        ft++;
        inchStr = '0';
      }
      const s = `${ft}'-${inchStr}"`;
      return neg ? '-' + s : s;
    }
    case 5:
      return fraction(v, prec);
    default:
      return trimZeros(v.toFixed(prec));
  }
}

const RAD = 180 / Math.PI;

/** 각도 표시(라디안 입력, 도면의 각도 0 방향·방향은 적용하지 않은 순수 각도) */
export function formatAngle(a: number, u: Pick<UnitSettings, 'aunits' | 'auprec'>, prec = u.auprec): string {
  if (!Number.isFinite(a)) return '-';
  switch (u.aunits) {
    case 1: {
      let deg = Math.abs(a * RAD);
      const neg = a < 0;
      let d = Math.floor(deg);
      deg = (deg - d) * 60;
      let m = Math.floor(deg);
      let s = (deg - m) * 60;
      if (prec <= 0) return `${neg ? '-' : ''}${Math.round(a * RAD)}d`;
      if (prec <= 2) {
        m = Math.round(deg);
        if (m === 60) {
          d++;
          m = 0;
        }
        return `${neg ? '-' : ''}${d}d${m}'`;
      }
      const sp = Math.max(0, prec - 4);
      s = Number(s.toFixed(sp));
      if (s >= 60) {
        s = 0;
        m++;
      }
      if (m >= 60) {
        m = 0;
        d++;
      }
      return `${neg ? '-' : ''}${d}d${m}'${s.toFixed(sp)}"`;
    }
    case 2:
      return `${((a * 200) / Math.PI).toFixed(prec)}g`;
    case 3:
      return `${a.toFixed(prec)}r`;
    case 4: {
      // 측량 단위: N 45d0' E
      const deg = (((90 - a * RAD) % 360) + 360) % 360; // 북쪽 기준 시계 방향
      let ns = 'N';
      let ew = 'E';
      let b = deg;
      if (deg <= 90) b = deg;
      else if (deg <= 180) {
        ns = 'S';
        b = 180 - deg;
      } else if (deg <= 270) {
        ns = 'S';
        ew = 'W';
        b = deg - 180;
      } else {
        ew = 'W';
        b = 360 - deg;
      }
      return `${ns} ${b.toFixed(prec)}d ${ew}`;
    }
    default:
      return `${(a * RAD).toFixed(prec)}°`;
  }
}

/** 면적 표시: 단위의 제곱 */
export function formatArea(v: number, u: Pick<UnitSettings, 'lunits' | 'luprec'>): string {
  if (u.lunits === 4 || u.lunits === 3) {
    // 제곱인치와 제곱피트
    const sqft = v / 144;
    return `${v.toFixed(u.luprec)} 제곱 in (${sqft.toFixed(4)} 제곱 ft)`;
  }
  return formatLength(v, { lunits: u.lunits === 5 ? 2 : u.lunits, luprec: u.luprec });
}

export function unitAbbr(insunits: number): string {
  return INSUNITS_NAMES[insunits]?.abbr ?? '';
}

export function unitName(insunits: number): string {
  return INSUNITS_NAMES[insunits]?.name ?? `코드 ${insunits}`;
}

/**
 * 길이 입력 읽기: 소수(12.5, 1.25E+01), 분수(12 1/2), 피트-인치(1'-2.5", 1'2-1/2", 3', 4").
 * 읽지 못하면 null.
 */
export function parseLength(s: string): number | null {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return Number(t);
  const frac = (x: string): number | null => {
    const m = /^(\d+(?:\.\d+)?)?(?:[ -]?(\d+)\/(\d+))?$/.exec(x.trim());
    if (!m || (!m[1] && !m[2])) return null;
    const whole = m[1] ? Number(m[1]) : 0;
    const f = m[2] ? Number(m[2]) / Number(m[3]) : 0;
    return Number.isFinite(f) ? whole + f : null;
  };
  let neg = false;
  let body = t;
  if (body.startsWith('-')) {
    neg = true;
    body = body.slice(1).trim();
  }
  const ft = /^(\d+(?:\.\d+)?)'\s*-?\s*(.*?)"?$/.exec(body);
  if (ft) {
    const feet = Number(ft[1]);
    const inch = ft[2] ? frac(ft[2]) : 0;
    if (inch === null) return null;
    const v = feet * 12 + inch;
    return neg ? -v : v;
  }
  const inch = /^(.*?)"$/.exec(body);
  const v = frac(inch ? inch[1]! : body);
  if (v === null) return null;
  return neg ? -v : v;
}

/**
 * 각도 입력 읽기(라디안으로). 단위 표시가 없으면 aunits를 따른다(0·1·4 도, 2 그라드, 3 라디안).
 * 45, 45d30'15", 45°, 50g, 0.7854r 형식.
 */
export function parseAngle(s: string, aunits = 0): number | null {
  const t = s.trim().replace(/\s+/g, '');
  if (!t) return null;
  const DEG = Math.PI / 180;
  let m = /^([-+]?\d*\.?\d+)(g|r)$/i.exec(t);
  if (m) return m[2]!.toLowerCase() === 'g' ? (Number(m[1]) * Math.PI) / 200 : Number(m[1]);
  m = /^([-+])?(\d*\.?\d+)(?:d|°)(?:(\d*\.?\d+)')?(?:(\d*\.?\d+)")?$/i.exec(t);
  if (m) {
    const v = Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0) + (m[4] ? Number(m[4]) / 3600 : 0);
    return (m[1] === '-' ? -v : v) * DEG;
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) {
    const v = Number(t);
    if (aunits === 2) return (v * Math.PI) / 200;
    if (aunits === 3) return v;
    return v * DEG;
  }
  return null;
}
