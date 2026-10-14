/**
 * DWG 쓰기 ↔ 비공개 엔진(블랙박스): 쓴 파일을 엔진의 공개 함수 read_dwg로 읽는다.
 * - 엔진이 오류 없이 읽고, 객체를 하나도 버리지 않아야 한다(dwg.object_invalid 없음).
 * - 엔진 결과(DXF로 저장 → ezdxf 요약)가 우리 리더로 다시 읽은 요약과 같아야 한다(normalize.ts의 알려진 차이만 맞춘다).
 * 엔진 결과는 쓴 파일 내용의 SHA-1로 .runtime/dwg-writer에 캐시한다(처음 한 번만 느리다).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CadDocument } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { summarizeDocument } from '../oracle/summarize';
import { compareSummaries } from '../oracle/compare';
import { PYTHON, hasPython } from '../oracle/ezdxf';
import { normalizePair } from './normalize';
import { ROOT, WRITE_VERSIONS, dwgSources, dxfSources, readSource, stable, syntheticDocument } from './writer-fixtures';

const CACHE = join(ROOT, '.runtime/dwg-writer');
const DUMP = join(ROOT, 'scripts/oracle/ezdxf_dump.py');
/** 캐시 무효화용(엔진 호출 방식이 바뀌면 올린다) */
const SCRIPT_VERSION = '1';

const ENGINE = `
import sys, json, os, importlib.util
from prisme_engine.io.dwg import read_dwg
spec = importlib.util.spec_from_file_location('ezdxf_dump', sys.argv[1])
dump = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dump)
for job in json.load(open(sys.argv[2])):
    out = job['out']
    try:
        r = read_dwg(open(job['in'], 'rb').read())
        tmp = out + '.dxf'
        r.doc.saveas(tmp)
        dump.main(tmp, out + '.sum.json')
        os.remove(tmp)
        res = {'ok': True, 'version': str(r.version), 'warnings': [str(w) for w in (r.warnings or [])]}
    except Exception as e:
        res = {'ok': False, 'error': repr(e)[:1000]}
    with open(out + '.json', 'w') as f:
        json.dump(res, f)
`;

interface Job {
  key: string;
  label: string;
  bytes: Uint8Array;
  hash: string;
}

interface EngineResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
  summary?: Record<string, unknown>;
}

const enabled = hasPython && existsSync(DUMP);
const results = new Map<string, EngineResult>();
const jobs = new Map<string, Job>();

function addJob(key: string, label: string, doc: CadDocument, version: string): void {
  const r = writeDwg(stable(doc), { version: version as never });
  const hash = createHash('sha1').update(SCRIPT_VERSION).update(r.data).digest('hex');
  jobs.set(key, { key, label, bytes: r.data, hash });
}

/** 시험할 원본: 표본 DWG × 모든 버전, DXF × 세 버전, 새 도면·여러 도형 도면 × 모든 버전 */
interface Case {
  key: string;
  label: string;
  make: () => CadDocument;
  versions: readonly string[];
}

const cases: Case[] = [];
for (const s of dwgSources()) cases.push({ key: `dwg/${s.group}/${s.name}`, label: s.name, make: () => readSource(s), versions: WRITE_VERSIONS });
for (const s of dxfSources()) cases.push({ key: `dxf/${s.group}/${s.name}`, label: s.name, make: () => readSource(s), versions: ['AC1015', 'AC1018', 'AC1032'] });
cases.push({ key: 'new/metric', label: '새 도면(미터)', make: () => createNewDocument('metric'), versions: WRITE_VERSIONS });
cases.push({ key: 'new/imperial', label: '새 도면(인치)', make: () => createNewDocument('imperial'), versions: WRITE_VERSIONS });
cases.push({ key: 'new/synthetic', label: '여러 도형 도면', make: syntheticDocument, versions: WRITE_VERSIONS });

describe.skipIf(!enabled)('DWG 쓰기 ↔ 엔진(블랙박스)', () => {
  beforeAll(() => {
    mkdirSync(join(CACHE, 'in'), { recursive: true });
    for (const c of cases) {
      const doc = c.make();
      for (const v of c.versions) addJob(`${c.key}@${v}`, `${c.label} → ${v}`, doc, v);
    }
    // 캐시에 없는 것만 엔진에 넘긴다. 입력 파일은 묶음(24개)마다 쓰고 지워 디스크를 적게 쓴다
    const pending = [...jobs.values()].filter((j) => !existsSync(join(CACHE, j.hash) + '.json'));
    for (let i = 0; i < pending.length; i += 24) {
      const todo: { in: string; out: string }[] = [];
      try {
        for (const j of pending.slice(i, i + 24)) {
          const inp = join(CACHE, 'in', `${j.hash}.dwg`);
          writeFileSync(inp, j.bytes);
          todo.push({ in: inp, out: join(CACHE, j.hash) });
        }
        const list = join(CACHE, 'jobs.json');
        writeFileSync(list, JSON.stringify(todo));
        execFileSync(PYTHON, ['-I', '-c', ENGINE, DUMP, list], { stdio: 'pipe', timeout: 3_600_000, maxBuffer: 1 << 26 });
      } finally {
        for (const t of todo) rmSync(t.in, { force: true });
      }
    }
    for (const j of jobs.values()) {
      const out = join(CACHE, j.hash);
      const res: EngineResult = existsSync(out + '.json') ? JSON.parse(readFileSync(out + '.json', 'utf8')) : { ok: false, error: '결과 없음' };
      if (res.ok && existsSync(out + '.sum.json')) res.summary = JSON.parse(readFileSync(out + '.sum.json', 'utf8'));
      results.set(j.key, res);
    }
  }, 3_600_000);

  for (const c of cases) {
    it(c.key, () => {
      for (const v of c.versions) {
        const key = `${c.key}@${v}`;
        const job = jobs.get(key)!;
        const res = results.get(key)!;
        expect(res.error ?? '', `${job.label}: 엔진 오류`).toBe('');
        expect(res.ok).toBe(true);
        // 엔진이 풀지 못해 버린 객체가 없어야 한다
        const invalid = (res.warnings ?? []).filter((w) => w.includes('dwg.object_invalid'));
        expect(invalid, job.label).toEqual([]);
        // 엔진 요약 ↔ 우리 리더 요약
        const doc = readDwg(job.bytes);
        const expected = res.summary!;
        const actual = summarizeDocument(doc) as Record<string, unknown>;
        normalizePair(expected, actual, doc);
        for (const list of Object.values(expected.blocks as Record<string, { type: string; flags?: unknown; text?: unknown }[]>)) {
          for (const e of list) {
            // SPLINE 플래그(평면·선형 판정)는 리더마다 다르다
            if (e.type === 'SPLINE') e.flags = null;
            // DXF 리더는 캐럿 표기(^J)를 풀지 않아 글자 그대로 들어온다. 엔진 DXF는 글자 ^를 "^ "로 쓴다
            if (typeof e.text === 'string') e.text = e.text.replace(/\^ /g, '^');
          }
        }
        const d = compareSummaries(expected, actual);
        if (d.length) console.log(job.label, JSON.stringify(d.slice(0, 8)));
        expect(d, job.label).toEqual([]);
      }
    });
  }
});
