/**
 * DXF 바이트 토큰화기(records.ts AsciiByteTagReader)가 예전 문자열 토큰화기와 같은 문서를 만드는지 본다.
 * - 차이는 하나뿐이다: 실수 그룹 코드 값은 (parseFloat와 같은 값이 보장될 때) 문자열 대신 숫자로 둔다.
 *   비교할 때 예전 문서의 그 값도 같은 규칙으로 숫자로 바꿔 본다.
 * - 다시 쓴 DXF는 바이트까지 같아야 한다.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CadDocument } from '../../src/core/model';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { parseDecimalBytes, valueKind } from '../../src/io/dxf/records';
import { pinHeader, syntheticDxf } from './synthetic';
import { dxfFixtures } from '../dxf/writer.helpers';

const enc = new TextEncoder();

/** 새 토큰화기 규칙대로 실수 코드의 문자열 값을 숫자로 */
function fastNumber(v: string): string | number {
  const b = enc.encode(v);
  const n = parseDecimalBytes(b, 0, b.length);
  return n === n ? n : v;
}

/** 문서 → 비교용 JSON 값(Map·형식 배열을 풀고, 원본 태그의 실수 값을 새 규칙으로) */
function plain(doc: CadDocument): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v instanceof Map) return [...v].map(([k, x]) => [k, walk(x)]);
    if (ArrayBuffer.isView(v)) return Array.from(v as Uint8Array);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      // entityIndex 등이 같은 객체를 다시 가리키면 핸들만
      if (seen.has(v)) return (v as { handle?: string }).handle ?? '[seen]';
      seen.add(v);
      const o = v as Record<string, unknown>;
      if (typeof o.code === 'number' && 'value' in o && Object.keys(o).length === 2 && typeof o.value === 'string' && valueKind(o.code) === 'dbl') {
        return { code: o.code, value: walk(fastNumber(o.value)) };
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = walk(o[k]);
      return out;
    }
    if (typeof v === 'number' && Object.is(v, -0)) return '-0';
    return v;
  };
  const { entityIndex, ...rest } = doc;
  return { ...(walk(rest) as object), entityIndex: [...entityIndex.keys()] };
}

function compareReaders(data: Uint8Array): void {
  const a = readDxf(data, { legacyText: true });
  const b = readDxf(data);
  expect(b.entityIndex.size).toBe(a.entityIndex.size);
  expect(plain(b)).toEqual(plain(a));
  const wa = writeDxf(pinHeader(a), {}).data;
  const wb = writeDxf(pinHeader(b), {}).data;
  expect(Buffer.from(wb).equals(Buffer.from(wa))).toBe(true);
}

const dxf = (body: string, eol = '\n') => enc.encode(body.split('\n').join(eol));

describe('parseDecimalBytes', () => {
  it('받는 꼴은 parseFloat와 같은 값', () => {
    let seed = 12345;
    const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const samples = ['0', '-0', '0.0', '-0.0', '+1.5', '.5', '5.', '-.25', '  12.75\t', '007.100', '123456789012345.6', '9007199254740993', '0.1', '0.3', '1.0000000000000002', '2.2450640303', '-2461328.839613102'];
    for (let i = 0; i < 20000; i++) {
      const ip = String(Math.floor(r() * 10 ** Math.floor(r() * 12)));
      const fp = String(Math.floor(r() * 10 ** Math.floor(r() * 18))).padStart(Math.floor(r() * 18), '0');
      samples.push(`${r() < 0.3 ? '-' : ''}${ip}${r() < 0.8 ? '.' + fp : ''}`);
    }
    for (const s of samples) {
      const b = enc.encode(s);
      const v = parseDecimalBytes(b, 0, b.length);
      if (v === v) expect(Object.is(v, parseFloat(s)), s).toBe(true);
    }
  });
  it('지수·쉼표·빈 값·숫자 없는 값은 풀지 않는다', () => {
    for (const s of ['1e5', '1.0E-3', '1,5', '', '   ', '.', '-', '1.2.3', 'abc', '1x', '1.5\u000b', '123456789012345678901234567890']) {
      const b = enc.encode(s);
      expect(Number.isNaN(parseDecimalBytes(b, 0, b.length)), s).toBe(true);
    }
  });
});

describe('바이트 토큰화기 = 예전 토큰화기', () => {
  it('합성 도면(선·폴리선·원·호·문자·해치·블록 참조·속성)', () => {
    compareReaders(syntheticDxf(3000));
  });

  it('CRLF·여백 코드·지수·쉼표·주석·파일 끝 빈 줄', () => {
    const body = [
      '999', 'comment', '  0', 'SECTION', '  2', 'ENTITIES',
      '  0', 'LINE', '  5', '2A', '  8', 'Layer A', ' 10', '1.0e-3', ' 20', ' 2.5 ', ' 30', '-0.0', ' 11', '1,5', ' 21', '.5', ' 31', '5.',
      '  0', 'CIRCLE', '  5', '2B', '  8', '0', ' 10', '+3', ' 20', '0012.50', ' 40', '123456789012345678901234',
      '  0', 'ENDSEC', '  0', 'EOF', '', '',
    ].join('\n');
    compareReaders(dxf(body));
    compareReaders(dxf(body, '\r\n'));
  });

  it('UTF-8(BOM, R2018)과 코드 페이지(ANSI_949) 문자', () => {
    const utf8 = ['  0', 'SECTION', '  2', 'HEADER', '  9', '$ACADVER', '  1', 'AC1032', '  0', 'ENDSEC', '  0', 'SECTION', '  2', 'ENTITIES', '  0', 'TEXT', '  5', '10', '  8', '도면층', ' 10', '1.0', ' 20', '2.0', ' 40', '2.5', '  1', '안녕하세요 Hello 1234567890 긴 문자열입니다', '  0', 'ENDSEC', '  0', 'EOF', ''].join('\n');
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(utf8)]);
    compareReaders(withBom);
    // CP949: '가' = B0 A1
    const pre = enc.encode(['  0', 'SECTION', '  2', 'HEADER', '  9', '$ACADVER', '  1', 'AC1015', '  9', '$DWGCODEPAGE', '  3', 'ANSI_949', '  0', 'ENDSEC', '  0', 'SECTION', '  2', 'ENTITIES', '  0', 'TEXT', '  5', '10', '  8', ''].join('\n'));
    const post = enc.encode(['', ' 10', '1.0', ' 20', '2.0', ' 40', '2.5', '  1', 'X', '  0', 'ENDSEC', '  0', 'EOF', ''].join('\n'));
    const cp = new Uint8Array([...pre, 0xb0, 0xa1, 0x41, ...post]);
    compareReaders(cp);
    const d = readDxf(cp);
    expect([...d.entityIndex.values()][0]!.layer).toBe('가A');
  });

  it('잘못된 그룹 코드는 같은 오류', () => {
    const bad = dxf(['  0', 'SECTION', '  2', 'ENTITIES', 'XX', 'LINE', '  0', 'EOF', ''].join('\n'));
    expect(() => readDxf(bad, { legacyText: true })).toThrow();
    expect(() => readDxf(bad)).toThrow();
  });

  it('이진 DXF로 다시 쓴 것도 같게 읽는다', () => {
    const doc = pinHeader(readDxf(syntheticDxf(800)));
    const bin = writeDxf(doc, { binary: true }).data;
    const a = readDxf(bin);
    expect(a.binary).toBe(true);
    const legacy = readDxf(bin, { legacyText: true });
    expect(plain(a)).toEqual(plain(legacy));
    expect(a.entityIndex.size).toBe(doc.entityIndex.size);
  });

  const files = dxfFixtures();
  it.skipIf(files.length === 0)(`비교 도면 ${files.length}개`, () => {
    for (const f of files) {
      const data = new Uint8Array(readFileSync(f));
      try {
        compareReaders(data);
      } catch (e) {
        throw new Error(`${f}: ${e instanceof Error ? e.message.slice(0, 2000) : String(e)}`);
      }
    }
  });
});
