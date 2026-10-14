/** 하이퍼링크 확장 자료(PE_URL) 읽기·쓰기 */
import { describe, expect, it } from 'vitest';
import { hyperlinkLabel, isWebUrl, readHyperlink, withHyperlink } from '../../src/edit/hyperlink';

describe('하이퍼링크', () => {
  it('주소·설명·위치를 AutoCAD 꼴로 쓰고 다시 읽는다', () => {
    const other = { app: 'OPENCAD_FIELD', items: [{ code: 1000, value: 'x' }] };
    const xd = withHyperlink([other], { url: 'https://example.com', description: '설명', location: 'VIEW1' })!;
    expect(xd[0]).toBe(other);
    expect(xd[1]!.items.map((i) => [i.code, i.value])).toEqual([
      [1000, 'https://example.com'],
      [1002, '{'],
      [1000, '설명'],
      [1000, 'VIEW1'],
      [1002, '}'],
    ]);
    expect(readHyperlink({ xdata: xd })).toEqual({ url: 'https://example.com', description: '설명', location: 'VIEW1' });
  });

  it('주소만 있으면 1000 하나, 지우면 PE_URL만 빠진다', () => {
    const xd = withHyperlink(undefined, { url: 'www.example.com', description: '', location: '' })!;
    expect(xd[0]!.items).toEqual([{ code: 1000, value: 'www.example.com' }]);
    expect(withHyperlink(xd, null)).toBeUndefined();
    expect(isWebUrl('www.example.com')).toBe(true);
    expect(isWebUrl('C:\\a\\b.dwg')).toBe(false);
    expect(hyperlinkLabel({ url: '', description: '', location: 'A' })).toBe('#A');
  });
});
