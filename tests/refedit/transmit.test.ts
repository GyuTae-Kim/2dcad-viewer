/** 전송(ETRANSMIT): ZIP 구조(로컬 헤더·중앙 디렉터리·CRC)와 패키지 경로 규칙, 보고서 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MSG_ZIP_TOO_LARGE, buildZip, crc32, zipName } from '../../src/edit/transmit/zip';
import { type TransmitItem, DEFAULT_SETTINGS, drawingName, planPackage, relativePath, transmitReport } from '../../src/edit/transmit/plan';

import { PYTHON as PY } from '../oracle/ezdxf';
const TMP = join(process.cwd(), '.runtime/refedit/tmp');

const enc = new TextEncoder();

/** 로컬 헤더·중앙 디렉터리를 직접 읽는다(Node) */
function readZip(z: Uint8Array): { name: string; method: number; flags: number; crc: number; csize: number; usize: number; offset: number }[] {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const eocd = z.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const n = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOff = v.getUint32(eocd + 16, true);
  expect(cdOff + cdSize).toBe(eocd);
  const out = [];
  let p = cdOff;
  const dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true);
    const offset = v.getUint32(p + 42, true);
    const name = dec.decode(z.subarray(p + 46, p + 46 + nl));
    // 로컬 헤더가 같은 값을 갖는지
    expect(v.getUint32(offset, true)).toBe(0x04034b50);
    expect(v.getUint16(offset + 6, true)).toBe(flags);
    expect(v.getUint16(offset + 8, true)).toBe(method);
    expect(v.getUint32(offset + 14, true)).toBe(crc);
    expect(v.getUint32(offset + 18, true)).toBe(csize);
    expect(v.getUint32(offset + 22, true)).toBe(usize);
    expect(dec.decode(z.subarray(offset + 30, offset + 30 + v.getUint16(offset + 26, true)))).toBe(name);
    out.push({ name, method, flags, crc, csize, usize, offset });
    p += 46 + nl;
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds)).arrayBuffer());
}

describe('ZIP 쓰기', () => {
  it('CRC-32 알려진 값', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    // 이어서 세기
    const a = enc.encode('1234');
    const b = enc.encode('56789');
    expect(crc32(b, crc32(a))).toBe(0xcbf43926);
  });

  it('경로 정리', () => {
    expect(zipName('.\\xrefs\\b.dwg')).toBe('xrefs/b.dwg');
    expect(zipName('/a//b/')).toBe('a/b');
  });

  it('로컬 헤더·중앙 디렉터리·CRC·UTF-8 플래그, 줄어들 때만 DEFLATE', async () => {
    const big = enc.encode('LINE 0,0 100,100\n'.repeat(500));
    const rnd = new Uint8Array(300);
    let s = 7;
    for (let i = 0; i < rnd.length; i++) rnd[i] = ((s = (s * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255;
    const entries = [
      { name: 'a.dwg', data: big, modified: new Date(2026, 9, 15, 13, 45, 30) },
      { name: 'xrefs/도면 한글.dxf', data: rnd },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ];
    const z = await buildZip(entries);
    const list = readZip(z);
    expect(list.map((x) => x.name)).toEqual(['a.dwg', 'xrefs/도면 한글.dxf', 'empty.txt']);
    for (const x of list) expect(x.flags & 0x0800).toBe(0x0800);
    expect(list[0]!.method).toBe(8);
    expect(list[0]!.csize).toBeLessThan(big.length);
    expect(list[1]!.method).toBe(0);
    expect(list[2]!.method).toBe(0);
    for (let i = 0; i < entries.length; i++) {
      const x = list[i]!;
      expect(x.crc).toBe(crc32(entries[i]!.data));
      expect(x.usize).toBe(entries[i]!.data.length);
      const nl = new DataView(z.buffer, z.byteOffset).getUint16(x.offset + 26, true);
      const body = z.subarray(x.offset + 30 + nl, x.offset + 30 + nl + x.csize);
      const raw = x.method === 8 ? await inflate(body) : body;
      expect(Buffer.from(raw).equals(Buffer.from(entries[i]!.data))).toBe(true);
    }
    // DOS 날짜·시각
    const v = new DataView(z.buffer, z.byteOffset);
    const time = v.getUint16(10, true);
    const date = v.getUint16(12, true);
    expect(time >> 11).toBe(13);
    expect((time >> 5) & 63).toBe(45);
    expect((time & 31) * 2).toBe(30);
    expect((date >> 9) + 1980).toBe(2026);
    expect((date >> 5) & 15).toBe(10);
    expect(date & 31).toBe(15);
  });

  it('압축하지 않기(STORE)', async () => {
    const z = await buildZip([{ name: 'x.txt', data: enc.encode('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') }], { compress: false });
    expect(readZip(z)[0]!.method).toBe(0);
  });

  it('항목 65,535개를 넘으면 거절', async () => {
    const many = Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(0) }));
    await expect(buildZip(many)).rejects.toThrow(MSG_ZIP_TOO_LARGE);
  });

  it.runIf(existsSync(PY))('파이썬 zipfile로 열어 이름·CRC·내용을 확인', async () => {
    const files = [
      { name: 'plan.dwg', data: enc.encode('AC1032'.repeat(1000)) },
      { name: 'Xrefs/기초 평면.dwg', data: enc.encode('xref body') },
      { name: 'Fonts/romans.shx', data: new Uint8Array([0, 1, 2, 3, 255]) },
      { name: 'plan.txt', data: enc.encode('\ufeff전송 보고서\r\n') },
    ];
    const z = await buildZip(files);
    mkdirSync(TMP, { recursive: true });
    const p = join(TMP, `zip-${process.pid}.zip`);
    writeFileSync(p, z);
    try {
      const script = [
        'import zipfile, json, sys, hashlib',
        'z = zipfile.ZipFile(sys.argv[1])',
        "print(json.dumps({'bad': z.testzip(), 'items': [[i.filename, i.CRC, i.file_size, i.compress_type, i.flag_bits, hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()]}))",
      ].join('\n');
      const out = JSON.parse(execFileSync(PY, ['-I', '-c', script, p], { encoding: 'utf8' })) as { bad: string | null; items: [string, number, number, number, number, string][] };
      expect(out.bad).toBe(null);
      expect(out.items.map((i) => i[0])).toEqual(files.map((f) => f.name));
      const { createHash } = await import('node:crypto');
      out.items.forEach((i, k) => {
        expect(i[1]).toBe(crc32(files[k]!.data));
        expect(i[2]).toBe(files[k]!.data.length);
        expect(i[4] & 0x800).toBe(0x800);
        expect(i[5]).toBe(createHash('sha256').update(files[k]!.data).digest('hex'));
      });
      expect(out.items[0]![3]).toBe(8);
    } finally {
      rmSync(p, { force: true });
    }
  });
});

describe('패키지 경로', () => {
  const item = (p: Partial<TransmitItem> & Pick<TransmitItem, 'id' | 'kind' | 'name'>): TransmitItem => ({
    key: p.name.toLowerCase(),
    path: '',
    owner: 'root',
    found: true,
    include: true,
    depth: 1,
    ...p,
  });
  const tree = (): TransmitItem[] => [
    item({ id: 'root', kind: 'drawing', name: 'a.dxf', owner: null, depth: 0 }),
    item({ id: 'x1', kind: 'xref', name: 'b.dwg', path: '.\\xrefs\\b.dwg' }),
    item({ id: 'x2', kind: 'xref', name: 'c.dwg', path: '..\\shared\\c.dwg', owner: 'x1', depth: 2 }),
    item({ id: 'x3', kind: 'xref', name: 'up.dwg', path: '..\\..\\up.dwg' }),
    item({ id: 'i1', kind: 'image', name: 'p.png', path: 'C:\\img\\p.png' }),
    item({ id: 'i2', kind: 'image', name: 'logo.png', path: 'img\\logo.png', owner: 'x1', depth: 2 }),
    item({ id: 'm1', kind: 'xref', name: 'd.dwg', path: 'd.dwg', found: false }),
    item({ id: 'e1', kind: 'pdf', name: 'e.pdf', path: 'e.pdf', include: false }),
    item({ id: 'f1', kind: 'font', name: 'romans.shx' }),
    item({ id: 's1', kind: 'plotstyle', name: 'mono.ctb' }),
  ];

  it('트리 유지: 저장된 상대 경로를 도면 폴더에서 풀고, 절대·밖으로 나가는 경로만 파일 이름으로', () => {
    const plan = planPackage(tree(), DEFAULT_SETTINGS);
    const at = (id: string) => plan.placement.get(id);
    expect(at('root')).toBe('a.dxf');
    expect(at('x1')).toBe('xrefs/b.dwg');
    expect(at('x2')).toBe('shared/c.dwg');
    expect(at('x3')).toBe('up.dwg');
    expect(at('i1')).toBe('p.png');
    expect(at('i2')).toBe('xrefs/img/logo.png');
    expect(at('f1')).toBe('Fonts/romans.shx');
    expect(at('s1')).toBe('PlotStyles/mono.ctb');
    expect(plan.rewrites.get('root')?.get('i1')).toBe('p.png');
    expect(plan.rewrites.get('root')?.get('x3')).toBe('up.dwg');
    expect(plan.rewrites.get('root')?.has('x1')).toBe(false);
    expect(plan.rewrites.get('x1')).toBeUndefined();
    expect(plan.files.map((f) => f.zipPath)).toEqual(['a.dxf', 'xrefs/b.dwg', 'shared/c.dwg', 'up.dwg', 'p.png', 'xrefs/img/logo.png', 'Fonts/romans.shx', 'PlotStyles/mono.ctb']);
    expect(plan.missing.map((i) => i.id)).toEqual(['m1']);
    expect(plan.excluded.map((i) => i.id)).toEqual(['e1']);
  });

  it('단일 폴더: 모두 맨 위, 모든 참조 경로를 파일 이름만으로', () => {
    const plan = planPackage(tree(), { ...DEFAULT_SETTINGS, folder: 'flat' });
    expect(plan.files.every((f) => !f.zipPath.includes('/'))).toBe(true);
    expect(plan.rewrites.get('root')?.get('x1')).toBe('b.dwg');
    expect(plan.rewrites.get('x1')?.get('x2')).toBe('c.dwg');
    expect(plan.rewrites.get('x1')?.get('i2')).toBe('logo.png');
  });

  it('경로 지우기: 트리여도 파일 이름만, 파일은 참조하는 도면의 폴더에', () => {
    const plan = planPackage(tree(), { ...DEFAULT_SETTINGS, clearPaths: true });
    expect(plan.placement.get('x1')).toBe('b.dwg');
    expect(plan.placement.get('x2')).toBe('c.dwg');
    expect(plan.rewrites.get('root')?.get('x1')).toBe('b.dwg');
  });

  it('형식 바꾸기: 확장자와 그것을 가리키는 경로, 겹치는 이름은 (2)', () => {
    const items = [
      item({ id: 'root', kind: 'drawing', name: 'a.dxf', owner: null, depth: 0 }),
      item({ id: 'x1', kind: 'xref', name: 'b.dxf', path: '.\\xrefs\\b.dxf' }),
      item({ id: 'x2', kind: 'xref', name: 'b.dwg', path: '.\\xrefs\\b.dwg' }),
    ];
    const plan = planPackage(items, { ...DEFAULT_SETTINGS, format: 'AC1015' });
    expect(plan.files.map((f) => f.zipPath)).toEqual(['a.dwg', 'xrefs/b.dwg', 'xrefs/b(2).dwg']);
    expect(plan.rewrites.get('root')?.get('x1')).toBe('.\\xrefs\\b.dwg');
    expect(plan.rewrites.get('root')?.get('x2')).toBe('.\\xrefs\\b(2).dwg');
    expect(drawingName('p.DXF', 'dxf')).toBe('p.dxf');
    expect(drawingName('p.dwg', 'keep')).toBe('p.dwg');
  });

  it('같은 파일을 두 도면이 가리키면 한 번만, 두 번째는 첫 자리로 경로를 바꾼다', () => {
    const items = [
      item({ id: 'root', kind: 'drawing', name: 'a.dwg', owner: null, depth: 0 }),
      item({ id: 'x1', kind: 'xref', name: 'b.dwg', path: 'sub\\b.dwg' }),
      item({ id: 'i1', kind: 'image', name: 'p.png', path: 'p.png' }),
      item({ id: 'i2', kind: 'image', name: 'p.png', path: 'p.png', owner: 'x1', depth: 2 }),
    ];
    const plan = planPackage(items, DEFAULT_SETTINGS);
    expect(plan.files.map((f) => f.zipPath)).toEqual(['a.dwg', 'sub/b.dwg', 'p.png']);
    expect(plan.rewrites.get('x1')?.get('i2')).toBe('..\\p.png');
    expect(relativePath(['sub'], ['p.png'])).toBe('..\\p.png');
    expect(relativePath([], ['x', 'p.png'])).toBe('.\\x\\p.png');
  });

  it('외부 참조 결합: 참조 파일과 그 안의 참조는 넣지 않는다', () => {
    const plan = planPackage(tree(), { ...DEFAULT_SETTINGS, bind: true });
    expect(plan.bound.map((i) => i.id)).toEqual(['x1', 'x2', 'x3', 'i2', 'm1']);
    expect(plan.files.map((f) => f.item.id)).toEqual(['root', 'i1', 'f1', 's1']);
  });

  it('보고서: 설정·포함·찾을 수 없음·넣지 않음·경로 바꿈·메모', () => {
    const items = tree();
    const plan = planPackage(items, DEFAULT_SETTINGS);
    const txt = transmitReport({ items, plan, settings: DEFAULT_SETTINGS, zipName: 'a.zip', date: new Date(2026, 9, 15, 9, 5), notes: ['글꼴은 이 브라우저에 불러온 것만 넣었습니다.'], memo: '검토용' });
    expect(txt).toContain('전송 보고서');
    expect(txt).toContain('만든 날짜: 2026-10-15 09:05');
    expect(txt).toContain('xrefs/b.dwg    외부 참조');
    expect(txt).toContain('찾을 수 없는 파일 (1)');
    expect(txt).toContain('넣지 않은 파일 (1)');
    expect(txt).toContain('"C:\\img\\p.png" → "p.png"');
    expect(txt).toContain('메모\r\n  검토용');
  });
});
