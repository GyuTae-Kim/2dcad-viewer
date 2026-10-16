import { describe, expect, it } from 'vitest';
import { readSkpHeader, readUtf16String } from '../../src/formats/skp/header';
import { readZipDirectory, readZipItem } from '../../src/formats/skp/zip';
import { concat, oldSkpHeader, skpFile, utf16String, utf8, zip } from './build';

describe('SKP 머리', () => {
  it('2021 이후: 표지·버전·VFF 블록 뒤 ZIP 시작', () => {
    const file = skpFile(new Uint8Array([0xf4, 0x01, 0, 0, 0, 0]), { version: '21.0.339' });
    const h = readSkpHeader(file)!;
    expect(h.title).toBe('SketchUp Model');
    expect(h.version).toBe('21.0.339');
    expect([h.major, h.minor, h.build]).toEqual([21, 0, 339]);
    expect(h.container).toBe('zip');
    expect(h.subVersion).toBe(17);
    // "SketchUp Model"(4+28) + "{21.0.339}"(4+20) + "VFF"(3) + u16(2) + 8
    expect(h.bodyOffset).toBe(32 + 24 + 13);
    expect([...file.subarray(h.bodyOffset, h.bodyOffset + 4)]).toEqual([0x50, 0x4b, 3, 4]);
  });

  it('2020 이하: MFC 꼴로 가른다', () => {
    const h = readSkpHeader(oldSkpHeader('8.0.1'))!;
    expect(h.version).toBe('8.0.1');
    expect(h.major).toBe(8);
    expect(h.container).toBe('mfc');
  });

  it('SketchUp 파일이 아니면 null', () => {
    expect(readSkpHeader(utf8('solid cube\nendsolid'))).toBeNull();
    expect(readSkpHeader(utf16String('Other Model'))).toBeNull();
    expect(readSkpHeader(new Uint8Array(0))).toBeNull();
  });

  it('긴 문자열 길이(FF + u16)', () => {
    const s = 'x'.repeat(300);
    const b = new Uint8Array(6 + 600);
    b.set([0xff, 0xfe, 0xff, 0xff, 300 & 0xff, 300 >> 8]);
    for (let i = 0; i < 300; i++) b[6 + 2 * i] = 0x78;
    expect(readUtf16String(b, 0)).toEqual([s, 606]);
    expect(readUtf16String(b.subarray(0, 100), 0)).toBeNull();
  });
});

describe('ZIP 읽기(앞붙이가 있는 꾸러미)', () => {
  it('저장·DEFLATE 항목을 꺼낸다', () => {
    const a = utf8('<x/>'.repeat(100));
    const b = utf8('hello 가나다');
    const z = zip([
      { name: 'materials/빨강/material.xml', data: a, deflate: true },
      { name: 'model.dat', data: b },
    ]);
    const file = concat([new Uint8Array(77).fill(9), z]);
    const dir = readZipDirectory(file)!;
    expect(dir.map((d) => d.name)).toEqual(['materials/빨강/material.xml', 'model.dat']);
    expect(dir[0]!.method).toBe(8);
    expect(readZipItem(file, dir[0]!)).toEqual(a);
    expect(readZipItem(file, dir[1]!)).toEqual(b);
  });

  it('ZIP이 아니면 null', () => {
    expect(readZipDirectory(utf8('no zip here'))).toBeNull();
  });
});
