/**
 * 시험용 SKP 바이트 만들기: 공개 표본에서 확인한 구조(docs/formats/skp.md)를 손으로 옮긴 작은 쓰기 도구.
 * 실제 SketchUp 파일은 저장소에 넣지 않는다.
 */

import { deflateRawSync } from 'node:zlib';

const enc = new TextEncoder();

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

export function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}

export function i32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, true);
  return b;
}

/** 가장 짧은 리틀 엔디언 정수(번호 꼴) */
export function uintLE(v: number): Uint8Array {
  const out: number[] = [];
  do {
    out.push(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return new Uint8Array(out);
}

export function f64(...vs: number[]): Uint8Array {
  const b = new Uint8Array(8 * vs.length);
  const dv = new DataView(b.buffer);
  vs.forEach((v, i) => dv.setFloat64(8 * i, v, true));
  return b;
}

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

/** [u16 꼬리표][u32 길이][내용] */
export function tlv(tag: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u16(tag), u32(body.length), body]);
}

export const idBox = (id: number): Uint8Array => tlv(0x05dc, tlv(0x05de, uintLE(id)));

export interface BaseOpts {
  material?: number;
  layer?: number;
  flags?: number;
}

export function base(id: number | undefined, o: BaseOpts = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (id !== undefined) parts.push(idBox(id));
  if (o.material !== undefined) parts.push(tlv(0x07d1, uintLE(o.material)));
  if (o.layer !== undefined) parts.push(tlv(0x07d2, uintLE(o.layer)));
  parts.push(tlv(0x07d3, new Uint8Array([o.flags ?? 6])));
  return tlv(0x07d0, ...parts);
}

export const vertex = (id: number, x: number, y: number, z: number): Uint8Array => tlv(0x09c4, idBox(id), tlv(0x09c5, f64(x, y, z)));

export const edge = (id: number, a: number, b: number, o: BaseOpts = {}): Uint8Array =>
  tlv(0x0bb8, base(id, o), tlv(0x0bb9, uintLE(a)), tlv(0x0bba, uintLE(b)));

export interface FaceOpts extends BaseOpts {
  back?: number;
}

/** loops: 고리마다 [모서리 번호, 뒤집힘] */
export function face(id: number, plane: [number, number, number, number], loops: [number, boolean][][], o: FaceOpts = {}): Uint8Array {
  const parts = [base(id, o)];
  if (o.back !== undefined) parts.push(tlv(0x0daf, uintLE(o.back)));
  parts.push(tlv(0x0dad, f64(...plane)));
  parts.push(
    tlv(
      0x0dae,
      ...loops.map((l) =>
        tlv(0x1194, tlv(0x1195, ...l.map(([e, rev]) => tlv(0x0fa0, tlv(0x0fa1, uintLE(e)), tlv(0x0fa2, new Uint8Array([rev ? 1 : 0])))))),
      ),
    ),
  );
  return tlv(0x0dac, ...parts);
}

/** 13개 f64: 3×3 행 우선, 이동, 나눔수 */
export function instance(id: number, def: number, m13: number[], o: BaseOpts & { name?: string } = {}): Uint8Array {
  return tlv(
    0x1964,
    base(id, o),
    tlv(0x1965, utf8(o.name ?? '')),
    tlv(0x1966, f64(...m13)),
    tlv(0x1967, uintLE(def)),
    tlv(0x1968, new Uint8Array(16)),
  );
}

export const IDENTITY13 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

export interface EntitiesOpts {
  vertices?: Uint8Array[];
  edges?: Uint8Array[];
  faces?: Uint8Array[];
  groups?: Uint8Array[];
  components?: Uint8Array[];
}

export function entities(id: number | undefined, o: EntitiesOpts): Uint8Array {
  const parts = [base(id)];
  parts.push(tlv(0x1389, ...(o.vertices ?? [])));
  parts.push(tlv(0x138a, ...(o.edges ?? [])));
  parts.push(tlv(0x138b, ...(o.faces ?? [])));
  if (o.groups) parts.push(tlv(0x138c, ...o.groups));
  if (o.components) parts.push(tlv(0x138d, ...o.components.map((c) => tlv(0x1d4c, c))));
  parts.push(tlv(0x139b, tlv(0x639f, tlv(0x63a0))));
  return tlv(0x1388, ...parts);
}

export interface ModelOpts {
  materials?: [number, string][];
  layers?: [number, string][];
  defaultLayer?: number;
  definitions?: { name: string; entities: Uint8Array }[];
  root: Uint8Array;
  lengthUnit?: number;
}

export function modelDat(o: ModelOpts): Uint8Array {
  const parts: Uint8Array[] = [tlv(0x020a, utf8('meta/meta.dat'))];
  if (o.lengthUnit !== undefined)
    parts.push(
      tlv(
        0x0200,
        tlv(
          0x61a8,
          tlv(
            0x61a9,
            tlv(
              0x61aa,
              tlv(0x61ab, utf8('UnitsOptions')),
              tlv(0x61ac, tlv(0x61ad, utf8('LengthFormat')), tlv(0x38a4, tlv(0x38a7, i32(1))), tlv(0x61ad, utf8('LengthUnit')), tlv(0x38a4, tlv(0x38a7, i32(o.lengthUnit)))),
            ),
          ),
        ),
      ),
    );
  parts.push(
    tlv(
      0x01f7,
      tlv(0x30d4, tlv(0x30d5, ...(o.materials ?? []).map(([id, n]) => tlv(0x32c8, idBox(id), tlv(0x32cc, utf8(n)), tlv(0x32ca, new Uint8Array([0])))))),
    ),
  );
  const layers = o.layers ?? [[1, 'Layer0']];
  parts.push(
    tlv(
      0x01f8,
      tlv(
        0x3a98,
        tlv(0x3a99, ...layers.map(([id, n]) => tlv(0x3c8c, idBox(id), tlv(0x3c8d, utf8(n)), tlv(0x3c8e, new Uint8Array([0]))))),
        tlv(0x3a9a, uintLE(o.defaultLayer ?? layers[0]![0])),
      ),
    ),
  );
  parts.push(
    tlv(
      0x01f9,
      tlv(
        0x1770,
        tlv(
          0x1771,
          tlv(0x0063, u32(0)),
          ...(o.definitions ?? []).map((d) => tlv(0x157c, d.entities, tlv(0x157d, new Uint8Array(16)), tlv(0x157e, utf8(d.name)))),
        ),
      ),
    ),
  );
  parts.push(tlv(0x01f6, o.root));
  return tlv(0x01f4, ...parts);
}

export function materialXml(name: string, rgb: [number, number, number], trans = 1, useTrans = 0): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n<materialDocument>\n' +
    `  <mat:material name="${name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}" type="0" colorRed="${rgb[0]}" colorGreen="${rgb[1]}" colorBlue="${rgb[2]}" colorizeType="0" trans="${trans}" useTrans="${useTrans}" hasTexture="0" />\n</materialDocument>\n`
  );
}

/** ZIP(지역 머리 + 중앙 목록 + 끝 레코드). 위치는 ZIP 시작 기준(SKP처럼) */
export function zip(entries: { name: string; data: Uint8Array; deflate?: boolean }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const e of entries) {
    const name = utf8(e.name);
    const body = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const method = e.deflate ? 8 : 0;
    const lh = concat([u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(body.length), u32(e.data.length), u16(name.length), u16(0), name]);
    central.push(
      concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(body.length), u32(e.data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), name,
      ]),
    );
    locals.push(lh, body);
    off += lh.length + body.length;
  }
  const cd = concat(central);
  const eocd = concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(off), u16(0)]);
  return concat([...locals, cd, eocd]);
}

/** 머리 문자열: FF FE FF + 길이 + UTF-16LE */
export function utf16String(s: string): Uint8Array {
  const b = new Uint8Array(4 + 2 * s.length);
  b.set([0xff, 0xfe, 0xff, s.length]);
  for (let i = 0; i < s.length; i++) {
    b[4 + 2 * i] = s.charCodeAt(i) & 0xff;
    b[5 + 2 * i] = s.charCodeAt(i) >> 8;
  }
  return b;
}

/** 2021 이후 꼴의 파일 전체 */
export function skpFile(model: Uint8Array, opts: { version?: string; materials?: [string, string][]; deflate?: boolean } = {}): Uint8Array {
  const head = concat([
    utf16String('SketchUp Model'),
    utf16String(`{${opts.version ?? '26.1.194'}}`),
    utf8('VFF'),
    u16(8),
    u16(1),
    u16(17),
    u32(0x12345678),
  ]);
  const entries = [
    { name: 'meta/meta.dat', data: new Uint8Array([0x64, 0, 0, 0, 0, 0]) },
    ...(opts.materials ?? []).map(([n, xml]) => ({ name: `materials/${n}/material.xml`, data: utf8(xml), deflate: opts.deflate ?? true })),
    { name: 'model.dat', data: model, deflate: opts.deflate ?? true },
  ];
  return concat([head, zip(entries)]);
}

/** 2020 이하 꼴의 머리(+ MFC 버전 표 시작) */
export function oldSkpHeader(version: string): Uint8Array {
  return concat([
    utf16String('SketchUp Model'),
    utf16String(`{${version}}`),
    new Uint8Array(16),
    new Uint8Array([0xff, 0xfe, 0xff, 0x00]),
    u32(0x5eb2f812),
    new Uint8Array([0xff, 0xff, 0x00, 0x00, 0x0b, 0x00]),
    utf8('CVersionMap'),
  ]);
}
