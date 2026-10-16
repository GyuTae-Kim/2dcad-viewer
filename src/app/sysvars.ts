/**
 * 시스템 변수: 명령행에 변수 이름(PDMODE·OSMODE·LTSCALE …)을 바로 치면 `PDMODE에 대한 새 값 입력 <0>:`(App.commandFallbacks),
 * SYSVDLG(시스템 변수 목록·검색·편집 대화상자).
 *
 * 변수는 세 곳에 있다.
 *  - 세션 변수: 앱 상태(OSMODE·ORTHOMODE·SNAPMODE·GRIDMODE·POLARMODE·DYNMODE, FILEDIA·CMDDIA·CMDECHO)와 읽기 전용 값(DWGNAME·CDATE …).
 *    AutoLISP getvar·setvar와 같은 구현(lisp-host.ts)을 쓴다.
 *  - 이 브라우저 변수(AutoCAD의 레지스트리 자리): PICKBOX·GRIPSIZE·CURSORSIZE·APERTURE·PICKFIRST·SELECTIONPREVIEW·SHORTCUTMENU·
 *    ATTDIA·ATTREQ … localStorage에 두고, 바뀌면 onSysvarChange 구독자에게 알린다(화면이 읽는다).
 *  - 도면 변수: 머리말($PDMODE …). 값을 바꾸면 명령 취소 한 단계(header 편집).
 * 변수 이름이 곧 명령인 것(SAVETIME·COLORTHEME·IMAGEFRAME …)은 그 명령이 먼저 받으므로 여기에 오지 않는다.
 */
import type { HeaderValue, Vec2, Vec3 } from '../core/model';
import { tableKey } from '../core/model';
import { DEFAULT_HEADER, HEADER_VARS, R12_HEADER_VARS } from '../io/dxf/headervars';
import { Real, toArray, type Value } from '../edit/lisp/types';
import type { App, CommandContext } from './app';
import { addHook } from './hooks';
import { getSysVar, setSysVar } from './lisp-host';
import { h } from './ui/dom';
import { btn, checkIn, ensureMgrStyle, pickList, prefGet, prefSet, resultDialog, textIn } from './mgr-ui';

export type SysvarSource = 'session' | 'browser' | 'header';
export type SysvarKind = 'int' | 'real' | 'string' | 'point' | 'bool';

export interface SysvarInfo {
  name: string;
  source: SysvarSource;
  kind: SysvarKind;
  /** 지금 값(점은 {x,y[,z]}) */
  value: HeaderValue | undefined;
  readOnly: boolean;
  /** 짧은 설명(SYSVDLG) */
  desc: string;
}

// ---------------------------------------------------------------------------
// 이 브라우저 변수
// ---------------------------------------------------------------------------

interface BrowserVar {
  name: string;
  def: number;
  min: number;
  max: number;
  desc: string;
  /** 허용 값이 띄엄띄엄이면 */
  values?: readonly number[];
}

const PREFIX = 'opencad.sysvar.';

/** 레지스트리 자리의 변수(AutoCAD 2026 기본값). PICKBOX는 화면의 선택 상자(app.view.overlay.pickbox)와 이어진다 */
export const BROWSER_VARS: readonly BrowserVar[] = [
  { name: 'PICKBOX', def: 5, min: 0, max: 50, desc: '선택 상자 크기(픽셀)' },
  { name: 'GRIPSIZE', def: 5, min: 1, max: 255, desc: '그립 상자 크기(픽셀)' },
  { name: 'GRIPS', def: 2, min: 0, max: 2, desc: '선택한 객체의 그립 표시' },
  { name: 'CURSORSIZE', def: 5, min: 1, max: 100, desc: '십자선 크기(화면 크기의 %)' },
  { name: 'APERTURE', def: 10, min: 1, max: 50, desc: '객체 스냅 조준창 크기(픽셀)' },
  { name: 'AUTOSNAP', def: 63, min: 0, max: 63, desc: 'AutoSnap 표식기·마그넷·툴팁·추적 표시(비트)' },
  { name: 'PICKFIRST', def: 1, min: 0, max: 1, desc: '명령 전에 객체 선택(명사/동사 선택)' },
  { name: 'PICKADD', def: 2, min: 0, max: 2, desc: '선택 세트에 추가(Shift로 추가)' },
  { name: 'PICKAUTO', def: 5, min: 0, max: 7, desc: '객체 선택 프롬프트의 자동 윈도우·걸침 선택' },
  { name: 'SELECTIONPREVIEW', def: 3, min: 0, max: 3, desc: '선택 미리보기(1 명령 중, 2 명령 없을 때)' },
  { name: 'SHORTCUTMENU', def: 11, min: 0, max: 31, desc: '도면 영역 오른쪽 클릭의 바로 가기 메뉴(비트)' },
  { name: 'SHORTCUTMENUDURATION', def: 250, min: 100, max: 10000, desc: '오른쪽 클릭을 길게 누르면 메뉴(밀리초)' },
  { name: 'ATTDIA', def: 1, min: 0, max: 1, desc: 'INSERT의 속성 값 입력을 대화상자로' },
  { name: 'ATTREQ', def: 1, min: 0, max: 1, desc: '블록을 넣을 때 속성 값 묻기' },
  { name: 'ZOOMFACTOR', def: 60, min: 3, max: 100, desc: '휠 한 칸의 확대·축소 정도' },
];

const browserVar = (n: string) => BROWSER_VARS.find((v) => v.name === n);
const listeners = new Set<(name: string, value: number) => void>();

/** 이 브라우저 변수 값(없는 이름이면 NaN) */
export function browserSysvar(name: string): number {
  const v = browserVar(name.toUpperCase());
  if (!v) return NaN;
  const raw = prefGet(PREFIX + v.name);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= v.min && n <= v.max ? n : v.def;
}

/** 이 브라우저 변수 바꾸기(범위 밖이면 문구). 바꾸면 구독자에게 알린다 */
export function setBrowserSysvar(name: string, value: number): string | null {
  const v = browserVar(name.toUpperCase());
  if (!v) return '알 수 없는 변수 이름입니다.';
  if (!Number.isInteger(value) || value < v.min || value > v.max || (v.values && !v.values.includes(value))) return `${v.min}과(와) ${v.max} 사이의 정수가 필요합니다.`;
  prefSet(PREFIX + v.name, String(value));
  for (const f of listeners) f(v.name, value);
  return null;
}

/** 이 브라우저 변수가 바뀔 때(화면이 PICKBOX·GRIPSIZE·CURSORSIZE … 를 다시 읽는다). 끊는 함수를 돌려준다 */
export function onSysvarChange(f: (name: string, value: number) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** INSERT의 속성 대화상자(ATTDIA) */
export function attDia(): boolean {
  return browserSysvar('ATTDIA') !== 0;
}

/** 속성 값 묻기(ATTREQ). 이 브라우저 값을 정했으면 그것, 아니면 도면 머리말($ATTREQ, R12) */
export function attReq(app: App): boolean {
  if (prefGet(PREFIX + 'ATTREQ') !== null) return browserSysvar('ATTREQ') !== 0;
  return Number(app.active?.doc.header.get('$ATTREQ') ?? 1) !== 0;
}

// ---------------------------------------------------------------------------
// 도면 변수
// ---------------------------------------------------------------------------

const HEADER_CODE = new Map<string, number>([...R12_HEADER_VARS.map(([n, c]) => [n, c] as const), ...HEADER_VARS.map(([n, c]) => [n, c] as const)]);

/** 머리말에 있지만 시스템 변수가 아닌 값(이 앱이 도면 특성을 담는 자리 등) */
const NOT_SYSVARS = new Set(['$TITLE', '$SUBJECT', '$AUTHOR', '$KEYWORDS', '$COMMENTS', '$REVISIONNUMBER', '$CUSTOMPROPERTYTAG', '$CUSTOMPROPERTY', '$ACADMAINTVER', '$_CVPORT_ENT']);

/** 읽기 전용 도면 변수 */
const READONLY_HEADER = new Set([
  'ACADVER',
  'DWGCODEPAGE',
  'HANDSEED',
  'TDCREATE',
  'TDUCREATE',
  'TDUPDATE',
  'TDUUPDATE',
  'TDINDWG',
  'TDUSRTIMER',
  'EXTMIN',
  'EXTMAX',
  'PEXTMIN',
  'PEXTMAX',
  'VERSIONGUID',
  'LASTSAVEDBY',
  'MENU',
  'TILEMODE',
  'MAXACTVP',
  'PUCSBASE',
  'UCSBASE',
  'UCSNAME',
  'PUCSNAME',
  'UCSORG',
  'UCSXDIR',
  'UCSYDIR',
  'PUCSORG',
  'PUCSXDIR',
  'PUCSYDIR',
]);

/** 허용 값이 띄엄띄엄인 정수 변수 */
const INT_VALUES: Record<string, readonly number[]> = {
  PDMODE: [0, 1, 2, 3, 4, 32, 33, 34, 35, 36, 64, 65, 66, 67, 68, 96, 97, 98, 99, 100],
  SPLINETYPE: [5, 6],
};

/** 범위 검사(정수 변수, 양 끝 포함) */
const INT_RANGE: Record<string, readonly [number, number]> = {
  LUNITS: [1, 5],
  LUPREC: [0, 8],
  AUNITS: [0, 4],
  AUPREC: [0, 8],
  ANGDIR: [0, 1],
  INSUNITS: [0, 24],
  MIRRTEXT: [0, 1],
  MIRRHATCH: [0, 1],
  FILLMODE: [0, 1],
  QTEXTMODE: [0, 1],
  ATTMODE: [0, 2],
  MEASUREMENT: [0, 1],
  PSLTSCALE: [0, 1],
  LIMCHECK: [0, 1],
  ATTDIA: [0, 1],
  ATTREQ: [0, 1],
  PLINEGEN: [0, 1],
  SPLFRAME: [0, 1],
  SPLINESEGS: [-32768, 32767],
  SURFTAB1: [2, 32766],
  SURFTAB2: [2, 32766],
  DIMASSOC: [0, 2],
  LWDISPLAY: [0, 1],
  CELWEIGHT: [-3, 211],
  PROXYGRAPHICS: [0, 1],
  VISRETAIN: [0, 1],
  PELLIPSE: [0, 1],
  OSMODE: [0, 32767],
  CECOLOR: [0, 257],
};

/** 0보다 커야 하는 실수 변수 */
const POSITIVE_REAL = new Set(['LTSCALE', 'CELTSCALE', 'TEXTSIZE', 'DIMTXT', 'CMLSCALE']);

const DESC: Record<string, string> = {
  ANGBASE: '각도 0의 방향',
  ANGDIR: '양의 각도 방향(1 = 시계 방향)',
  ATTMODE: '속성 표시(0 끄기, 1 보통, 2 모두)',
  AUNITS: '각도 단위 형식',
  AUPREC: '각도 정밀도',
  CECOLOR: '새 객체의 색',
  CELTSCALE: '새 객체의 선종류 축척',
  CELTYPE: '새 객체의 선종류',
  CELWEIGHT: '새 객체의 선가중치',
  CLAYER: '현재 도면층',
  CMLSTYLE: '현재 여러 줄 스타일',
  DIMSCALE: '치수 전체 축척',
  DIMSTYLE: '현재 치수 스타일',
  ELEVATION: '새 객체의 고도',
  EXTMAX: '도면 범위 오른쪽 위',
  EXTMIN: '도면 범위 왼쪽 아래',
  FILLMODE: '해치·폴리선 폭·솔리드 채우기',
  INSBASE: '삽입 기준점(BASE)',
  INSUNITS: '삽입 축척 단위',
  LIMCHECK: '한계 밖 작성 금지',
  LIMMAX: '모형 한계 오른쪽 위',
  LIMMIN: '모형 한계 왼쪽 아래',
  LTSCALE: '전역 선종류 축척',
  LUNITS: '길이 단위 형식',
  LUPREC: '길이 정밀도',
  LWDISPLAY: '선가중치 표시',
  MEASUREMENT: '도면 단위(0 영국식, 1 미터법)',
  MIRRTEXT: '대칭할 때 문자도 뒤집기',
  ORTHOMODE: '직교 모드',
  OSMODE: '실행 중인 객체 스냅(비트)',
  PDMODE: '점 표시 유형',
  PDSIZE: '점 표시 크기',
  PLINEWID: '폴리선 기본 폭',
  PSLTSCALE: '배치 뷰포트의 선종류 축척',
  QTEXTMODE: '빠른 문자(상자로 표시)',
  SNAPMODE: '스냅 모드',
  GRIDMODE: '격자 표시',
  POLARMODE: '극좌표 추적',
  DYNMODE: '동적 입력',
  TEXTSIZE: '새 문자의 높이',
  TEXTSTYLE: '현재 문자 스타일',
  THICKNESS: '새 객체의 두께',
  TILEMODE: '모형 탭(1)·배치 탭(0)',
  FILEDIA: '파일 대화상자 표시',
  CMDDIA: '명령의 대화상자 표시',
  CMDECHO: '명령 입력 되풀이(AutoLISP)',
  DWGNAME: '도면 파일 이름',
  DWGPREFIX: '도면 폴더',
  DWGTITLED: '이름 있는 도면인지',
  CDATE: '지금 날짜·시각',
  DATE: '지금 날짜(율리우스일)',
  CTAB: '현재 배치',
  ACADVER: '프로그램 버전',
  HANDSEED: '다음 핸들',
  DWGCODEPAGE: '도면 코드 페이지',
  TDCREATE: '만든 때',
  TDUPDATE: '마지막으로 저장한 때',
  TDINDWG: '총 편집 시간',
  SPLINETYPE: 'PEDIT 스플라인 유형(5 2차, 6 3차)',
  SPLINESEGS: 'PEDIT 스플라인 선분 수',
  PLINEGEN: '폴리선 선종류를 정점마다 다시 시작하지 않음',
  DIMASSOC: '치수 연관성',
  HYPERLINKBASE: '하이퍼링크 기준 경로',
};

function headerKind(name: string, v: HeaderValue | undefined): SysvarKind {
  const code = HEADER_CODE.get(`$${name}`);
  if (v !== undefined && typeof v === 'object') return 'point';
  if (code !== undefined) {
    if (code >= 10 && code < 40) return 'point';
    if ((code >= 40 && code < 60) || (code >= 140 && code < 150)) return 'real';
    if (code >= 290 && code < 300) return 'bool';
    if (code < 10 || (code >= 300 && code < 370) || (code >= 390 && code < 400) || (code >= 1000 && code < 1010)) return 'string';
    return 'int';
  }
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'real';
  return 'string';
}

// ---------------------------------------------------------------------------
// 세션 변수(lisp-host.ts의 getvar·setvar)
// ---------------------------------------------------------------------------

const SESSION_RW = ['OSMODE', 'ORTHOMODE', 'SNAPMODE', 'GRIDMODE', 'POLARMODE', 'DYNMODE', 'FILEDIA', 'CMDDIA', 'CMDECHO'];
const SESSION_RO = ['DWGNAME', 'DWGPREFIX', 'DWGTITLED', 'CDATE', 'DATE', 'MILLISECS', 'ACADVER', 'PRODUCT', 'PLATFORM', 'LOCALE', 'CTAB', 'LASTPOINT', 'SDI', 'LISPINIT', 'UNDOCTL', 'ERRNO'];

function lispToHeader(v: Value | undefined): HeaderValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (v instanceof Real) return v.v;
  const xs = toArray(v);
  if (xs && xs.length >= 2) {
    const n = xs.map((x) => (typeof x === 'number' ? x : x instanceof Real ? x.v : 0));
    return n.length >= 3 ? { x: n[0]!, y: n[1]!, z: n[2]! } : { x: n[0]!, y: n[1]! };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 찾기·목록·바꾸기
// ---------------------------------------------------------------------------

/** 변수 정보(모르는 이름이면 null) */
export function sysvarInfo(app: App, raw: string): SysvarInfo | null {
  const name = raw.trim().toUpperCase().replace(/^\$/, '');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return null;
  if (SESSION_RW.includes(name) || SESSION_RO.includes(name)) {
    let value: HeaderValue | undefined;
    try {
      value = lispToHeader(getSysVar(app, name));
    } catch {
      // 화면 없는 앱(시험)
      return null;
    }
    if (value === undefined && !SESSION_RO.includes(name)) return null;
    return { name, source: 'session', kind: typeof value === 'object' ? 'point' : typeof value === 'string' ? 'string' : name === 'DATE' || name === 'CDATE' ? 'real' : 'int', value, readOnly: SESSION_RO.includes(name), desc: DESC[name] ?? '' };
  }
  const bv = browserVar(name);
  if (bv) {
    const value = name === 'PICKBOX' && app.view?.overlay ? app.view.overlay.pickbox : name === 'ATTREQ' ? (attReq(app) ? 1 : 0) : browserSysvar(name);
    return { name, source: 'browser', kind: 'int', value, readOnly: false, desc: bv.desc };
  }
  const key = `$${name}`;
  if (NOT_SYSVARS.has(key)) return null;
  const doc = app.active?.doc;
  const have = doc?.header.get(key);
  const known = HEADER_CODE.has(key) || key in DEFAULT_HEADER;
  if (have === undefined && !known) return null;
  const value = have ?? DEFAULT_HEADER[key];
  return { name, source: 'header', kind: headerKind(name, value), value, readOnly: READONLY_HEADER.has(name) || !doc, desc: DESC[name] ?? '' };
}

/** 값을 프롬프트·목록 꼴로 */
export function sysvarText(v: HeaderValue | undefined, kind?: SysvarKind): string {
  if (v === undefined) return '';
  if (typeof v === 'object') {
    const f = (x: number) => String(+x.toFixed(4));
    return 'z' in v ? `${f(v.x)},${f(v.y)},${f((v as Vec3).z)}` : `${f(v.x)},${f(v.y)}`;
  }
  if (typeof v === 'number') return kind === 'real' && Number.isInteger(v) ? v.toFixed(4) : String(+v.toFixed(6));
  return `"${v}"`;
}

/** 모든 변수(이름 순): 세션·이 브라우저·지금 도면의 머리말과 알려진 머리말 변수 */
export function listSysvars(app: App): SysvarInfo[] {
  const names = new Set<string>([...SESSION_RW, ...SESSION_RO, ...BROWSER_VARS.map((v) => v.name)]);
  for (const k of app.active?.doc.header.keys() ?? []) if (k.startsWith('$')) names.add(k.slice(1));
  for (const [k] of HEADER_VARS) names.add(k.slice(1));
  const out: SysvarInfo[] = [];
  for (const n of names) {
    const i = sysvarInfo(app, n);
    if (i) out.push(i);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function parsePoint(t: string, is3: boolean): Vec2 | Vec3 | null {
  const m = t.split(',').map((s) => Number(s.trim()));
  if ((m.length !== 2 && m.length !== 3) || m.some((x) => !Number.isFinite(x))) return null;
  return is3 ? { x: m[0]!, y: m[1]!, z: m[2] ?? 0 } : { x: m[0]!, y: m[1]! };
}

/**
 * 글로 받은 새 값을 적용한다. 바꾸면(또는 같으면) null, 거절하면 AutoCAD식 문구.
 * 도면 변수는 명령 취소 한 단계(label = 변수 이름)
 */
export function setSysvarText(app: App, raw: string, text: string): string | null {
  const info = sysvarInfo(app, raw);
  if (!info) return '알 수 없는 변수 이름입니다.';
  if (info.readOnly) return `${info.name} 변수는 읽기 전용입니다.`;
  const t = text.trim().replace(/^"(.*)"$/, '$1');
  const n = info.name;
  if (info.source === 'browser') {
    const v = Number(t);
    if (!/^[-+]?\d+$/.test(t)) return `${browserVar(n)!.min}과(와) ${browserVar(n)!.max} 사이의 정수가 필요합니다.`;
    const err = setBrowserSysvar(n, v);
    if (err) return err;
    if (n === 'PICKBOX' && app.view?.overlay) {
      app.view.overlay.pickbox = v;
      app.view.requestOverlay?.();
    }
    return null;
  }
  if (info.source === 'session') {
    const num = Number(t);
    if (!Number.isInteger(num)) return '정수가 필요합니다.';
    const r = setSysVar(app, n, num);
    return r === null ? null : r ? `${r}.` : '값이 맞지 않습니다.';
  }
  // 도면 변수
  const st = app.active!;
  const key = `$${n}`;
  const cur = st.doc.header.get(key);
  let after: HeaderValue;
  switch (info.kind) {
    case 'int':
    case 'bool': {
      if (!/^[-+]?\d+$/.test(t)) return '정수가 필요합니다.';
      const v = Number(t);
      const vals = INT_VALUES[n];
      const [lo, hi] = info.kind === 'bool' ? [0, 1] : (INT_RANGE[n] ?? [-32768, 32767]);
      if (vals ? !vals.includes(v) : v < lo || v > hi) return vals ? `값이 맞지 않습니다(${vals.join(', ')} 가운데 하나).` : `${lo}과(와) ${hi} 사이의 정수가 필요합니다.`;
      after = v;
      break;
    }
    case 'real': {
      const v = Number(t);
      if (!t || !Number.isFinite(v)) return '실수가 필요합니다.';
      if (POSITIVE_REAL.has(n) && !(v > 0)) return '값은 양수이고 0이 아니어야 합니다.';
      after = v;
      break;
    }
    case 'point': {
      const is3 = cur !== undefined ? typeof cur === 'object' && 'z' in cur : (HEADER_VARS.find(([k]) => k === key)?.[2] ?? 2) === 3;
      const p = parsePoint(t, is3);
      if (!p) return '점(x,y)이 필요합니다.';
      after = p;
      break;
    }
    default: {
      const doc = st.doc;
      const nameIn = (m: Map<string, { name: string }>, what: string): string | null => (m.has(tableKey(t)) ? m.get(tableKey(t))!.name : `${what} "${t}"이(가) 없습니다.`);
      if (n === 'CLAYER') {
        const r = nameIn(doc.layers, '도면층');
        if (!doc.layers.has(tableKey(t))) return r;
        after = r!;
      } else if (n === 'TEXTSTYLE' || n === 'DIMTXSTY') {
        if (!doc.textStyles.has(tableKey(t))) return nameIn(doc.textStyles, '문자 스타일');
        after = doc.textStyles.get(tableKey(t))!.name;
      } else if (n === 'DIMSTYLE') {
        if (!doc.dimStyles.has(tableKey(t))) return nameIn(doc.dimStyles, '치수 스타일');
        after = doc.dimStyles.get(tableKey(t))!.name;
      } else if (n === 'CELTYPE') {
        if (!/^(bylayer|byblock|continuous)$/i.test(t) && !doc.linetypes.has(tableKey(t))) return `선종류 "${t}"이(가) 없습니다.`;
        after = doc.linetypes.get(tableKey(t))?.name ?? t;
      } else after = t;
    }
  }
  if (JSON.stringify(after) === JSON.stringify(cur)) return null;
  st.session.commit({ label: n, ops: [{ kind: 'header', name: key, before: cur, after }] });
  app.ui?.refreshStatus?.();
  return null;
}

/** 명령행 프롬프트: `이름에 대한 새 값 입력 <값>:`(읽기 전용은 값만). 잘못된 값은 알리고 다시 묻는다 */
export async function promptSysvar(app: App, ctx: CommandContext, raw: string, arg?: string): Promise<void> {
  const info = sysvarInfo(app, raw);
  if (!info) {
    ctx.print('알 수 없는 변수 이름입니다.', 'err');
    return;
  }
  if (info.source === 'header' && !app.active) {
    ctx.print('열린 도면이 없습니다. 먼저 파일을 여십시오.', 'err');
    return;
  }
  if (info.readOnly) {
    ctx.print(`${info.name} = ${sysvarText(info.value, info.kind)} (읽기 전용)`);
    return;
  }
  let pending = arg;
  for (;;) {
    const cur = sysvarInfo(app, info.name)!;
    let text: string;
    if (pending !== undefined && pending !== '') {
      text = pending;
      pending = undefined;
    } else {
      const r = await ctx.getPoint(`${info.name}에 대한 새 값 입력 <${sysvarText(cur.value, cur.kind)}>:`, { allowText: true, preferNumber: true });
      if ('enter' in r) return;
      if ('point' in r) text = `${r.point.x},${r.point.y}`;
      else if ('text' in r) text = r.text;
      else return;
    }
    const err = setSysvarText(app, info.name, text);
    if (!err) return;
    ctx.print(err, 'err');
  }
}

// ---------------------------------------------------------------------------
// SYSVDLG
// ---------------------------------------------------------------------------

async function sysvdlg(app: App, ctx: CommandContext): Promise<void> {
  ensureMgrStyle();
  const search = textIn('', '검색');
  search.placeholder = '이름 또는 설명 검색';
  const onlyChanged = checkIn(false, '바뀐 변수만');
  const edit = textIn('', '값');
  const info = h('div', { class: 'mgr-note' });
  const err = h('div', { class: 'mgr-err' });
  let rows: SysvarInfo[] = [];
  const srcLabel: Record<SysvarSource, string> = { session: '세션', browser: '이 브라우저', header: '도면' };
  const list = pickList<SysvarInfo>(['이름', '값', '저장 위치', '설명'], (r) => [r.name, sysvarText(r.value, r.kind), srcLabel[r.source], r.desc], {
    height: 320,
    rowClass: (r) => (r.readOnly ? 'ro' : ''),
    onPick: (r) => {
      err.textContent = '';
      if (!r) {
        info.textContent = '';
        edit.value = '';
        edit.disabled = true;
        return;
      }
      edit.disabled = r.readOnly;
      edit.value = sysvarText(r.value, r.kind).replace(/^"(.*)"$/, '$1');
      info.textContent = `${r.name}${r.readOnly ? ' (읽기 전용)' : ''} — ${r.desc || '설명 없음'}`;
    },
    onActivate: () => edit.focus(),
  });
  const defOf = (r: SysvarInfo): HeaderValue | undefined => (r.source === 'browser' ? browserVar(r.name)?.def : r.source === 'header' ? DEFAULT_HEADER[`$${r.name}`] : undefined);
  const refresh = () => {
    const q = search.value.trim().toUpperCase();
    rows = listSysvars(app).filter((r) => (!q || r.name.includes(q) || r.desc.includes(search.value.trim())) && (!onlyChanged.checked || (defOf(r) !== undefined && JSON.stringify(defOf(r)) !== JSON.stringify(r.value))));
    const sel = list.selected()?.name;
    list.refresh(rows, sel ? (r) => r.name === sel : undefined);
  };
  search.addEventListener('input', refresh);
  onlyChanged.addEventListener('change', refresh);
  const apply = () => {
    const r = list.selected();
    if (!r) return;
    const e = setSysvarText(app, r.name, edit.value);
    err.textContent = e ?? '';
    if (!e) {
      ctx.print(`${r.name} = ${sysvarText(sysvarInfo(app, r.name)?.value, r.kind)}`);
      refresh();
    }
  };
  edit.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      apply();
    }
  });
  const body = h(
    'div',
    { class: 'mgr-dlg' },
    h('div', { class: 'mgr-inline' }, search, h('label', { class: 'mgr-inline' }, onlyChanged, '바뀐 변수만')),
    list.el,
    info,
    h('div', { class: 'mgr-inline' }, edit, btn('값 설정', apply)),
    err,
    h('div', { class: 'mgr-note' }, '도면 변수는 도면과 함께 저장되고 명령 취소로 되돌릴 수 있습니다. 이 브라우저 변수는 이 컴퓨터의 이 브라우저에만 보관됩니다.'),
  );
  refresh();
  await resultDialog('시스템 변수', body, { ok: '닫기', cancel: null, width: 760, submit: () => true });
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

export function registerSysvarCommands(app: App): void {
  // 변수 이름을 처음 치면 그 이름의 투명 명령으로 등록해 실행한다(명령 기록·자동 완성에 "명령: PDMODE"로 남는다)
  addHook(app.commandFallbacks, {
    name: 'sysvars',
    async run(name, arg) {
      if (!sysvarInfo(app, name)) return false;
      const n = name.toUpperCase().replace(/^\$/, '');
      if (!app.commands.has(n))
        app.register({ name: n, title: `시스템 변수 ${n}`, transparent: true, noDoc: true, run: (ctx, a) => promptSysvar(app, ctx, n, a) });
      await app.run(n, arg);
      return true;
    },
  });
  app.register({ name: 'SYSVDLG', title: '시스템 변수', noDoc: true, run: (ctx) => sysvdlg(app, ctx) });
  // PICKBOX를 정했으면 화면 선택 상자에 반영
  if (prefGet(PREFIX + 'PICKBOX') !== null && app.view?.overlay) app.view.overlay.pickbox = browserSysvar('PICKBOX');
}
