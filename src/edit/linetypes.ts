/**
 * 표준 선종류 목록(이 프로젝트에서 직접 정한 정의).
 * 이름은 널리 쓰는 관례를 따르고, 길이는 인치 단위(영국식) 또는 mm 단위(ISO)다.
 * 양수 = 선, 음수 = 틈, 0 = 점.
 */
import type { Linetype } from '../core/model';

interface LtDef {
  name: string;
  description: string;
  /** 인치(ANSI 계열) 또는 mm(ISO 계열) */
  dashes: number[];
  iso?: boolean;
}

const BASE: LtDef[] = [
  { name: 'BORDER', description: 'Border __ __ . __ __ . __ __ .', dashes: [0.5, -0.25, 0.5, -0.25, 0, -0.25] },
  { name: 'CENTER', description: 'Center ____ _ ____ _ ____', dashes: [1.25, -0.25, 0.25, -0.25] },
  { name: 'DASHDOT', description: 'Dash dot __ . __ . __ .', dashes: [0.5, -0.25, 0, -0.25] },
  { name: 'DASHED', description: 'Dashed __ __ __ __', dashes: [0.5, -0.25] },
  { name: 'DIVIDE', description: 'Divide ____ . . ____ . .', dashes: [0.5, -0.25, 0, -0.25, 0, -0.25] },
  { name: 'DOT', description: 'Dot . . . . . . .', dashes: [0, -0.25] },
  { name: 'HIDDEN', description: 'Hidden __ __ __ __', dashes: [0.25, -0.125] },
  { name: 'PHANTOM', description: 'Phantom ______  __  __  ______', dashes: [1.25, -0.25, 0.25, -0.25, 0.25, -0.25] },
];

const ISO: LtDef[] = [
  { name: 'ACAD_ISO02W100', description: 'ISO dash __ __ __', dashes: [12, -3], iso: true },
  { name: 'ACAD_ISO03W100', description: 'ISO dash space __    __', dashes: [12, -18], iso: true },
  { name: 'ACAD_ISO04W100', description: 'ISO long-dash dot ____ . ____', dashes: [24, -3, 0, -3], iso: true },
  { name: 'ACAD_ISO05W100', description: 'ISO long-dash double-dot ____ .. ____', dashes: [24, -3, 0, -3, 0, -3], iso: true },
  { name: 'ACAD_ISO06W100', description: 'ISO long-dash triple-dot ____ ... ____', dashes: [24, -3, 0, -3, 0, -3, 0, -3], iso: true },
  { name: 'ACAD_ISO07W100', description: 'ISO dot . . . .', dashes: [0, -3], iso: true },
  { name: 'ACAD_ISO08W100', description: 'ISO long-dash short-dash ____ __ ____', dashes: [24, -3, 6, -3], iso: true },
  { name: 'ACAD_ISO09W100', description: 'ISO long-dash double-short-dash ____ __ __ ____', dashes: [24, -3, 6, -3, 6, -3], iso: true },
  { name: 'ACAD_ISO10W100', description: 'ISO dash dot __ . __ .', dashes: [12, -3, 0, -3], iso: true },
  { name: 'ACAD_ISO11W100', description: 'ISO double-dash dot __ __ . __ __ .', dashes: [12, -3, 12, -3, 0, -3], iso: true },
  { name: 'ACAD_ISO12W100', description: 'ISO dash double-dot __ . . __ . .', dashes: [12, -3, 0, -3, 0, -3], iso: true },
  { name: 'ACAD_ISO13W100', description: 'ISO double-dash double-dot __ __ . . __', dashes: [12, -3, 12, -3, 0, -3, 0, -3], iso: true },
  { name: 'ACAD_ISO14W100', description: 'ISO dash triple-dot __ . . . __', dashes: [12, -3, 0, -3, 0, -3, 0, -3], iso: true },
  { name: 'ACAD_ISO15W100', description: 'ISO double-dash triple-dot __ __ . . .', dashes: [12, -3, 12, -3, 0, -3, 0, -3, 0, -3], iso: true },
];

/** 기본 선종류의 절반(2)·두 배(X2) 변형까지 모두 */
export const STANDARD_LINETYPES: LtDef[] = [
  ...BASE.flatMap((d) => [
    d,
    { name: `${d.name}2`, description: d.description.replace(/^(\S+)/, '$1 (.5x)'), dashes: d.dashes.map((x) => x * 0.5) },
    { name: `${d.name}X2`, description: d.description.replace(/^(\S+)/, '$1 (2x)'), dashes: d.dashes.map((x) => x * 2) },
  ]),
  ...ISO,
];

/** 선종류 정의 → 표 레코드(metric이면 인치 정의를 mm로 바꾼다) */
export function makeLinetype(def: LtDef, handle: string, metric: boolean): Linetype {
  const k = !def.iso && metric ? 25.4 : 1;
  const dashes = def.dashes.map((x) => x * k);
  return {
    name: def.name,
    handle,
    flags: 0,
    description: def.description,
    patternLength: dashes.reduce((s, x) => s + Math.abs(x), 0),
    elements: dashes.map((length) => ({ length, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } })),
  };
}
