/**
 * 연관 망 객체의 판(형식) 맞추기: 저장할 파일 버전에 맞게 원본 태그를 바꾼다.
 *
 * AutoCAD는 AC1024(2010) 이하로 저장할 때 판 1, AC1027(2013) 이상으로 저장할 때 판 2로 쓴다
 * (같은 도면을 R2000·R2004·R2007·R2010·R2013으로 저장한 공개 표본 Constraints와, 같은 배열 도면의 R2000 DXF·R2018 DWG로 확인).
 * 판에 따라 다른 곳:
 *  - AcDbAssocAction: 판 2만 동작 매개변수·값 매개변수 목록을 가진다. 판 1의 배열 동작은 그 목록을 몸체의
 *    AcDbAssocParamBasedActionBody(90 0 + 같은 목록)에 둔다 → 판을 바꿀 때 동작과 몸체 사이로 옮긴다.
 *  - AcDbAssocActionBody 판: 1 | 2.
 *  - AcDbAssocActionParam: 판 2는 90 1, 90 0, 1 이름 / 판 1은 90 0, 1 이름.
 *  - 구속 그룹: 노드 머리 순서, 클래스 목록, 90 0·90 0·290 0, 원·호의 끝 40 0(cgroup.ts).
 * 해석할 수 없는 객체는 그대로 둔다(null).
 */
import type { GenericObject, RawTag } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import { parseGroupRest, writeGroupRest } from './cgroup';
import { type AssocObjectData, type ParamLists, ASSOC_OBJECT_TYPES, parseAssocObject, writeAssocObject } from './objects';
import { sameTags } from './tags';

/** 파일 버전 번호(1015 …) → 연관 객체 판 */
export const assocVersionFor = (fileVer: number): 1 | 2 => (fileVer >= 1027 ? 2 : 1);

const EMPTY_LISTS = (): ParamLists => ({ a: 0, actionParams: [], b: 0, values: [] });

function parse(o: GenericObject | undefined): AssocObjectData | null {
  if (!o?.raw?.length) return null;
  try {
    return parseAssocObject(o.type, o.raw);
  } catch {
    return null;
  }
}

/**
 * 객체의 원본 태그를 판 want로 바꾼 것(바꿀 것이 없으면 원본 그대로, 풀 수 없으면 null).
 * lookup: 다른 객체(배열 동작 ↔ 몸체의 매개변수 목록을 옮길 때).
 */
export function assocRawForVersion(o: GenericObject, fileVer: number, lookup: (h: string) => GenericObject | undefined): readonly RawTag[] | null {
  if (!o.raw?.length || !ASSOC_OBJECT_TYPES.has(o.type.toUpperCase())) return o.raw ?? null;
  const want = assocVersionFor(fileVer);
  const d = parse(o);
  if (!d) return null;
  let out: AssocObjectData = d;
  switch (d.kind) {
    case 'network':
    case 'variable':
    case 'action':
    case 'cgroup': {
      if (d.head.version === want) return o.raw;
      const head = { ...d.head, version: want };
      if (want >= 2) {
        let lists = EMPTY_LISTS();
        if (d.kind === 'action' && head.body) {
          const b = parse(lookup(normalizeHandle(head.body)));
          if (b?.kind === 'arraybody' && b.body.paramBased) lists = b.body.paramBased.lists;
        }
        head.params = lists;
      } else delete head.params;
      if (d.kind === 'cgroup') {
        const g = parseGroupRest(d.head.version, d.rest);
        g.version = want;
        if (want >= 2) {
          g.v2 ??= { a: 0, b: 0, c: false };
          for (const n of g.nodes) if ((n.cls === 'AcConstrainedCircle' || n.cls === 'AcConstrainedArc') && n.f.cx === undefined) n.f.cx = 0;
        }
        out = { kind: 'cgroup', head, rest: writeGroupRest(g, normalizeHandle(o.handle)) };
      } else out = { ...d, head } as AssocObjectData;
      break;
    }
    case 'arraybody': {
      const b = { ...d.body };
      if (b.bodyVersion === want && !!b.paramBased === (want < 2)) return o.raw;
      b.bodyVersion = want;
      if (want >= 2) delete b.paramBased;
      else if (!b.paramBased) {
        const a = parse(o.owner ? lookup(normalizeHandle(o.owner)) : undefined);
        b.paramBased = { version: 0, lists: a && 'head' in a && a.head.params ? a.head.params : EMPTY_LISTS() };
      }
      out = { kind: 'arraybody', body: b };
      break;
    }
    case 'vertexparam':
    case 'edgeparam': {
      const v = want >= 2 ? 1 : null;
      if (d.param.version === v) return o.raw;
      out = { ...d, param: { ...d.param, version: v } } as AssocObjectData;
      break;
    }
    default:
      return o.raw;
  }
  const raw = writeAssocObject(out);
  return sameTags(raw, o.raw) ? o.raw : raw;
}
