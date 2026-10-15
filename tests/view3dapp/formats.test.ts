import { describe, expect, it } from 'vitest';
import { fileAccept, fileExtension, view3dFormat, view3dFormatLabel } from '../../src/app/view3d/formats';
import { NC_EXTENSIONS } from '../../src/formats/nc/index';

describe('확장자 판별·라우팅', () => {
  it('확장자: 경로·대소문자·점 여러 개', () => {
    expect(fileExtension('a/b/c.NC')).toBe('nc');
    expect(fileExtension('C:\\x\\part.v2.STEP')).toBe('step');
    expect(fileExtension('noext')).toBe('');
    expect(fileExtension('dir.d/noext')).toBe('');
    expect(fileExtension('.gcode')).toBe('gcode');
  });

  it('NC·STEP·SKP는 3D, 나머지는 2D(null)', () => {
    for (const n of ['p.nc', 'p.gcode', 'p.ngc', 'p.tap', 'p.cnc', 'P.H', 'cab.mpr', 'x.MPF']) expect(view3dFormat(n)).toBe('nc');
    for (const n of ['a.stp', 'a.STEP', 'b.p21']) expect(view3dFormat(n)).toBe('step');
    expect(view3dFormat('house.skp')).toBe('skp');
    for (const n of ['plan.dxf', 'plan.DWG', 'run.scr', 'tool.lsp', 'readme', 'photo.png']) expect(view3dFormat(n)).toBeNull();
  });

  it('NC 확장자는 모두 3D로', () => {
    for (const e of NC_EXTENSIONS) expect(view3dFormat(`x.${e}`)).toBe('nc');
  });

  it('형식 이름', () => {
    expect(view3dFormatLabel('a.mpr')).toBe('woodWOP MPR');
    expect(view3dFormatLabel('a.h')).toBe('Heidenhain');
    expect(view3dFormatLabel('a.nc')).toBe('G-code');
    expect(view3dFormatLabel('a.stp')).toBe('STEP');
    expect(view3dFormatLabel('a.skp')).toBe('SketchUp');
    expect(view3dFormatLabel('a.dxf')).toBe('');
  });

  it('열기 상자 accept: 2D·3D 확장자와 대문자 판, 겹침 없음', () => {
    const a = fileAccept().split(',');
    for (const e of ['.dxf', '.DWG', '.scr', '.lsp', '.nc', '.NC', '.gcode', '.h', '.mpr', '.stp', '.STEP', '.skp', '.SKP']) expect(a).toContain(e);
    expect(new Set(a).size).toBe(a.length);
    expect(a.every((x) => /^\.[A-Za-z0-9]+$/.test(x))).toBe(true);
  });
});
