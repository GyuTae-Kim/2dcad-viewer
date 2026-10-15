/**
 * 연관 망 객체(src/edit/assocnet/objects.ts·cgroup.ts·version.ts)와 DWG 코덱(src/io/dwg/assoccodec.ts):
 * 손으로 만든 태그의 해석·다시 쓰기, 판 1 ↔ 2 바꾸기, DWG 비트 왕복(R2000~R2018), 하위 객체 ID의 판별 비트 꼴.
 */
import { describe, expect, it } from 'vitest';
import type { GenericObject, RawTag } from '../../src/core/model';
import { parseGroupRest, writeGroupRest } from '../../src/edit/assocnet/cgroup';
import { parseAssocObject, writeAssocObject } from '../../src/edit/assocnet/objects';
import { sameTags } from '../../src/edit/assocnet/tags';
import { assocRawForVersion } from '../../src/edit/assocnet/version';
import { BitReader } from '../../src/io/dwg/bitstream';
import { decodeAssoc, encodeAssoc, writeAssocOps } from '../../src/io/dwg/assoccodec';
import { BitWriter } from '../../src/io/dwg/writer/bitwriter';
import { encoderFor } from '../../src/io/dwg/writer/codepage';
import {
  ACTION_V1,
  ACTION_V2,
  BODY_V1,
  BODY_V2,
  DEPENDENCY,
  DIMBODY,
  EDGE_V1,
  EDGE_V2,
  GEOMDEP_EDGE,
  GEOMDEP_SINGLE,
  NETWORK_V1,
  NETWORK_V2,
  VALUEDEP,
  VARIABLE_V1,
  VARIABLE_V2,
  VERTEX_V1,
  VERTEX_V2,
  groupTags,
} from './fixture';

const H = { group: '50', depL1: '51', depL2: '52', valueDep: '53', dimDep: '54', dimBody: '55', variable: '56', l1: '57', l2: '58', dim: '59' };

const CASES: [string, string, RawTag[]][] = [
  ['망 판 2', 'ACDBASSOCNETWORK', NETWORK_V2],
  ['망 판 1', 'ACDBASSOCNETWORK', NETWORK_V1],
  ['배열 동작 판 2', 'ACDBASSOCACTION', ACTION_V2],
  ['배열 동작 판 1', 'ACDBASSOCACTION', ACTION_V1],
  ['배열 몸체 판 2', 'ACDBASSOCARRAYACTIONBODY', BODY_V2],
  ['배열 몸체 판 1', 'ACDBASSOCARRAYACTIONBODY', BODY_V1],
  ['종속', 'ACDBASSOCDEPENDENCY', DEPENDENCY],
  ['형상 종속(한 모서리)', 'ACDBASSOCGEOMDEPENDENCY', GEOMDEP_SINGLE],
  ['형상 종속(폴리선 모서리)', 'ACDBASSOCGEOMDEPENDENCY', GEOMDEP_EDGE],
  ['값 종속', 'ACDBASSOCVALUEDEPENDENCY', VALUEDEP],
  ['치수 종속 몸체', 'ASSOCDIMDEPENDENCYBODY', DIMBODY],
  ['변수 판 2', 'ACDBASSOCVARIABLE', VARIABLE_V2],
  ['변수 판 1', 'ACDBASSOCVARIABLE', VARIABLE_V1],
  ['점 매개변수 판 2', 'ACDBASSOCVERTEXACTIONPARAM', VERTEX_V2],
  ['점 매개변수 판 1', 'ACDBASSOCVERTEXACTIONPARAM', VERTEX_V1],
  ['모서리 매개변수 판 2', 'ACDBASSOCEDGEACTIONPARAM', EDGE_V2],
  ['모서리 매개변수 판 1', 'ACDBASSOCEDGEACTIONPARAM', EDGE_V1],
  ['구속 그룹 판 2', 'ACDBASSOC2DCONSTRAINTGROUP', groupTags(H, '4F', 2)],
  ['구속 그룹 판 1', 'ACDBASSOC2DCONSTRAINTGROUP', groupTags(H, '4F', 1)],
];

/** DXF 리더처럼 값을 글로(앞 빈칸 포함) 바꾼 태그 */
const asDxf = (t: readonly RawTag[]): RawTag[] => t.map((x) => ({ code: x.code, value: typeof x.value === 'number' && x.code >= 90 && x.code <= 99 ? `        ${x.value}` : String(x.value) }));

describe('DXF 원본 태그 해석·다시 쓰기', () => {
  for (const [name, type, tags] of CASES)
    it(name, () => {
      const d = parseAssocObject(type, asDxf(tags))!;
      expect(d).not.toBeNull();
      expect(sameTags(writeAssocObject(d), tags)).toBe(true);
    });

  it('구속 그룹 노드: 판 1과 판 2가 같은 그래프', () => {
    const g1 = parseAssocObject('ACDBASSOC2DCONSTRAINTGROUP', groupTags(H, '4F', 1))!;
    const g2 = parseAssocObject('ACDBASSOC2DCONSTRAINTGROUP', groupTags(H, '4F', 2))!;
    if (g1.kind !== 'cgroup' || g2.kind !== 'cgroup') throw new Error('그룹');
    const a = parseGroupRest(1, g1.rest);
    const b = parseGroupRest(2, g2.rest);
    expect(a.nodes.map((n) => [n.cls, n.id, n.links, n.f.dep ?? ''])).toEqual(b.nodes.map((n) => [n.cls, n.id, n.links, n.f.dep ?? '']));
    expect(b.nodes.find((n) => n.id === 9)!.f).toMatchObject({ valueDep: '53', dimDep: '54', dirType: 1, dir: { x: 1, y: 0, z: 0 } });
    expect(b.nodes.find((n) => n.id === 7)!.f.datum).toBe(8);
    expect(b.nodes.find((n) => n.id === 4)!.f).toMatchObject({ ptype: 1, index: -1, curve: 1 });
    // 판 1 노드의 330(그룹 자신)은 쓸 때 그룹 핸들로
    expect(sameTags(writeGroupRest(a, '50'), g1.rest)).toBe(true);
  });

  it('모르는 노드 클래스·남은 태그는 풀지 않는다', () => {
    const t = groupTags(H, '4F', 2).map((x) => (x.code === 1 && x.value === 'AcPerpendicularConstraint' ? { ...x, value: 'AcAngleConstraint' } : x));
    const d = parseAssocObject('ACDBASSOC2DCONSTRAINTGROUP', t)!;
    if (d.kind !== 'cgroup') throw new Error('그룹');
    expect(() => parseGroupRest(2, d.rest)).toThrow();
    expect(() => parseAssocObject('ACDBASSOCDEPENDENCY', [...DEPENDENCY, { code: 90, value: 1 }])).toThrow();
  });
});

describe('판 바꾸기(저장 버전: AC1024 이하 판 1, AC1027 이상 판 2)', () => {
  const objs = new Map<string, GenericObject>([
    ['2A', { type: 'ACDBASSOCACTION', handle: '2A', raw: ACTION_V2 }],
    ['2B', { type: 'ACDBASSOCARRAYACTIONBODY', handle: '2B', owner: '2A', raw: BODY_V2 }],
  ]);
  const lookup = (h: string) => objs.get(h);
  const pairs: [string, string, RawTag[], RawTag[], string?][] = [
    ['망', 'ACDBASSOCNETWORK', NETWORK_V2, NETWORK_V1],
    ['변수', 'ACDBASSOCVARIABLE', VARIABLE_V2, VARIABLE_V1],
    ['점 매개변수', 'ACDBASSOCVERTEXACTIONPARAM', VERTEX_V2, VERTEX_V1],
    ['모서리 매개변수', 'ACDBASSOCEDGEACTIONPARAM', EDGE_V2, EDGE_V1],
    ['구속 그룹', 'ACDBASSOC2DCONSTRAINTGROUP', groupTags(H, '4F', 2), groupTags(H, '4F', 1), '50'],
  ];
  for (const [name, type, v2, v1, handle] of pairs)
    it(name, () => {
      const o2: GenericObject = { type, handle: handle ?? '60', raw: v2 };
      const o1: GenericObject = { type, handle: handle ?? '60', raw: v1 };
      expect(sameTags(assocRawForVersion(o2, 1024, lookup)!, v1)).toBe(true);
      expect(sameTags(assocRawForVersion(o2, 1015, lookup)!, v1)).toBe(true);
      expect(sameTags(assocRawForVersion(o1, 1027, lookup)!, v2)).toBe(true);
      expect(assocRawForVersion(o2, 1032, lookup)).toBe(v2);
    });

  it('배열: 판 1은 매개변수 목록이 몸체(AcDbAssocParamBasedActionBody)로 간다', () => {
    expect(sameTags(assocRawForVersion(objs.get('2A')!, 1018, lookup)!, ACTION_V1)).toBe(true);
    expect(sameTags(assocRawForVersion(objs.get('2B')!, 1018, lookup)!, BODY_V1)).toBe(true);
    const v1 = new Map<string, GenericObject>([
      ['2A', { type: 'ACDBASSOCACTION', handle: '2A', raw: ACTION_V1 }],
      ['2B', { type: 'ACDBASSOCARRAYACTIONBODY', handle: '2B', owner: '2A', raw: BODY_V1 }],
    ]);
    expect(sameTags(assocRawForVersion(v1.get('2A')!, 1032, (h) => v1.get(h))!, ACTION_V2)).toBe(true);
    expect(sameTags(assocRawForVersion(v1.get('2B')!, 1032, (h) => v1.get(h))!, BODY_V2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DWG
// ---------------------------------------------------------------------------

function bitsOf(b: Uint8Array, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += (b[i >> 3]! >> (7 - (i & 7))) & 1;
  return s;
}

/** 원본 태그 → DWG 비트(자료·문자열·핸들) → 원본 태그 */
function dwgRoundTrip(type: string, raw: readonly RawTag[], ver: number, self = 0x50): { tags: RawTag[]; d: BitWriter; s: BitWriter; hd: BitWriter } {
  const ops = encodeAssoc(type, raw, ver);
  if (!ops) throw new Error(`쓸 수 없음 ${type} ${ver}`);
  const enc = encoderFor('ANSI_1252');
  const d = new BitWriter(ver, enc);
  const s = new BitWriter(ver, enc);
  const hd = new BitWriter(ver, enc);
  if (ver >= 1021) d.strWriter = s;
  writeAssocOps(d, hd, ops, (h) => parseInt(h, 16) || 0);
  const dec = new TextDecoder('latin1');
  const r = new BitReader(d.bytes(), ver, dec);
  r.end = d.pos;
  if (ver >= 1021) {
    const sr = new BitReader(s.bytes(), ver, dec);
    sr.end = s.pos;
    r.strReader = sr;
  }
  const hr = new BitReader(hd.bytes(), ver, dec);
  hr.end = hd.pos;
  const tags = decodeAssoc(type, r, hr, self, ver);
  expect(r.pos, `${type} ${ver} 자료 비트`).toBe(r.end);
  expect(hr.pos, `${type} ${ver} 핸들 비트`).toBe(hr.end);
  return { tags, d, s, hd };
}

describe('DWG 코덱: 쓰고 다시 읽으면 같은 태그(R2000~R2018)', () => {
  const objs = new Map<string, GenericObject>([
    ['2A', { type: 'ACDBASSOCACTION', handle: '2A', raw: ACTION_V2 }],
    ['2B', { type: 'ACDBASSOCARRAYACTIONBODY', handle: '2B', owner: '2A', raw: BODY_V2 }],
  ]);
  for (const ver of [1015, 1018, 1021, 1024, 1027, 1032])
    it(`AC${ver}`, () => {
      for (const [name, type, tags] of CASES) {
        if (/판 1/.test(name)) continue;
        const handle = type === 'ACDBASSOC2DCONSTRAINTGROUP' ? '50' : type === 'ACDBASSOCACTION' ? '2A' : type === 'ACDBASSOCARRAYACTIONBODY' ? '2B' : '60';
        const o: GenericObject = { type, handle, owner: handle === '2B' ? '2A' : undefined, raw: tags };
        const raw = assocRawForVersion(o, ver, (h) => objs.get(h))!;
        const { tags: back } = dwgRoundTrip(type, raw, ver, parseInt(handle, 16));
        expect(sameTags(back, raw), `${name} AC${ver}`).toBe(true);
      }
    });

  it('형상 종속의 하위 객체 ID: AC1024 이하 TV 이름, AC1027 이상 B 0 + BL 번호(1 한 모서리, 3 폴리선 모서리)', () => {
    // 공통 앞부분: BL 2, BL 0, B 1111, BL −10000, (H 대상), B 0, (H, H, H), BL 1 / BL 0, B 1
    const head = '0100000010' + '10' + '1111' + '00' + bitsOf(new Uint8Array([0xf0, 0xd8, 0xff, 0xff]), 32) + '0' + '0100000001' + '10' + '1';
    const r27 = dwgRoundTrip('ACDBASSOCGEOMDEPENDENCY', GEOMDEP_SINGLE, 1027);
    expect(bitsOf(r27.d.bytes(), r27.d.pos)).toBe(head + '0' + '0100000001' + '0');
    const e27 = dwgRoundTrip('ACDBASSOCGEOMDEPENDENCY', GEOMDEP_EDGE, 1027);
    expect(bitsOf(e27.d.bytes(), e27.d.pos).slice(head.length)).toBe('0' + '0100000011' + '10' + '0100000001' + '0100000010' + '0');
    const r18 = dwgRoundTrip('ACDBASSOCGEOMDEPENDENCY', GEOMDEP_SINGLE, 1018);
    // TV(R2004): BS 길이(끝 0 포함 32) + 바이트 + 0
    expect(bitsOf(r18.d.bytes(), r18.d.pos).slice(head.length, head.length + 10)).toBe('0100100000');
    expect(r18.d.pos).toBe(head.length + 10 + 32 * 8 + 1);
  });

  it('구속 그룹 판 2: 클래스 이름 표 + (B 0, BL 클래스 번호, BL 노드 번호), 노드 플래그는 RC', () => {
    const raw = groupTags(H, '4F', 2);
    const { tags, s } = dwgRoundTrip('ACDBASSOC2DCONSTRAINTGROUP', raw, 1032);
    expect(sameTags(tags, raw)).toBe(true);
    // 문자열 흐름에는 서로 다른 클래스 이름 8개만 처음 나온 차례로 한 번씩
    const names = [...new Set(raw.filter((t) => t.code === 1).map((t) => String(t.value)))];
    expect(names.length).toBe(8);
    const sr = new BitReader(s.bytes(), 1032, new TextDecoder('latin1'));
    sr.end = s.pos;
    const got: string[] = [];
    while (sr.pos < sr.end) got.push(sr.TU());
    expect(got).toEqual(names);
  });
});
