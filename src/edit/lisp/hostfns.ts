/**
 * 앱과 잇는 AutoLISP 함수: 입력(getpoint getcorner getdist getangle getorient getreal getint getstring getkword initget entsel),
 * 명령(command command-s vl-cmdf), 변수(getvar setvar), 객체(entget entmod entmake entmakex entdel entnext entlast handent entupd),
 * 선택 세트(ssget ssname sslength ssadd ssdel ssmemb sssetfirst ssgetfirst), 표(tblsearch tblnext layoutlist), trans, alert, load, findfile.
 * 파일 쓰기·외부 실행·ActiveX·대화상자(DCL)는 만들지 않고 "이 웹 버전에서는 쓸 수 없습니다"로 알린다.
 */
import { MODEL_SPACE, tableKey, type Vec3 } from '../../core/model';
import { ocsToWcs, wcsToOcs } from '../geom/ocs';
import { isPoint, num, point, ptList, str } from './core';
import { allMain, entdel, entget, entlast, entmake, entmod, entnext, exists, filterHandles } from './entity';
import type { AskOptions, AskResult, LispDrawing, LispHost, Pt2 } from './host';
import type { Interp } from './interp';
import { badType, badValue, prin1 } from './printer';
import { EOF, LispReader } from './reader';
import { angtof, distof } from './text';
import { Cons, Ename, Ev, type Gen, LispError, MSG, PickSet, Real, fromArray, isNum, numOf, toArray, type Value } from './types';

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
    'OPEN',
    'CLOSE',
    'READ-LINE',
    'WRITE-LINE',
    'READ-CHAR',
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
  for (const n of ['ACAD-PUSH-DBMOD', 'ACAD-POP-DBMOD', 'REDRAW', 'GRDRAW', 'GRVECS', 'GRCLEAR', 'GRTEXT', 'MENUCMD', 'MENUGROUP', 'TEXTSCR', 'GRAPHSCR', 'TEXTPAGE']) def(n, 0, -1, () => null);

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
  def('ENTGET', 1, 2, ([e]) => {
    const d = host.drawing();
    if (!d) return null;
    return entget(it, d, enameArg(e!).handle);
  });
  def('ENTMOD', 1, 1, ([l]) => entmod(drawing(), l!));
  def('ENTMAKE', 0, 1, ([l]) => entmake(drawing(), l ?? null));
  def('ENTMAKEX', 0, 1, ([l]) => {
    const d = drawing();
    const r = entmake(d, l ?? null);
    if (r === null) return null;
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
    const k = str(h!).trim().toUpperCase().replace(/^0+(?=.)/, '');
    return d && d.doc.entityIndex.has(k) && exists(d, k) ? it.ename(k) : null;
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
  const tableEntries = (d: LispDrawing, table: string): { name: string; data: () => Value }[] => {
    const doc = d.doc;
    const pairs = (xs: [number, Value][]) => fromArray(xs.map(([c, v]) => new Cons(c, v)));
    switch (table) {
      case 'LAYER':
        return [...doc.layers.values()].map((l) => ({
          name: l.name,
          data: () =>
            pairs([
              [0, 'LAYER'],
              [2, l.name],
              [70, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0)],
              [62, l.off ? -Math.abs(l.color.aci) : Math.abs(l.color.aci)],
              [6, l.linetype],
              [290, l.plot ? 1 : 0],
              [370, l.lineweight],
            ]),
        }));
      case 'LTYPE':
        return [...doc.linetypes.values()].map((l) => ({
          name: l.name,
          data: () =>
            pairs([
              [0, 'LTYPE'],
              [2, l.name],
              [70, l.flags],
              [3, l.description],
              [72, 65],
              [73, l.elements.length],
              [40, new Real(l.patternLength)],
              ...l.elements.map((e) => [49, new Real(e.length)] as [number, Value]),
            ]),
        }));
      case 'STYLE':
        return [...doc.textStyles.values()].map((s) => ({
          name: s.name,
          data: () =>
            pairs([
              [0, 'STYLE'],
              [2, s.name],
              [70, s.flags],
              [40, new Real(s.height)],
              [41, new Real(s.widthFactor)],
              [50, new Real(s.oblique)],
              [71, s.generation],
              [42, new Real(s.lastHeight)],
              [3, s.font],
              [4, s.bigFont],
            ]),
        }));
      case 'BLOCK':
        return [...doc.blocks.values()]
          .filter((b) => !/^\*(MODEL|PAPER)_SPACE/i.test(b.name))
          .map((b) => ({
            name: b.name,
            data: () => {
              const first = b.entities.find((e) => e.handle);
              return pairs([
                [0, 'BLOCK'],
                [2, b.name],
                [70, b.flags],
                [10, ptList(b.basePoint.x, b.basePoint.y, b.basePoint.z)],
                ...(first ? [[-2, it.ename(first.handle)] as [number, Value]] : []),
              ]);
            },
          }));
      case 'DIMSTYLE':
      case 'VIEW':
      case 'UCS':
      case 'APPID': {
        const m = table === 'DIMSTYLE' ? doc.dimStyles : table === 'VIEW' ? doc.views : table === 'UCS' ? doc.ucs : doc.appIds;
        return [...m.values()].map((r) => ({
          name: r.name,
          data: () =>
            pairs([
              [0, table],
              [2, r.name],
              [70, r.flags],
            ]),
        }));
      }
      case 'VPORT':
        return doc.vports.map((r) => ({
          name: r.name,
          data: () =>
            pairs([
              [0, 'VPORT'],
              [2, r.name],
              [70, r.flags],
            ]),
        }));
      default:
        throw badValue('표 이름', table);
    }
  };
  def('TBLSEARCH', 2, 3, ([t, n, next]) => {
    const d = host.drawing();
    if (!d) return null;
    const table = str(t!).toUpperCase();
    const list = tableEntries(d, table);
    const i = list.findIndex((x) => tableKey(x.name) === tableKey(str(n!)));
    if (i < 0) return null;
    if (next !== undefined && next !== null) tblIter.set(table, i + 1);
    return list[i]!.data();
  });
  def('TBLNEXT', 1, 2, ([t, rewind]) => {
    const d = host.drawing();
    if (!d) return null;
    const table = str(t!).toUpperCase();
    const list = tableEntries(d, table);
    let i = rewind !== undefined && rewind !== null ? 0 : (tblIter.get(table) ?? 0);
    if (i >= list.length) return null;
    tblIter.set(table, i + 1);
    return list[i++]!.data();
  });
  def('TBLOBJNAME', 2, 2, ([t, n]) => {
    const d = host.drawing();
    if (!d) return null;
    const table = str(t!).toUpperCase();
    const key = tableKey(str(n!));
    const doc = d.doc;
    const h =
      table === 'LAYER' ? doc.layers.get(key)?.handle : table === 'LTYPE' ? doc.linetypes.get(key)?.handle : table === 'STYLE' ? doc.textStyles.get(key)?.handle : table === 'BLOCK' ? doc.blocks.get(key)?.recordHandle : table === 'DIMSTYLE' ? doc.dimStyles.get(key)?.handle : undefined;
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
    const f = await host.findFile(name);
    return f ? f.name : null;
  });
  def('VL-FILE-SYSTIME', 1, 1, () => null);
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

const norm = (a: number): number => {
  const t = Math.PI * 2;
  let r = a % t;
  if (r < 0) r += t;
  return r;
};
