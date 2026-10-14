/** 치수 테스트용 빈 도면: Standard(acad 기본)·ISO-25 치수 스타일과 Arial 문자 스타일 */
import { DIM_VAR_DEFAULTS } from '../../src/core/dimvars';
import { type CadDocument, type Entity, createDocument } from '../../src/core/model';

/** AutoCAD acadiso.dwt의 ISO-25 값 */
export const ISO25: Record<string, number | string> = {
  ...DIM_VAR_DEFAULTS,
  DIMASZ: 2.5,
  DIMEXO: 0.625,
  DIMDLI: 3.75,
  DIMEXE: 1.25,
  DIMTIH: 0,
  DIMTOH: 0,
  DIMTAD: 1,
  DIMZIN: 8,
  DIMTXT: 2.5,
  DIMCEN: 2.5,
  DIMALTF: 0.0393700787,
  DIMGAP: 0.625,
  DIMALTD: 3,
  DIMTOFL: 1,
  DIMDEC: 2,
  DIMTDEC: 2,
  DIMALTTD: 3,
  DIMDSEP: 44,
  DIMTOLJ: 0,
  DIMTZIN: 8,
};

export function makeDoc(styles: Record<string, Record<string, number | string>> = {}): CadDocument {
  const doc = createDocument('new');
  doc.textStyles.set('STANDARD', {
    name: 'Standard',
    handle: '11',
    flags: 0,
    height: 0,
    widthFactor: 1,
    oblique: 0,
    generation: 0,
    lastHeight: 2.5,
    font: 'arial.ttf',
    bigFont: '',
    fontFamily: 'Arial',
  });
  const all: Record<string, Record<string, number | string>> = { Standard: { ...DIM_VAR_DEFAULTS }, 'ISO-25': ISO25, ...styles };
  let h = 0x100;
  for (const [name, vars] of Object.entries(all)) doc.dimStyles.set(name.toUpperCase(), { name, handle: (h++).toString(16).toUpperCase(), flags: 0, vars: { ...vars } });
  doc.layers.set('0', { name: '0', handle: '10', flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 });
  doc.header.set('$DIMSTYLE', 'ISO-25');
  doc.header.set('$CLAYER', '0');
  return doc;
}

/** 종류가 T인 객체 형식(SOLID처럼 여러 종류를 묶은 형식도 고른다) */
type OfType<T extends string> = Entity extends infer E ? (E extends { type: infer U } ? (T extends U ? E : never) : never) : never;
export const of = <T extends Entity['type']>(es: Entity[], t: T) => es.filter((e) => e.type === t) as OfType<T>[];
