/**
 * ATTEXT·-ATTEXT(속성 추출, UI 없음): 블록 참조의 속성을 CDF(쉼표 구분)·SDF(고정 폭)·DXF(DXX) 글로 쓴다.
 *
 * 템플릿 파일(CDF·SDF): 한 줄에 `필드 이름  형식`. 형식은 `C` 또는 `N`과 숫자 여섯 자리(앞 셋 = 필드 폭, 뒤 셋 = 소수 자리).
 * - 블록 필드: BL:LEVEL(중첩 수준), BL:NAME, BL:X·BL:Y·BL:Z(삽입점, WCS), BL:NUMBER(블록 번호), BL:HANDLE, BL:LAYER,
 *   BL:ORIENT(회전, 도), BL:XSCALE·BL:YSCALE·BL:ZSCALE, BL:XEXTRUDE·BL:YEXTRUDE·BL:ZEXTRUDE.
 * - 그 밖의 이름은 속성 태그. C면 문자, N이면 숫자로 쓴다.
 * - CDF 구분 기호 바꾸기: `C:QUOTE 문자`(문자 필드를 감쌀 기호, 기본 '), `C:DELIM 문자`(구분 기호, 기본 ,).
 * 템플릿에 든 속성 태그를 하나라도 가진 블록 참조만 한 레코드가 된다. 블록 안에 든(중첩) 블록 참조도 수준을 올려 쓴다.
 * DXF(DXX) 추출은 템플릿 없이 블록 참조와 속성(INSERT·ATTRIB·SEQEND)만 담은 ENTITIES 구역을 쓴다.
 */
import type { AttribEntity, CadDocument, Entity, InsertEntity, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { attribText } from './attout';

export interface TemplateField {
  /** 필드 이름(대문자) */
  name: string;
  kind: 'C' | 'N';
  width: number;
  decimals: number;
}

export interface Template {
  fields: TemplateField[];
  quote: string;
  delim: string;
  errors: string[];
}

const BL_FIELDS = new Set(['BL:LEVEL', 'BL:NAME', 'BL:X', 'BL:Y', 'BL:Z', 'BL:NUMBER', 'BL:HANDLE', 'BL:LAYER', 'BL:ORIENT', 'BL:XSCALE', 'BL:YSCALE', 'BL:ZSCALE', 'BL:XEXTRUDE', 'BL:YEXTRUDE', 'BL:ZEXTRUDE']);
/** 문자로만 쓰는 블록 필드 */
const BL_CHAR = new Set(['BL:NAME', 'BL:HANDLE', 'BL:LAYER']);

/** 템플릿 글 읽기 */
export function parseTemplate(text: string): Template {
  const t: Template = { fields: [], quote: "'", delim: ',', errors: [] };
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = /^(\S+)\s+(\S+)(?:\s+.*)?$/.exec(line);
    const name = (m?.[1] ?? line).toUpperCase();
    if (name === 'C:QUOTE' || name === 'C:DELIM') {
      const v = line.slice(name.length).trim();
      if (!v) t.errors.push(`${i + 1}번째 줄: ${name}의 기호가 없습니다.`);
      else if (name === 'C:QUOTE') t.quote = v[0]!;
      else t.delim = v[0]!;
      return;
    }
    const f = m ? /^([CN])(\d{3})(\d{3})$/i.exec(m[2]!) : null;
    if (!m || !f) {
      t.errors.push(`${i + 1}번째 줄: 필드 사양이 올바르지 않습니다: ${line}`);
      return;
    }
    const kind = f[1]!.toUpperCase() as 'C' | 'N';
    const width = Number(f[2]);
    const decimals = Number(f[3]);
    if (name.startsWith('BL:') && !BL_FIELDS.has(name)) {
      t.errors.push(`${i + 1}번째 줄: 알 수 없는 블록 필드 ${name}`);
      return;
    }
    if (BL_CHAR.has(name) && kind !== 'C') {
      t.errors.push(`${i + 1}번째 줄: ${name}은(는) 문자 필드(C)여야 합니다.`);
      return;
    }
    if (name.startsWith('BL:') && !BL_CHAR.has(name) && kind !== 'N') {
      t.errors.push(`${i + 1}번째 줄: ${name}은(는) 숫자 필드(N)여야 합니다.`);
      return;
    }
    if (width < 1) {
      t.errors.push(`${i + 1}번째 줄: 필드 폭이 0입니다.`);
      return;
    }
    t.fields.push({ name, kind, width, decimals: kind === 'C' ? 0 : decimals });
  });
  if (!t.fields.length && !t.errors.length) t.errors.push('템플릿에 필드가 없습니다.');
  return t;
}

/** 추출할 블록 참조 하나(중첩이면 바깥 참조를 거친 WCS 값) */
export interface ExtractBlock {
  level: number;
  /** 블록 번호(1부터, 추출 순서) */
  number: number;
  entity: InsertEntity;
  name: string;
  insert: Vec3;
  rotation: number;
  scale: Vec3;
  extrusion: Vec3;
}

type M = [number, number, number, number, number, number];
const ID: M = [1, 0, 0, 1, 0, 0];
const mul = (A: M, B: M): M => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];

/** 블록 참조의 블록 좌표 → 바깥 좌표(2D) */
function insertMatrix(doc: CadDocument, e: InsertEntity): M {
  const b = doc.blocks.get(tableKey(e.block))?.basePoint ?? { x: 0, y: 0, z: 0 };
  const c = Math.cos(e.rotation);
  const s = Math.sin(e.rotation);
  const sx = e.scale.x;
  const sy = e.scale.y;
  const a = c * sx;
  const bb = s * sx;
  const cc = -s * sy;
  const d = c * sy;
  return [a, bb, cc, d, e.insert.x - (a * b.x + cc * b.y), e.insert.y - (bb * b.x + d * b.y)];
}

/** 속성 태그 집합(대문자)을 가진 블록 참조(블록 안의 참조 포함)를 모은다. tags가 null이면 속성이 있는 모든 참조 */
export function collectBlocks(doc: CadDocument, top: readonly Entity[], tags: ReadonlySet<string> | null): ExtractBlock[] {
  const out: ExtractBlock[] = [];
  const has = (e: InsertEntity) => e.attribs.some((a) => (tags ? tags.has(a.tag.toUpperCase()) : !!a.tag));
  const walk = (list: readonly Entity[], m: M, rot: number, sc: Vec3, level: number, chain: string[]) => {
    for (const e of list) {
      if (e.type !== 'INSERT') continue;
      const mm = mul(m, insertMatrix(doc, e));
      const p = { x: m[0] * e.insert.x + m[2] * e.insert.y + m[4], y: m[1] * e.insert.x + m[3] * e.insert.y + m[5], z: e.insert.z };
      const r = rot + e.rotation;
      const s = { x: sc.x * e.scale.x, y: sc.y * e.scale.y, z: sc.z * e.scale.z };
      if (has(e)) out.push({ level, number: out.length + 1, entity: e, name: e.block, insert: p, rotation: r, scale: s, extrusion: e.extrusion ?? { x: 0, y: 0, z: 1 } });
      const k = tableKey(e.block);
      const def = doc.blocks.get(k);
      if (def && !(def.flags & 4) && !chain.includes(k) && chain.length < 16) walk(def.entities, mm, r, s, level + 1, [...chain, k]);
    }
  };
  walk(top, ID, 0, { x: 1, y: 1, z: 1 }, 1, []);
  return out;
}

/** 템플릿 필드 값(숫자 필드는 수, 문자 필드는 글). 속성이 없으면 null */
function fieldValue(b: ExtractBlock, f: TemplateField, displayName: (b: ExtractBlock) => string): string | number | null {
  const R = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  switch (f.name) {
    case 'BL:LEVEL':
      return b.level;
    case 'BL:NAME':
      return displayName(b);
    case 'BL:X':
      return R(b.insert.x);
    case 'BL:Y':
      return R(b.insert.y);
    case 'BL:Z':
      return R(b.insert.z);
    case 'BL:NUMBER':
      return b.number;
    case 'BL:HANDLE':
      return b.entity.handle;
    case 'BL:LAYER':
      return b.entity.layer;
    case 'BL:ORIENT': {
      let d = (b.rotation * 180) / Math.PI;
      d = ((d % 360) + 360) % 360;
      return R(Math.abs(d - 360) < 1e-9 ? 0 : d);
    }
    case 'BL:XSCALE':
      return b.scale.x;
    case 'BL:YSCALE':
      return b.scale.y;
    case 'BL:ZSCALE':
      return b.scale.z;
    case 'BL:XEXTRUDE':
      return b.extrusion.x;
    case 'BL:YEXTRUDE':
      return b.extrusion.y;
    case 'BL:ZEXTRUDE':
      return b.extrusion.z;
  }
  const a = b.entity.attribs.find((x) => x.tag.toUpperCase() === f.name);
  return a ? attribText(a as AttribEntity) : null;
}

export interface ExtractOutput {
  text: string;
  records: number;
  /** 필드 넘침·숫자가 아닌 값 같은 알림 */
  warnings: string[];
}

/** 템플릿대로 CDF·SDF 글을 만든다(줄 끝 CRLF) */
export function formatRecords(blocks: readonly ExtractBlock[], t: Template, format: 'CDF' | 'SDF', displayName: (b: ExtractBlock) => string = (b) => b.name): ExtractOutput {
  const warnings: string[] = [];
  const lines: string[] = [];
  blocks.forEach((b, ri) => {
    const cells: string[] = [];
    for (const f of t.fields) {
      const v = fieldValue(b, f, displayName);
      let s: string;
      if (f.kind === 'N') {
        let n = typeof v === 'number' ? v : v === null || v.trim() === '' ? 0 : Number(v.trim());
        if (!Number.isFinite(n)) {
          warnings.push(`레코드 ${ri + 1}: ${f.name}의 값 "${String(v)}"이(가) 숫자가 아니어서 0으로 썼습니다.`);
          n = 0;
        }
        s = n.toFixed(f.decimals);
        if (s.length > f.width) {
          warnings.push(`레코드 ${ri + 1}: ${f.name} 필드 넘침(${s})`);
          s = s.slice(0, f.width);
        }
        cells.push(format === 'SDF' ? s.padStart(f.width) : s);
      } else {
        s = v === null ? '' : String(v);
        if (s.length > f.width) {
          warnings.push(`레코드 ${ri + 1}: ${f.name} 필드 넘침(${s})`);
          s = s.slice(0, f.width);
        }
        cells.push(format === 'SDF' ? s.padEnd(f.width) : `${t.quote}${s.replace(/\s+$/, '')}${t.quote}`);
      }
    }
    lines.push(format === 'SDF' ? cells.join('') : cells.join(t.delim));
  });
  return { text: lines.length ? `${lines.join('\r\n')}\r\n` : '', records: lines.length, warnings };
}

/** 템플릿의 속성 태그(BL: 필드 빼고) */
export function templateTags(t: Template): Set<string> {
  return new Set(t.fields.filter((f) => !f.name.startsWith('BL:')).map((f) => f.name));
}

/** DXF(DXX) 추출: 블록 참조와 속성만 담은 ENTITIES 구역 */
export function formatDxx(blocks: readonly ExtractBlock[]): ExtractOutput {
  const out: string[] = [];
  const tag = (code: number, v: string | number) => {
    out.push(String(code).padStart(3), typeof v === 'number' ? fnum(v) : v);
  };
  tag(0, 'SECTION');
  tag(2, 'ENTITIES');
  for (const b of blocks) {
    const e = b.entity;
    tag(0, 'INSERT');
    tag(5, e.handle);
    tag(8, e.layer);
    tag(66, 1);
    tag(2, e.block);
    tag(10, b.insert.x);
    tag(20, b.insert.y);
    tag(30, b.insert.z);
    if (b.scale.x !== 1) tag(41, b.scale.x);
    if (b.scale.y !== 1) tag(42, b.scale.y);
    if (b.scale.z !== 1) tag(43, b.scale.z);
    if (b.rotation) tag(50, (b.rotation * 180) / Math.PI);
    for (const a of e.attribs) {
      tag(0, 'ATTRIB');
      if (a.handle) tag(5, a.handle);
      tag(8, a.layer);
      tag(10, a.insert.x);
      tag(20, a.insert.y);
      tag(30, a.insert.z);
      tag(40, a.height);
      tag(1, attribText(a));
      tag(2, a.tag);
      tag(70, a.attFlags);
      if (a.rotation) tag(50, (a.rotation * 180) / Math.PI);
      if (a.style && a.style.toUpperCase() !== 'STANDARD') tag(7, a.style);
    }
    tag(0, 'SEQEND');
    tag(8, e.layer);
  }
  tag(0, 'ENDSEC');
  tag(0, 'EOF');
  return { text: `${out.join('\r\n')}\r\n`, records: blocks.length, warnings: [] };
}

function fnum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(+v.toPrecision(15));
}
