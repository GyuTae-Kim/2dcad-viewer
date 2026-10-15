/**
 * 3D 문서로 여는 파일 가리기(확장자) — 순수 함수. 열기 상자·끌어 놓기·최근 파일·?open= 주소가 함께 쓴다.
 * NC(G-code·Heidenhain·woodWOP MPR), STEP, SketchUp(.skp)는 3D 문서 탭으로, 나머지는 2D 엔진으로 보낸다.
 */
import { GCODE_EXTENSIONS, HEIDENHAIN_EXTENSIONS, MPR_EXTENSIONS, NC_EXTENSIONS } from '../../formats/nc/index';

export type View3dFormat = 'nc' | 'step' | 'skp';

/** STEP 확장자(점 없이) */
export const STEP_EXTENSIONS = ['stp', 'step', 'p21'];
/** SketchUp 확장자 */
export const SKP_EXTENSIONS = ['skp'];

/** 2D 엔진이 여는 확장자(열기 상자 accept용) */
const EXTENSIONS_2D = ['dxf', 'dwg', 'scr', 'lsp'];

/** 파일 이름의 확장자(소문자, 점 없이). 없으면 '' */
export function fileExtension(name: string): string {
  const base = name.replace(/^.*[\\/]/, '');
  const m = /\.([^.]+)$/.exec(base);
  return m ? m[1]!.toLowerCase() : '';
}

/** 3D 문서로 열 형식(아니면 null) */
export function view3dFormat(name: string): View3dFormat | null {
  const e = fileExtension(name);
  if (!e) return null;
  if (STEP_EXTENSIONS.includes(e)) return 'step';
  if (SKP_EXTENSIONS.includes(e)) return 'skp';
  if (NC_EXTENSIONS.includes(e)) return 'nc';
  return null;
}

/** 탭·정보에 쓰는 형식 이름 */
export function view3dFormatLabel(name: string): string {
  const e = fileExtension(name);
  if (STEP_EXTENSIONS.includes(e)) return 'STEP';
  if (SKP_EXTENSIONS.includes(e)) return 'SketchUp';
  if (MPR_EXTENSIONS.includes(e)) return 'woodWOP MPR';
  if (HEIDENHAIN_EXTENSIONS.includes(e)) return 'Heidenhain';
  if (GCODE_EXTENSIONS.includes(e)) return 'G-code';
  return '';
}

/** 열기 상자의 accept 값(2D·3D 확장자 모두, 대문자 판도 넣는다) */
export function fileAccept(): string {
  const all = [...EXTENSIONS_2D, ...NC_EXTENSIONS, ...STEP_EXTENSIONS, ...SKP_EXTENSIONS];
  const out: string[] = [];
  for (const e of all) {
    out.push(`.${e}`);
    if (e.toUpperCase() !== e) out.push(`.${e.toUpperCase()}`);
  }
  return [...new Set(out)].join(',');
}
