/** WMFOUT: Windows 메타파일 레코드 바이트([MS-WMF])와 표시 목록 받개 */
import { describe, expect, it } from 'vitest';
import { WMF_FN, WMF_PLACEABLE_KEY, WmfSink, WmfWriter, readWmf, wmfScale } from '../../src/edit/filecmds/wmf';

const s16 = (v: number) => (v << 16) >> 16;

describe('WmfWriter', () => {
  it('배치 가능 머리·META_HEADER·초기 레코드·EOF', () => {
    const w = new WmfWriter(1000, 500, 1440);
    const data = w.finish();
    const dv = new DataView(data.buffer);
    expect(dv.getUint32(0, true)).toBe(WMF_PLACEABLE_KEY);
    // 경계 상자 (0, 0) - (1000, 500), 1인치 = 1440
    expect([dv.getInt16(6, true), dv.getInt16(8, true), dv.getInt16(10, true), dv.getInt16(12, true)]).toEqual([0, 0, 1000, 500]);
    expect(dv.getUint16(14, true)).toBe(1440);
    let sum = 0;
    for (let i = 0; i < 10; i++) sum ^= dv.getUint16(i * 2, true);
    expect(dv.getUint16(20, true)).toBe(sum);
    // META_HEADER: 메모리 메타파일, 머리 9낱말, 버전 0x0300
    expect(dv.getUint16(22, true)).toBe(1);
    expect(dv.getUint16(24, true)).toBe(9);
    expect(dv.getUint16(26, true)).toBe(0x0300);
    // 전체 크기(낱말) = 머리 뒤의 바이트 / 2
    const size = dv.getUint16(28, true) | (dv.getUint16(30, true) << 16);
    expect(size * 2).toBe(data.length - 22);
    const r = readWmf(data);
    expect(r.placeable.checksumOk).toBe(true);
    expect(r.records.map((x) => x.fn)).toEqual([WMF_FN.SETMAPMODE, WMF_FN.SETWINDOWORG, WMF_FN.SETWINDOWEXT, WMF_FN.SETBKMODE, WMF_FN.SETPOLYFILLMODE, WMF_FN.EOF]);
    expect([...r.records[0]!.params]).toEqual([8]);
    // 창 크기: y 먼저
    expect([...r.records[2]!.params]).toEqual([500, 1000]);
    // 마지막 6바이트 = META_EOF(크기 3, 함수 0)
    expect([...data.slice(-6)]).toEqual([3, 0, 0, 0, 0, 0]);
  });

  it('펜·붓은 객체 표의 빈 자리를 다시 쓰고, 꺾은선·다각형 묶음 레코드를 쓴다', () => {
    const w = new WmfWriter(100, 100, 1000);
    w.setPen(0xff0000, 3);
    w.polyline([0, 0, 10, 0, 10, 10]);
    w.setPen(0x0000ff, 0);
    w.setBrush(0x00ff00);
    w.polyPolygon([
      [0, 0, 5, 0, 0, 5],
      [10, 10, 20, 10, 10, 20],
    ]);
    const r = readWmf(w.finish());
    const recs = r.records.slice(5);
    // 빨강 펜: PS_SOLID, 폭 3, COLORREF(R, G, B, 0)
    expect(recs[0]!.fn).toBe(WMF_FN.CREATEPENINDIRECT);
    expect([...recs[0]!.params]).toEqual([0, 3, 0, 0x00ff, 0x0000]);
    expect(recs[1]).toMatchObject({ fn: WMF_FN.SELECTOBJECT });
    expect([...recs[1]!.params]).toEqual([0]);
    expect(recs[2]!.fn).toBe(WMF_FN.POLYLINE);
    expect([...recs[2]!.params]).toEqual([3, 0, 0, 10, 0, 10, 10]);
    // 파랑 펜은 자리 1, 고른 뒤 빨강(자리 0)을 지운다
    expect(recs[3]!.fn).toBe(WMF_FN.CREATEPENINDIRECT);
    expect([...recs[3]!.params]).toEqual([0, 0, 0, 0x0000, 0x00ff]);
    expect([...recs[4]!.params]).toEqual([1]);
    expect(recs[5]).toMatchObject({ fn: WMF_FN.DELETEOBJECT });
    expect([...recs[5]!.params]).toEqual([0]);
    // 초록 붓은 빈 자리 0
    expect(recs[6]!.fn).toBe(WMF_FN.CREATEBRUSHINDIRECT);
    expect([...recs[6]!.params]).toEqual([0, 0xff00, 0x0000, 0]);
    expect([...recs[7]!.params]).toEqual([0]);
    expect(recs[8]!.fn).toBe(WMF_FN.POLYPOLYGON);
    expect([...recs[8]!.params]).toEqual([2, 3, 3, 0, 0, 5, 0, 0, 5, 10, 10, 20, 10, 10, 20]);
    expect(r.header.objects).toBe(2);
    expect(r.header.maxRecord).toBe(3 + 15);
  });

  it('자르기: SAVEDC·INTERSECTCLIPRECT(아래·오른쪽·위·왼쪽)·RESTOREDC, 그 사이 만든 펜은 풀린 뒤 지운다', () => {
    const w = new WmfWriter(100, 100, 1000);
    w.setPen(0, 0);
    w.saveDC();
    w.clipRect(1, 2, 30, 40);
    w.setPen(0xffffff, 0);
    w.polyline([0, 0, 1, 1]);
    w.restoreDC();
    const recs = readWmf(w.finish()).records.slice(5);
    const fns = recs.map((x) => x.fn);
    expect(fns).toEqual([
      WMF_FN.CREATEPENINDIRECT,
      WMF_FN.SELECTOBJECT,
      WMF_FN.SAVEDC,
      WMF_FN.INTERSECTCLIPRECT,
      WMF_FN.CREATEPENINDIRECT,
      WMF_FN.SELECTOBJECT,
      WMF_FN.POLYLINE,
      WMF_FN.RESTOREDC,
      WMF_FN.DELETEOBJECT,
      WMF_FN.EOF,
    ]);
    expect([...recs[3]!.params]).toEqual([40, 30, 2, 1]);
    // saveDC 때 고른 검정 펜(자리 0)은 지우지 않고, 안에서 만든 흰 펜(자리 1)만 지운다
    expect([...recs[8]!.params]).toEqual([1]);
    expect(s16(recs[7]!.params[0]!)).toBe(-1);
  });

  it('좌표는 16비트로 자른다', () => {
    const w = new WmfWriter(100, 100, 1000);
    w.polyline([-50000, 0, 50000, 1]);
    const p = readWmf(w.finish()).records[5]!.params;
    expect([s16(p[1]!), s16(p[3]!)]).toEqual([-32768, 32767]);
  });
});

describe('WmfSink', () => {
  it('이어지는 같은 스타일 선분은 꺾은선 하나로, 스타일이 바뀌면 새 펜', () => {
    const w = new WmfWriter(100, 100, 1000);
    const sink = new WmfSink(w, 10, (s) => ({ rgb: s === 1 ? 0xff0000 : 0, width: s }));
    sink.seg(0, 0, 1, 0, 1);
    sink.seg(1, 0, 1, 1, 1);
    sink.seg(1, 1, 0, 1, 1);
    sink.seg(5, 5, 6, 6, 2);
    sink.flush();
    const recs = readWmf(w.finish()).records.slice(5);
    const lines = recs.filter((r) => r.fn === WMF_FN.POLYLINE);
    expect(lines.map((r) => [...r.params])).toEqual([
      [4, 0, 0, 10, 0, 10, 10, 0, 10],
      [2, 50, 50, 60, 60],
    ]);
    expect(recs.filter((r) => r.fn === WMF_FN.CREATEPENINDIRECT).map((r) => r.params[1])).toEqual([1, 2]);
  });

  it('삼각형은 같은 방향으로 맞춰 다각형 묶음으로, 넓이 0은 뺀다', () => {
    const w = new WmfWriter(100, 100, 1000);
    const sink = new WmfSink(w, 1, () => ({ rgb: 0x123456, width: 0 }));
    sink.tri(0, 0, 10, 0, 0, 10, 0);
    sink.tri(0, 0, 0, 10, 10, 0, 0);
    sink.tri(0, 0, 1, 1, 2, 2, 0);
    sink.flush();
    const recs = readWmf(w.finish()).records.slice(5);
    const pp = recs.find((r) => r.fn === WMF_FN.POLYPOLYGON)!;
    expect([...pp.params]).toEqual([2, 3, 3, 0, 0, 10, 0, 0, 10, 0, 0, 10, 0, 0, 10]);
    // 채우기는 같은 색 붓과 1픽셀 펜
    const brush = recs.find((r) => r.fn === WMF_FN.CREATEBRUSHINDIRECT)!;
    expect([...brush.params]).toEqual([0, 0x3412, 0x56, 0]);
  });

  it('배율: 16비트에 들어가고 1인치가 1440 논리 단위를 넘지 않는다', () => {
    const a3 = wmfScale(420, 297, 25.4);
    expect(a3.inch).toBeLessThanOrEqual(1440);
    expect(a3.w).toBeLessThanOrEqual(32767);
    const a0 = wmfScale(1189, 841, 25.4);
    expect(a0.w).toBeLessThanOrEqual(32000);
    expect(a0.inch).toBe(Math.round(25.4 * a0.k));
  });
});
