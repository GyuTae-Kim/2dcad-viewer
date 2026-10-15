/**
 * SketchUp(.skp) 해석기 — 클린룸: 공개 표본 파일의 바이트만 보고 구조를 추론했다(docs/formats/skp.md).
 *
 * 지원: SketchUp 2021~2026(머리 뒤 "VFF" 블록 + ZIP 꾸러미, 안의 model.dat가 TLV). 면(구멍 포함)·모서리·재질 색·
 * 그룹/컴포넌트 인스턴스 변환·태그를 읽는다. 무늬(텍스처)·문자·치수·보조선·장면은 아직 읽지 않는다.
 * 2020 이하(MFC 객체 직렬화)는 아직 읽지 못해 경고와 함께 빈 장면을 돌려준다.
 */

import type { Scene3d } from '../../viewer3d/types';
import { readSkpHeader } from './header';
import { parseMaterialXml, type SkpMaterialInfo } from './materials';
import { readModelDat, type SkpModel } from './model';
import { buildSceneParts } from './scene';
import { readZipDirectory, readZipItem } from './zip';

export { readSkpHeader, type SkpHeader } from './header';
export { readModelDat, type SkpModel } from './model';

/** 확인한 가장 낮은 판(이보다 낮으면 형식이 다르다) */
export const SKP_MIN_SUPPORTED_MAJOR = 21;
/** 표본으로 확인한 가장 높은 판 */
export const SKP_MAX_CHECKED_MAJOR = 26;

export interface SkpOptions {
  /** 장면 이름(보통 파일 이름) */
  name?: string;
}

/** UnitsOptions/LengthUnit → 장면 단위와 인치에서의 배율 */
function unitsFor(lengthUnit: number | undefined): { units: Scene3d['units']; scale: number; label: string } {
  switch (lengthUnit) {
    case 2:
      return { units: 'mm', scale: 25.4, label: 'mm' };
    case 3:
      return { units: 'mm', scale: 25.4, label: 'cm' };
    case 4:
      return { units: 'm', scale: 0.0254, label: 'm' };
    case 1:
      return { units: 'inch', scale: 1, label: 'ft' };
    default:
      return { units: 'inch', scale: 1, label: 'inch' };
  }
}

function emptyScene(name: string, warnings: string[], meta: Record<string, unknown>): Scene3d {
  return { name, units: 'unknown', meshes: [], lines: [], warnings, meta };
}

/** SKP 바이트 → 장면. 읽지 못하는 판·깨진 파일은 경고와 함께 빈(또는 일부) 장면 */
export function skpToScene(bytes: Uint8Array, opts: SkpOptions = {}): Scene3d {
  const name = opts.name ?? 'SketchUp 모형';
  const header = readSkpHeader(bytes);
  if (!header) return emptyScene(name, ['SketchUp 파일이 아닙니다(머리 표지 "SketchUp Model"이 없습니다)'], { format: 'SketchUp' });
  const meta: Record<string, unknown> = { format: 'SketchUp', version: header.version, container: header.container };
  if (header.container !== 'zip' || !(header.major >= SKP_MIN_SUPPORTED_MAJOR))
    return emptyScene(
      name,
      [`아직 지원하지 않는 SketchUp 버전 ${header.version}입니다(2020 이하의 옛 이진 형식). SketchUp 2021 이상으로 저장한 파일을 열어 주세요.`],
      meta,
    );

  const warnings: string[] = [];
  if (header.major > SKP_MAX_CHECKED_MAJOR)
    warnings.push(`표본으로 확인하지 않은 SketchUp 버전 ${header.version}입니다. 2021~2026 형식으로 읽어 봅니다.`);
  let model: SkpModel;
  const materials = new Map<string, SkpMaterialInfo>();
  try {
    const dir = readZipDirectory(bytes);
    if (!dir) return emptyScene(name, ['SketchUp 꾸러미(ZIP)를 찾지 못했습니다'], meta);
    const modelItem = dir.find((d) => d.name === 'model.dat');
    if (!modelItem) return emptyScene(name, ['꾸러미에 model.dat가 없습니다'], meta);
    const text = new TextDecoder('utf-8');
    for (const item of dir) {
      const m = /^materials\/(.+)\/material\.xml$/.exec(item.name);
      if (!m) continue;
      try {
        const info = parseMaterialXml(text.decode(readZipItem(bytes, item)));
        if (!info) continue;
        // model.dat의 재질 이름은 폴더 이름과 같고(예: '<Black>' → '_Black_'), XML의 name은 원래 이름이다 → 둘 다로 찾는다
        materials.set(m[1]!, info);
        if (!materials.has(info.name)) materials.set(info.name, info);
      } catch {
        warnings.push(`재질 파일을 읽지 못했습니다: ${item.name}`);
      }
    }
    model = readModelDat(readZipItem(bytes, modelItem));
  } catch (e) {
    return emptyScene(name, [`SketchUp 파일을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`], meta);
  }
  warnings.push(...model.warnings);

  const u = unitsFor(model.lengthUnit);
  let parts: ReturnType<typeof buildSceneParts>;
  try {
    parts = buildSceneParts(model, materials, u.scale);
  } catch (e) {
    return emptyScene(name, [...warnings, `장면을 만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`], meta);
  }
  warnings.push(...parts.warnings);
  Object.assign(meta, {
    lengthUnit: u.label,
    definitions: model.definitions.size,
    instances: model.counts.instances,
    faces: model.counts.faces,
    edges: model.counts.edges,
    materials: model.materials.size,
    tags: [...model.layers.values()],
    triangles: parts.stats.triangles,
    segments: parts.stats.segments,
  });
  const scene: Scene3d = { name, units: u.units, meshes: parts.meshes, lines: parts.lines, warnings, meta };
  if (parts.bounds) scene.bounds = parts.bounds;
  return scene;
}
