import { describe, expect, it } from 'vitest';
import { ACI_RGB, nearestAci } from '../../src/core/color';

describe('ACI 색표', () => {
  it('AutoCAD 기본 팔레트 값', () => {
    expect(ACI_RGB[1]).toBe(0xff0000);
    expect(ACI_RGB[10]).toBe(0xff0000);
    expect(ACI_RGB[11]).toBe(0xff7f7f);
    expect(ACI_RGB[12]).toBe(0xcc0000);
    expect(ACI_RGB[13]).toBe(0xcc6666);
    expect(ACI_RGB[14]).toBe(0x990000);
    expect(ACI_RGB[19]).toBe(0x4c2626);
    expect(ACI_RGB[30]).toBe(0xff7f00);
    expect(ACI_RGB[250]).toBe(0x333333);
  });
  it('AutoCAD가 저장한 트루컬러의 ACI(9B42EC → 193)', () => {
    expect(nearestAci(0x9b42ec)).toBe(193);
  });
});
