/**
 * 앱과 잇는 AutoLISP 함수: 입력(getpoint getcorner getdist getangle getorient getreal getint getstring getkword initget entsel
 * nentsel nentselp), 명령(command command-s vl-cmdf), 변수(getvar setvar), 객체(entget entmod entmake entmakex entdel entnext
 * entlast handent entupd textbox), 확장 데이터(regapp xdsize xdroom, entget·entmod·entmake의 -3), 사전(namedobjdict dictsearch
 * dictnext dictadd dictremove dictrename), 선택 세트(ssget — W·C·WP·CP·F·X·L·P·I 포함 — ssname sslength ssadd ssdel ssmemb
 * sssetfirst ssgetfirst), 표(tblsearch tblnext tblobjname layoutlist), trans, osnap, 임시 그림(grdraw grvecs redraw), alert, load,
 * findfile, 이번 세션에 연 파일 정보(vl-file-size vl-file-systime vl-file-directory-p).
 * 파일 쓰기·외부 실행·ActiveX·대화상자(DCL)는 만들지 않고 "이 웹 버전에서는 쓸 수 없습니다"로 알린다.
 */
import { MODEL_SPACE, normalizeHandle, tableKey, type Vec3 } from '../../core/model';
import { ocsToWcs, wcsToOcs } from '../geom/ocs';
import { isPoint, num, point, ptList, str } from './core';
import { allMain, entdel, entget, entlast, entmake, entmod, entnext, exists, filterHandles, readPairs } from './entity';
import { DictCursor, XD_LIMIT, appList, dictAdd, dictLookup, dictRemove, dictRename, findTableRecord, objectOf, recordXData, regApp, rootDictHandle, tableEntries, tableObjHandle, xdataSize, xdsizeArg } from './objects';
import { nestedPick } from './nested';
import type { AskOptions, AskResult, LispDrawing, LispHost, Pt2 } from './host';
import type { Interp } from './interp';
import { badType, badValue, prin1 } from './printer';
import { EOF, LispReader } from './reader';
import { angtof, distof } from './text';
import { Cons, Ename, Ev, type Gen, LispError, LispFile, MSG, PickSet, Real, fromArray, isNum, numOf, toArray, type Value } from './types';

interface Kw {
  /** 고를 때 돌려줄 이름(국제 이름이 있으면 그것) */
  value: string;
  /** 전체 이름(대문자) */
  full: string;
  /** 줄임(대문자) */
  abbr: string;
}

/** initget 키워드 글: "Yes No _Yes No", "LType Width", "Ltype,LT" */
export function parseKeywords(s: string): Kw[] {
  const words = s.trim().split(/\s+/).filter(Boolean);
  const cut = words.findIndex((w) => w.startsWith('_'));
  const local = cut < 0 ? words : words.slice(0, cut);
  const global = cut < 0 ? [] : [words[cut]!.slice(1), ...words.slice(cut + 1)];
  return local.map((w, i) => {
    let full = w;
    let abbr: string;
    const comma = w.indexOf(',');
    if (comma >= 0) {
      full = w.slice(0, comma);
      abbr = w.slice(comma + 1).toUpperCase();
    } else {
      const caps = /[A-Z0-9]+/.exec(w);
      abbr = caps ? caps[0] : w.toUpperCase();
      if (caps && w.indexOf(caps[0]) > 0) abbr = w.slice(0, w.indexOf(caps[0]) + caps[0].length).toUpperCase();
    }
    const g = global[i];
    return { value: g ?? full, full: full.toUpperCase(), abbr };
  });
}

/** 입력이 키워드인가(줄임 이상, 전체 이름 이하. _는 국제 이름) */
export function matchKw(text: string, kws: Kw[]): string | null {
  const t = text.trim().toUpperCase();
  if (!t) return null;
  if (t.startsWith('_')) {
    const g = t.slice(1);
    return kws.find((k) => k.value.toUpperCase() === g || k.full === g)?.value ?? null;
  }
  return kws.find((k) => t.startsWith(k.abbr) && k.full.startsWith(t))?.value ?? kws.find((k) => k.full === t || k.abbr === t)?.value ?? null;
}

const NO_NULL = 1;
const NO_ZERO = 2;
const NO_NEG = 4;
const ANY = 128;

export function installHost(it: Interp, host: LispHost): void {
  const def = it.def.bind(it);
  let init: { bits: number; kws: Kw[] } = { bits: 0, kws: [] };

  const web = (name: string) =>
    def(name, 0, -1, () => {
      throw new LispError(`${name.toUpperCase()}: ${MSG.web}`);
    });
  for (const n of [
    'STARTAPP',
    'GETFILED',
    'WRITE-LINE',
    'WRITE-CHAR',
    'VL-MKDIR',
    'VL-DIRECTORY-FILES',
    'VL-FILENAME-MKTEMP',
    'SETENV',
    'SETCFG',
    'GRREAD',
    'LOAD_DIALOG',
    'NEW_DIALOG',
    'START_DIALOG',
    'DONE_DIALOG',
    'UNLOAD_DIALOG',
    'ACTION_TILE',
    'SET_TILE',
    'GET_TILE',
    'MODE_TILE',
    'START_LIST',
    'ADD_LIST',
    'END_LIST',
    'ACAD_COLORDLG',
    'ACAD_TRUECOLORDLG',
    'ACAD_HELPDLG',
    'ARXLOAD',
    'ARXUNLOAD',
    'AUTOARXLOAD',
    'VL-VBALOAD',
    'VL-VBARUN',
    'VLAX-GET-ACAD-OBJECT',
    'VLAX-ENAME->VLA-OBJECT',
    'VLAX-CREATE-OBJECT',
    'VLAX-GET-OR-CREATE-OBJECT',
  ])
    web(n);

  const drawing = (): LispDrawing => {
    const d = host.drawing();
    if (!d) throw new LispError('열린 도면이 없습니다');
    return d;
  };
  const enameArg = (v: Value): Ename => {
    if (v instanceof Ename) return v;
    throw badType('lentityp', v);
  };
  const ssArg = (v: Value): PickSet => {
    if (v instanceof PickSet) return v;
    throw badType('lselsetp', v);
  };

  // ----------------------------------------------------------------- 입력
  def('INITGET', 0, 2, ([a, b]) => {
    let bits = 0;
    let kws: Kw[] = [];
    for (const x of [a, b]) {
      if (x === undefined || x === null) continue;
      if (typeof x === 'number') bits = x;
      else if (typeof x === 'string') kws = parseKeywords(x);
      else throw badType('stringp', x);
    }
    init = { bits, kws };
    return null;
  });

  /** 프롬프트 글: 인수가 없으면 출력 중인 줄(prompt로 찍어 둔 것) */
  const promptOf = (msg: Value | undefined, def0: string): string => {
    const pending = it.takeLine();
    if (msg !== undefined && msg !== null) {
      if (pending.trim()) it.opts.print(pending.replace(/^[\r\n]+/, ''));
      return str(msg).replace(/^[\r\n]+/, '').replace(/\n/g, ' ').trimEnd();
    }
    return pending.replace(/^[\r\n]+/, '').trimEnd() || def0;
  };

  const ucsPt = (p: Pt2, z = 0) => ptList(p.x, p.y, z);
  const note = (text: string) => {
    it.flush();
    it.opts.print(text);
  };

  /** 점·글 하나 묻기(취소는 함수 취소) */
  const ask = async (kind: 'point' | 'entity', prompt: string, opt: AskOptions): Promise<AskResult> => {
    it.flush();
    it.checkCancel();
    return host.ask(kind, prompt, opt);
  };

  /** get* 공통: 입력 하나를 해석한다. retry면 다시 묻는다 */
  async function getLoop(prompt: string, opt: AskOptions, take: (r: AskResult) => Promise<Value | 'retry'> | Value | 'retry'): Promise<Value> {
    const cur = init;
    init = { bits: 0, kws: [] };
    for (;;) {
      const r = await ask('point', prompt, opt);
      if ('enter' in r) {
        if (cur.bits & NO_NULL) {
          note('값을 입력해야 합니다.');
          continue;
        }
        return null;
      }
      if ('text' in r || 'keyword' in r) {
        const text = 'text' in r ? r.text : r.keyword;
        const kw = matchKw(text, cur.kws);
        if (kw !== null) return kw;
      }
      const v = await take(r);
      if (v === 'retry') {
        if ((cur.bits & ANY) && 'text' in r) return r.text;
        continue;
      }
      if (isNum(v)) {
        const n = numOf(v);
        if (cur.bits & NO_ZERO && n === 0) {
          note('값은 0이 아니어야 합니다.');
          continue;
        }
        if (cur.bits & NO_NEG && n < 0) {
          note('값은 음수가 아니어야 합니다.');
          continue;
        }
      }
      return v;
    }
  }

  /** (getxxx [pt] [msg]) 인수 */
  const ptMsg = (a: Value[]): { base: Value; msg: Value | undefined } => {
    if (a.length && (typeof a[0] === 'string' || a[0] === null) && a.length === 1) return { base: null, msg: a[0] };
    return { base: a[0] ?? null, msg: a[1] };
  };

  def('GETPOINT', 0, 2, (a) => {
    const { base, msg } = ptMsg(a);
    const b = base !== null ? point(base) : null;
    const prompt = promptOf(msg, '점 지정:');
    return getLoop(prompt, { base: b, rubber: b ? 'line' : null }, (r) => {
      if ('point' in r) return ucsPt(r.point, b?.z ?? 0);
      note('점이 필요합니다.');
      return 'retry';
    });
  });
  def('GETCORNER', 1, 2, ([base, msg]) => {
    const b = point(base!);
    const prompt = promptOf(msg, '반대 구석 지정:');
    return getLoop(prompt, { base: b, rubber: 'rect' }, (r) => {
      if ('point' in r) return ucsPt(r.point, b.z);
      note('점이 필요합니다.');
      return 'retry';
    });
  });
  const second = async (b: Pt2, prompt: string): Promise<Pt2 | null> => {
    for (;;) {
      const r = await ask('point', prompt, { base: b, rubber: 'line' });
      if ('point' in r) return r.point;
      if ('enter' in r) return null;
      note('점이 필요합니다.');
    }
  };
  def('GETDIST', 0, 2, (a) => {
    const { base, msg } = ptMsg(a);
    const b = base !== null ? point(base) : null;
    const prompt = promptOf(msg, '거리 지정:');
    return getLoop(prompt, { base: b, rubber: b ? 'line' : null, preferNumber: true }, async (r) => {
      if ('text' in r) {
        const d = distof(r.text);
        if (d !== null) return new Real(d);
        note('거리 또는 두 점이 필요합니다.');
        return 'retry';
      }
      if ('point' in r) {
        const p0 = b ?? r.point;
        const p1 = b ? r.point : await second(r.point, '두 번째 점 지정:');
        if (!p1) return null;
        return new Real(Math.hypot(p1.x - p0.x, p1.y - p0.y));
      }
      return 'retry';
    });
  });
  const angleInput = (absolute: boolean) => (a: Value[]) => {
    const { base, msg } = ptMsg(a);
    const b = base !== null ? point(base) : null;
    const prompt = promptOf(msg, '각도 지정:');
    const aunits = numVar('AUNITS', 0);
    const angbase = numVar('ANGBASE', 0);
    return getLoop(prompt, { base: b, rubber: b ? 'line' : null, preferNumber: true }, async (r) => {
      if ('text' in r) {
        const v = angtof(r.text, aunits);
        if (v === null) {
          note('각도 또는 두 점이 필요합니다.');
          return 'retry';
        }
        // 입력한 각도는 ANGBASE에서 잰다: getorient는 절대 각도로
        return new Real(norm(absolute ? v + angbase : v));
      }
      if ('point' in r) {
        const p0 = b ?? r.point;
        const p1 = b ? r.point : await second(r.point, '두 번째 점 지정:');
        if (!p1) return null;
        const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        return new Real(norm(absolute ? ang : ang - angbase));
      }
      return 'retry';
    });
  };
  def('GETANGLE', 0, 2, angleInput(false));
  def('GETORIENT', 0, 2, angleInput(true));
  def('GETREAL', 0, 1, ([msg]) => {
    const prompt = promptOf(msg, '실수 입력:');
    return getLoop(prompt, { preferNumber: true }, (r) => {
      if ('text' in r && /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(r.text)) return new Real(Number(r.text));
      note('실수가 필요합니다.');
      return 'retry';
    });
  });
  def('GETINT', 0, 1, ([msg]) => {
    const prompt = promptOf(msg, '정수 입력:');
    return getLoop(prompt, { preferNumber: true }, (r) => {
      if ('text' in r && /^\s*[-+]?\d+\s*$/.test(r.text)) {
        const n = Number(r.text);
        if (n >= -32768 && n <= 32767) return n;
      }
      note('-32768과 32767 사이의 정수가 필요합니다.');
      return 'retry';
    });
  });
  def('GETSTRING', 0, 2, (a) => {
    const cr = a.length >= 2 ? a[0] : typeof a[0] === 'string' ? null : (a[0] ?? null);
    const msg = a.length >= 2 ? a[1] : typeof a[0] === 'string' ? a[0] : undefined;
    const prompt = promptOf(msg, '문자열 입력:');
    init = { bits: 0, kws: [] };
    return (async () => {
      const r = await ask('point', prompt, { spaces: cr !== null && cr !== undefined, preferNumber: true });
      if ('text' in r) return r.text;
      if ('keyword' in r) return r.keyword;
      if ('point' in r) return `${+r.point.x.toPrecision(12)},${+r.point.y.toPrecision(12)}`;
      return '';
    })();
  });
  def('GETKWORD', 0, 1, ([msg]) => {
    const prompt = promptOf(msg, '옵션 입력:');
    return getLoop(prompt, { preferNumber: true }, () => {
      note('잘못된 옵션 키워드입니다.');
      return 'retry';
    });
  });
  def('ENTSEL', 0, 1, async ([msg]) => {
    const prompt = promptOf(msg, '객체 선택:');
    const cur = init;
    init = { bits: 0, kws: [] };
    for (;;) {
      const r = await ask('entity', prompt, {});
      if ('entity' in r) return fromArray([it.ename(r.entity), ptList(r.point.x, r.point.y, 0)]);
      if ('enter' in r) return null;
      const text = 'text' in r ? r.text : 'keyword' in r ? r.keyword : '';
      const kw = matchKw(text, cur.kws);
      if (kw !== null) return kw;
      if (cur.bits & ANY && text) return text;
      note('객체를 선택하십시오.');
    }
  });

  /** nentsel·nentselp 결과: 블록 안이면 (이름 점 행렬 (블록 참조…)), 아니면 (이름 점) */
  const nested = (h: string, pu: Pt2, selp: boolean): Value => {
    const d = host.drawing();
    const ptv = ptList(pu.x, pu.y, 0);
    if (!d) return fromArray([it.ename(h), ptv]);
    const u = host.ucs();
    const c = Math.cos(u.angle);
    const s = Math.sin(u.angle);
    const w = { x: u.ox + pu.x * c - pu.y * s, y: u.oy + pu.x * s + pu.y * c, z: 0 };
    const r = nestedPick(d.doc, h, w, host.pickTolerance());
    if (!r.matrix) return fromArray([it.ename(r.handle), ptv]);
    const m = r.matrix;
    const row = (...xs: number[]) => fromArray(xs.map((x) => new Real(x)));
    // nentsel: 네 줄(X·Y·Z축과 원점, 각 3개), nentselp: 4×4(열 벡터로 곱하는 행렬)
    const mat = selp ? fromArray([row(m[0]!, m[1]!, m[2]!, m[3]!), row(m[4]!, m[5]!, m[6]!, m[7]!), row(m[8]!, m[9]!, m[10]!, m[11]!), row(0, 0, 0, 1)]) : fromArray([row(m[0]!, m[4]!, m[8]!), row(m[1]!, m[5]!, m[9]!), row(m[2]!, m[6]!, m[10]!), row(m[3]!, m[7]!, m[11]!)]);
    return fromArray([it.ename(r.handle), ptv, mat, fromArray(r.chain.map((x) => it.ename(x)))]);
  };
  const nentAsk = async (msg: Value | undefined, selp: boolean): Promise<Value> => {
    const prompt = promptOf(msg, '객체 선택:');
    const cur = init;
    init = { bits: 0, kws: [] };
    for (;;) {
      const r = await ask('entity', prompt, {});
      if ('entity' in r) return nested(r.entity, r.point, selp);
      if ('enter' in r) return null;
      const text = 'text' in r ? r.text : 'keyword' in r ? r.keyword : '';
      const kw = matchKw(text, cur.kws);
      if (kw !== null) return kw;
      if (cur.bits & ANY && text) return text;
      note('객체를 선택하십시오.');
    }
  };
  def('NENTSEL', 0, 1, ([msg]) => nentAsk(msg, false));
  def('NENTSELP', 0, 2, (a) => {
    let msg: Value | undefined;
    let pt: Value | undefined;
    for (const x of a) {
      if (typeof x === 'string') msg = x;
      else if (x !== null && isPoint(x)) pt = x;
    }
    if (pt === undefined) return nentAsk(msg, true);
    // 점을 주면 묻지 않고 그 자리의 객체
    const p = point(pt);
    const h = host.pickAt(p);
    return h ? nested(h, p, true) : null;
  });

  // ----------------------------------------------------------------- 명령
  const cmd = (mode: 'command' | 'command-s' | 'vl-cmdf') => async (a: Value[]) => {
    it.flush();
    const r = await host.command(a, mode);
    it.checkCancel();
    return r;
  };
  def('COMMAND', 0, -1, cmd('command'));
  def('COMMAND-S', 0, -1, cmd('command-s'));
  def('VL-CMDF', 0, -1, cmd('vl-cmdf'));
  def('INITCOMMANDVERSION', 0, 1, () => null);
  for (const n of ['ACAD-PUSH-DBMOD', 'ACAD-POP-DBMOD', 'GRTEXT', 'MENUCMD', 'MENUGROUP', 'TEXTSCR', 'GRAPHSCR', 'TEXTPAGE']) def(n, 0, -1, () => null);

  // ----------------------------------------------------------------- 변수
  const numVar = (n: string, d: number): number => {
    const v = host.getvar(n);
    return typeof v === 'number' ? v : v instanceof Real ? v.v : d;
  };
  def('GETVAR', 1, 1, ([n]) => host.getvar(str(n!)) ?? null);
  def('SETVAR', 2, 2, ([n, v]) => {
    const name = str(n!);
    const err = host.setvar(name, v!);
    if (err !== null) throw new LispError(`AutoCAD 변수 설정 거부: ${prin1(name)} ${prin1(v!)}${err ? ` (${err})` : ''}`);
    return host.getvar(name) ?? v!;
  });
  def('GETENV', 1, 1, () => null);

  // ----------------------------------------------------------------- 객체
  def('ENTGET', 1, 2, ([e, apps]) => {
    const d = host.drawing();
    if (!d) return null;
    return entget(it, d, enameArg(e!).handle, appList(apps));
  });
  def('ENTMOD', 1, 1, ([l]) => entmod(it, drawing(), l!));
  def('ENTMAKE', 0, 1, ([l]) => entmake(drawing(), l ?? null));
  def('ENTMAKEX', 0, 1, ([l]) => {
    const d = drawing();
    const made = { h: '' };
    const r = entmake(d, l ?? null, (h) => (made.h = h));
    if (r === null) return null;
    if (made.h) return it.ename(made.h);
    const h = entlast(d);
    return h ? it.ename(h) : null;
  });
  def('ENTDEL', 1, 1, ([e]) => (entdel(drawing(), enameArg(e!).handle) ? e! : null));
  def('ENTNEXT', 0, 1, ([e]) => {
    const d = host.drawing();
    if (!d) return null;
    const h = entnext(d, e === undefined || e === null ? null : enameArg(e).handle);
    return h ? it.ename(h) : null;
  });
  def('ENTLAST', 0, 0, () => {
    const d = host.drawing();
    const h = d ? entlast(d) : null;
    return h ? it.ename(h) : null;
  });
  def('HANDENT', 1, 1, ([h]) => {
    const d = host.drawing();
    const k = normalizeHandle(str(h!));
    if (!d) return null;
    // 객체(블록 정의 안 포함)·비도형 객체·표 기록
    if (d.doc.entityIndex.has(k)) return exists(d, k) || d.session.ownerOf(k) ? it.ename(k) : null;
    if (d.doc.objects.has(k)) return it.ename(k);
    const t = findTableRecord(it, d.doc, k);
    return t ? it.ename(t.entry.handle) : null;
  });

  // ----------------------------------------------------------------- 확장 데이터
  def('REGAPP', 1, 1, ([n]) => {
    const name = str(n!);
    return regApp(drawing(), name) ? name : null;
  });
  def('XDSIZE', 1, 1, ([l]) => xdataSize(xdsizeArg(drawing().doc, l!)));
  def('XDROOM', 1, 1, ([e]) => {
    const d = host.drawing();
    if (!d) return null;
    const h = enameArg(e!).handle;
    const ent = d.doc.entityIndex.get(h);
    const obj = ent ? undefined : objectOf(d.doc, h);
    const rec = ent || obj ? undefined : findTableRecord(it, d.doc, h);
    if (!ent && !obj && !rec) return null;
    return XD_LIMIT - xdataSize((ent ?? obj)?.xdata ?? recordXData(it, d.doc, h) ?? []);
  });

  // ----------------------------------------------------------------- 사전
  const cursor = new DictCursor();
  def('NAMEDOBJDICT', 0, 0, () => {
    const d = host.drawing();
    const h = d ? rootDictHandle(d.doc) : null;
    return h ? it.ename(h) : null;
  });
  def('DICTSEARCH', 2, 3, ([e, n, setnext]) => {
    const d = host.drawing();
    if (!d) return null;
    const dh = enameArg(e!).handle;
    const name = str(n!);
    const h = dictLookup(d.doc, dh, name);
    if (!h) return null;
    if (setnext !== undefined && setnext !== null) cursor.after(d.doc, dh, name);
    return entget(it, d, h);
  });
  def('DICTNEXT', 1, 2, ([e, rewind]) => {
    const d = host.drawing();
    if (!d) return null;
    const h = cursor.next(d.doc, enameArg(e!).handle, rewind !== undefined && rewind !== null);
    return h ? entget(it, d, h) : null;
  });
  def('DICTADD', 3, 3, ([e, n, o]) => (dictAdd(drawing(), enameArg(e!).handle, str(n!), enameArg(o!).handle) ? o! : null));
  def('DICTREMOVE', 2, 2, ([e, n]) => {
    const h = dictRemove(drawing(), enameArg(e!).handle, str(n!));
    return h ? it.ename(h) : null;
  });
  def('DICTRENAME', 3, 3, ([e, a, b]) => (dictRename(drawing(), enameArg(e!).handle, str(a!), str(b!)) ? b! : null));

  // ----------------------------------------------------------------- 문자 상자
  def('TEXTBOX', 1, 1, ([l]) => {
    const pairs = readPairs(l!);
    const get = (c: number) => pairs.find(([k]) => k === c)?.[1];
    const type = get(0);
    if (typeof type === 'string' && !/^(TEXT|ATTRIB|ATTDEF)$/i.test(type)) return null;
    const text = get(1);
    if (typeof text !== 'string') return null;
    const d = host.drawing();
    const sv = get(7);
    const styleName = typeof sv === 'string' ? sv : (() => {
      const v = host.getvar('TEXTSTYLE');
      return typeof v === 'string' ? v : 'Standard';
    })();
    const style = d?.doc.textStyles.get(tableKey(styleName));
    const nOr = (c: number, dv: number) => {
      const v = get(c);
      return v !== undefined && isNum(v) ? numOf(v) : dv;
    };
    const height = nOr(40, style && style.height > 0 ? style.height : numVar('TEXTSIZE', 2.5));
    const spec = { text, height, style: style?.name ?? styleName, widthFactor: nOr(41, style?.widthFactor || 1), oblique: nOr(51, style?.oblique ?? 0), generation: Math.trunc(nOr(71, style?.generation ?? 0)) };
    // 배치 엔진이 없으면 글자 수로 어림한다
    const b = host.textBox(spec) ?? { x0: 0, y0: 0, x1: text.length * height * spec.widthFactor * 0.85, y1: height };
    return fromArray([ptList(b.x0, b.y0, 0), ptList(b.x1, b.y1, 0)]);
  });
  def('ENTUPD', 1, 1, ([e]) => enameArg(e!));

  // ----------------------------------------------------------------- 선택 세트
  const liveSet = (d: LispDrawing, hs: string[]): Value => {
    const top = new Set(allMain(d));
    const out = [...new Set(hs)].filter((h) => top.has(h));
    if (!out.length) return null;
    host.setPrevious(out);
    return it.pickSet(out);
  };
  def('SSGET', 0, 4, async (a) => {
    const d = drawing();
    let mode = '';
    let rest = a;
    if (typeof a[0] === 'string') {
      mode = a[0].replace(/^[_+.]+/, '').toUpperCase();
      rest = a.slice(1);
    }
    const filterArg = (v: Value | undefined) => (v !== undefined && v !== null && toArray(v)?.every((p) => p instanceof Cons && typeof p.car === 'number') ? v : null);
    const done = (hs: string[], f: Value | undefined) => liveSet(d, filterHandles(it, d, hs, filterArg(f)));
    it.flush();
    if (!mode && rest.length && isPoint(rest[0]!)) {
      const p = point(rest[0]!);
      const h = host.pickAt(p);
      return done(h ? [h] : [], rest[1]);
    }
    switch (mode) {
      case '':
      case ':S':
      case ':E':
      case ':S:E':
      case ':E:S':
      case ':L': {
        const prompt = it.takeLine().replace(/^[\r\n]+/, '') || '객체 선택:';
        const hs = await host.select(prompt, mode.includes('S'));
        return done(hs, rest[0]);
      }
      case 'X':
      case 'A':
        return done(allMain(d), rest[0]);
      case 'L': {
        const h = entlast(d);
        return done(h ? [h] : [], rest[0]);
      }
      case 'P':
        return done(host.previous(), rest[0]);
      case 'I':
        return done(host.implied(), rest[0]);
      case 'W':
      case 'C': {
        const p1 = point(rest[0] ?? null);
        const p2 = point(rest[1] ?? null);
        return done(host.selectWindow(p1, p2, mode === 'C'), rest[2]);
      }
      case 'WP':
      case 'CP':
      case 'F': {
        const pts = toArray(rest[0] ?? null);
        if (!pts || !pts.length) throw badType('listp', rest[0] ?? null);
        const ps = pts.map((x) => point(x));
        if (mode !== 'F' && ps.length < 3) throw badValue('폴리곤 점은 3개 이상이어야 함', rest[0]!);
        if (mode === 'F' && ps.length < 2) throw badValue('울타리 점은 2개 이상이어야 함', rest[0]!);
        return done(mode === 'F' ? host.selectFence(ps) : host.selectPolygon(ps, mode === 'CP'), rest[1]);
      }
      default:
        throw new LispError(`SSGET: 선택 방식 "${mode}"은(는) ${MSG.web}`);
    }
  });
  def('SSNAME', 2, 2, ([s, i]) => {
    const set = ssArg(s!);
    const k = typeof i === 'number' ? i : Math.trunc(num(i!));
    const h = set.handles[k];
    return h === undefined || k < 0 ? null : it.ename(h);
  });
  def('SSLENGTH', 1, 1, ([s]) => ssArg(s!).handles.length);
  def('SSADD', 0, 2, ([e, s]) => {
    if (e === undefined || e === null) return it.pickSet([]);
    const h = enameArg(e).handle;
    if (s === undefined || s === null) return it.pickSet([h]);
    const set = ssArg(s);
    if (!set.handles.includes(h)) set.handles.push(h);
    return set;
  });
  def('SSDEL', 2, 2, ([e, s]) => {
    const set = ssArg(s!);
    const h = enameArg(e!).handle;
    const i = set.handles.indexOf(h);
    if (i < 0) return null;
    set.handles.splice(i, 1);
    return set;
  });
  def('SSMEMB', 2, 2, ([e, s]) => (ssArg(s!).handles.includes(enameArg(e!).handle) ? e! : null));
  def('SSSETFIRST', 1, 2, ([g, s]) => {
    const hs = s === undefined || s === null ? [] : ssArg(s).handles;
    host.setImplied(hs);
    return fromArray([g ?? null, s ?? null]);
  });
  def('SSGETFIRST', 0, 0, () => {
    const hs = host.implied();
    return fromArray([null, hs.length ? it.pickSet(hs) : null]);
  });

  // ----------------------------------------------------------------- 표
  const tblIter = new Map<string, number>();
  const tableList = (d: LispDrawing, table: string) => {
    const l = tableEntries(it, d.doc, table);
    if (!l) throw badValue('표 이름', table);
    return l;
  };
  const tblData = (table: string, x: { fields: () => [number, Value][] }) => fromArray([new Cons(0, table), ...x.fields().map(([c, v]) => new Cons(c, v))]);
  def('TBLSEARCH', 2, 3, ([t, n, next]) => {
    const d = host.drawing();
    if (!d) return null;
    const table = str(t!).toUpperCase();
    const list = tableList(d, table);
    const i = list.findIndex((x) => tableKey(x.name) === tableKey(str(n!)));
    if (i < 0) return null;
    if (next !== undefined && next !== null) tblIter.set(table, i + 1);
    return tblData(table, list[i]!);
  });
  def('TBLNEXT', 1, 2, ([t, rewind]) => {
    const d = host.drawing();
    if (!d) return null;
    const table = str(t!).toUpperCase();
    const list = tableList(d, table);
    const i = rewind !== undefined && rewind !== null ? 0 : (tblIter.get(table) ?? 0);
    if (i >= list.length) return null;
    tblIter.set(table, i + 1);
    return tblData(table, list[i]!);
  });
  def('TBLOBJNAME', 2, 2, ([t, n]) => {
    const d = host.drawing();
    if (!d) return null;
    const table = str(t!).toUpperCase();
    if (!tableEntries(it, d.doc, table)) throw badValue('표 이름', table);
    const h = tableObjHandle(it, d.doc, table, str(n!));
    return h ? it.ename(h) : null;
  });
  def('LAYOUTLIST', 0, 0, () => {
    const d = host.drawing();
    if (!d) return null;
    return fromArray([...d.doc.layouts].sort((a, b) => a.tabOrder - b.tabOrder).filter((l) => tableKey(l.blockName) !== MODEL_SPACE).map((l) => l.name));
  });

  // ----------------------------------------------------------------- 좌표 변환
  /** from/to 인수 → 좌표계 */
  type Cs = { kind: 'wcs' } | { kind: 'ucs' } | { kind: 'ocs'; ext: Vec3 };
  const csOf = (v: Value): Cs => {
    if (typeof v === 'number') {
      if (v === 0 || v === 2 || v === 3) return { kind: 'wcs' };
      if (v === 1) return { kind: 'ucs' };
      throw badValue('좌표계 코드', v);
    }
    if (v instanceof Ename) {
      const d = host.drawing();
      const e = d?.doc.entityIndex.get(v.handle);
      return { kind: 'ocs', ext: e?.extrusion ?? { x: 0, y: 0, z: 1 } };
    }
    if (isPoint(v)) {
      const p = point(v);
      return { kind: 'ocs', ext: { x: p.x, y: p.y, z: p.z } };
    }
    throw badType('좌표계', v);
  };
  def('TRANS', 3, 4, ([p, from, to, disp]) => {
    const pt = point(p!);
    const isDisp = disp !== undefined && disp !== null;
    const u = host.ucs();
    const c = Math.cos(u.angle);
    const s = Math.sin(u.angle);
    const toW = (q: Vec3, cs: Cs): Vec3 => {
      if (cs.kind === 'ucs') return { x: (isDisp ? 0 : u.ox) + q.x * c - q.y * s, y: (isDisp ? 0 : u.oy) + q.x * s + q.y * c, z: q.z };
      if (cs.kind === 'ocs') return ocsToWcs(q, cs.ext);
      return q;
    };
    const fromW = (q: Vec3, cs: Cs): Vec3 => {
      if (cs.kind === 'ucs') {
        const dx = q.x - (isDisp ? 0 : u.ox);
        const dy = q.y - (isDisp ? 0 : u.oy);
        return { x: dx * c + dy * s, y: -dx * s + dy * c, z: q.z };
      }
      if (cs.kind === 'ocs') return wcsToOcs(q, cs.ext);
      return q;
    };
    const r = fromW(toW({ x: pt.x, y: pt.y, z: pt.z }, csOf(from!)), csOf(to!));
    return pt.dims === 3 ? ptList(r.x, r.y, r.z) : ptList(r.x, r.y);
  });

  // ----------------------------------------------------------------- 기타
  def('ALERT', 1, 1, ([m]) => {
    it.flush();
    host.alert(str(m!));
    return null;
  });
  def('LOAD', 1, 2, function* (a): Gen {
    const name = str(a[0]!);
    const text = yield host.findFile(name).then((f) => (f ? f.text : null));
    if (typeof text !== 'string') {
      if (a.length > 1) return a[1]!;
      throw new LispError(`LOAD 실패: ${prin1(name)}`);
    }
    const reader = new LispReader(text, it.syms);
    let v: Value = null;
    for (;;) {
      const f = reader.read();
      if (f === EOF) return v;
      v = yield new Ev(f);
    }
  });
  def('FINDFILE', 1, 1, async ([n]) => {
    const name = str(n!);
    const info = await host.fileInfo(name);
    if (info) return info.name;
    const f = await host.findFile(name);
    return f ? f.name : null;
  });
  // 이번 세션에 연 파일만(브라우저는 디스크를 볼 수 없다). 복사·지우기·이름 바꾸기는 만들지 않는다
  def('VL-FILE-SIZE', 1, 1, async ([n]) => (await host.fileInfo(str(n!)))?.size ?? null);
  def('VL-FILE-SYSTIME', 1, 1, async ([n]) => {
    const f = await host.fileInfo(str(n!));
    if (!f) return null;
    const t = new Date(f.time);
    return fromArray([t.getFullYear(), t.getMonth() + 1, t.getDay(), t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds(), 0]);
  });
  def('VL-FILE-DIRECTORY-P', 1, 1, () => null);
  // 읽기(r)만: 이번 세션에 연 글 파일. 쓰기(w·a)는 웹 버전에 없다
  def('OPEN', 2, 3, async ([n, m]) => {
    const name = str(n!);
    const mode = str(m!).trim().toLowerCase();
    if (mode === 'w' || mode === 'a') throw new LispError(`OPEN: 파일 쓰기(${mode})는 ${MSG.web}`);
    if (mode !== 'r') throw badValue('파일 모드', m!);
    const f = await host.fileInfo(name);
    const text = f ? await f.text() : null;
    return f && text !== null ? new LispFile(f.name, text) : null;
  });
  const fileOf = (v: Value | undefined, fn: string): LispFile => {
    if (v === undefined || v === null) throw new LispError(`${fn}: 키보드 읽기는 ${MSG.web}`);
    if (!(v instanceof LispFile) || v.closed) throw badType('streamp', v);
    return v;
  };
  def('READ-LINE', 0, 1, ([f]) => {
    const file = fileOf(f, 'READ-LINE');
    if (file.pos >= file.text.length) return null;
    let i = file.text.indexOf('\n', file.pos);
    if (i < 0) i = file.text.length;
    const line = file.text.slice(file.pos, i).replace(/\r$/, '');
    file.pos = i + 1;
    return line;
  });
  def('READ-CHAR', 0, 1, ([f]) => {
    const file = fileOf(f, 'READ-CHAR');
    if (file.pos >= file.text.length) return null;
    let c = file.text.codePointAt(file.pos)!;
    file.pos += c > 0xffff ? 2 : 1;
    // CR LF는 LF 하나로
    if (c === 13 && file.text[file.pos] === '\n') {
      file.pos++;
      c = 10;
    }
    return c;
  });
  def('CLOSE', 1, 1, ([f]) => {
    if (!(f instanceof LispFile)) throw badType('streamp', f!);
    f.closed = true;
    return null;
  });

  // ----------------------------------------------------------------- 객체 스냅·임시 그림
  def('OSNAP', 2, 2, ([p, m]) => {
    const pt = point(p!);
    const modes: string[] = [];
    for (const w of str(m!).split(',').map((x) => x.trim().replace(/^_+/, '').toUpperCase()).filter(Boolean)) {
      const k = OSNAP_NAMES.find(([n]) => w.startsWith(n))?.[1];
      if (k === undefined) return null;
      if (k) modes.push(k);
    }
    if (!modes.length) return null;
    if (modes.includes('none')) return ptList(pt.x, pt.y, pt.z);
    it.flush();
    const r = host.osnap(pt, modes);
    return r ? ptList(r.x, r.y, pt.z) : null;
  });
  def('GRDRAW', 3, 4, ([a, b, c, hl]) => {
    host.grdraw([{ a: point(a!), b: point(b!), color: Math.trunc(num(c!)), highlight: hl !== undefined && hl !== null && hl !== 0 }]);
    return null;
  });
  def('GRVECS', 1, 2, ([vl, tr]) => {
    const items = toArray(vl!);
    if (!items) throw badType('listp', vl!);
    const m = tr === undefined || tr === null ? null : matrix4(tr);
    const tx = (p: { x: number; y: number; z: number }) => (m ? { x: m[0]! * p.x + m[1]! * p.y + m[2]! * p.z + m[3]!, y: m[4]! * p.x + m[5]! * p.y + m[6]! * p.z + m[7]! } : p);
    let color = 7;
    let from: Pt2 | null = null;
    const out: { a: Pt2; b: Pt2; color: number; highlight: boolean }[] = [];
    for (const x of items) {
      if (typeof x === 'number') {
        color = x;
        continue;
      }
      const p = tx(point(x));
      if (!from) from = p;
      else {
        out.push({ a: from, b: p, color: color > 255 ? -1 : Math.abs(color), highlight: color < 0 });
        from = null;
      }
    }
    host.grdraw(out);
    return null;
  });
  def('REDRAW', 0, 2, ([e]) => {
    // (redraw): 임시 그림 지우기. (redraw 이름 모드)의 객체 강조·숨기기는 하지 않는다
    if (e === undefined || e === null) host.redraw();
    return null;
  });
  def('GRCLEAR', 0, 0, () => {
    host.redraw();
    return null;
  });
  def('VL-FILENAME-BASE', 1, 1, ([n]) => str(n!).replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, ''));
  def('VL-FILENAME-EXTENSION', 1, 1, ([n]) => {
    const m = /(\.[^.\\/]*)$/.exec(str(n!));
    return m ? m[1]! : null;
  });
  def('VL-FILENAME-DIRECTORY', 1, 1, ([n]) => str(n!).replace(/[^\\/]*$/, '').replace(/[\\/]$/, ''));
  def('VL-STRING-MISMATCH', 2, 5, ([a, b]) => {
    const x = str(a!);
    const y = str(b!);
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return i;
  });

}

/** osnap 모드 이름(앞 세 글자) → 객체 스냅. ''은 무시(QUI·PAR) */
const OSNAP_NAMES: [string, string][] = [
  ['END', 'end'],
  ['MID', 'mid'],
  ['CEN', 'cen'],
  ['NOD', 'nod'],
  ['QUA', 'qua'],
  ['INT', 'int'],
  ['INS', 'ins'],
  ['PER', 'per'],
  ['TAN', 'tan'],
  ['NEA', 'nea'],
  ['APP', 'app'],
  ['EXT', 'ext'],
  ['GCE', 'gcen'],
  ['NON', 'none'],
  ['QUI', ''],
  ['PAR', ''],
];

/** grvecs 변환 행렬(4×4 목록) → 행 우선 12개 */
function matrix4(v: Value): number[] {
  const rows = toArray(v);
  if (!rows || rows.length !== 4) throw badType('4x4 행렬', v);
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    const a = toArray(rows[r]!);
    if (!a || a.length !== 4 || !a.every(isNum)) throw badType('4x4 행렬', v);
    out.push(...a.map((x) => numOf(x as number)));
  }
  return out;
}

const norm = (a: number): number => {
  const t = Math.PI * 2;
  let r = a % t;
  if (r < 0) r += t;
  return r;
};
