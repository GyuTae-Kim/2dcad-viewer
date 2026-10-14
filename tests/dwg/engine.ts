/**
 * 비공개 엔진의 공개 함수 read_dwg를 블랙박스로 불러 쓴 DWG가 열리는지 본다(로컬 개발 전용).
 * 결과: 열렸는지, 경고 문자열, 엔진이 만든 문서의 객체 종류별 개수(DXF 이름). 파일 내용 SHA-1로 캐시한다.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PYTHON, hasPython } from '../oracle/ezdxf';
import { ROOT } from './writer-fixtures';

const CACHE = join(ROOT, '.runtime/io3/engine');
const VERSION = '2';
/** 이 시험 실행(작업자)만의 이름표 */
const RUN = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

const SCRIPT = `
import sys, json
from collections import Counter
from prisme_engine.io.dwg import read_dwg
for job in json.load(open(sys.argv[1])):
    try:
        r = read_dwg(open(job['in'], 'rb').read())
        counts = Counter(e.dxftype() for e in r.doc.entitydb.values())
        tables = []
        for e in r.doc.entitydb.values():
            if e.dxftype() != 'ACAD_TABLE':
                continue
            cells, cur, hdr = [], None, {}
            for t in e.xtags.get_subclass('AcDbTable'):
                if t.code == 171:
                    cur = {}
                    cells.append(cur)
                    continue
                if cur is None:
                    hdr.setdefault(t.code, t.value)
                    continue
                if t.code == 301:
                    cur['v'] = 1
                if t.code in (173, 175, 176, 170, 140) and t.code not in cur and 'v' not in cur:
                    cur[t.code] = t.value
                if t.code in (302, 1) and 'text' not in cur and ('v' in cur or t.code == 1):
                    cur['text'] = t.value
            tables.append({'handle': e.dxf.handle, 'rows': hdr.get(91), 'cols': hdr.get(92), 'cells': [{'merged': c.get(173, 0), 'span': [c.get(175, 1), c.get(176, 1)], 'align': c.get(170), 'height': c.get(140), 'text': c.get('text', '')} for c in cells]})
        res = {'ok': True, 'warnings': [str(w) for w in (r.warnings or [])], 'counts': dict(counts), 'tables': tables}
    except Exception as e:
        res = {'ok': False, 'error': repr(e)[:2000]}
    with open(job['out'], 'w') as f:
        json.dump(res, f)
`;

export interface EngineRead {
  ok: boolean;
  error?: string;
  warnings?: string[];
  counts?: Record<string, number>;
  /** 엔진이 만든 ACAD_TABLE의 셀(AcDbTable 태그: 173 병합 표시, 175·176 병합 열·행, 170 정렬, 140 문자 높이, 문자) */
  tables?: { handle: string; rows: number; cols: number; cells: { merged: number; span: [number, number]; align?: number; height?: number; text: string }[] }[];
}

export const engineAvailable = hasPython;

/** 여러 파일을 한 번의 Python 실행으로 읽는다 */
export function engineRead(files: Map<string, Uint8Array>): Map<string, EngineRead> {
  mkdirSync(CACHE, { recursive: true });
  const hashes = new Map<string, string>();
  const todo: { in: string; out: string }[] = [];
  for (const [k, bytes] of files) {
    const h = createHash('sha1').update(VERSION).update(bytes).digest('hex');
    hashes.set(k, h);
    const out = join(CACHE, `${h}.json`);
    if (existsSync(out)) continue;
    // 입력 파일은 실행마다 따로 둔다(같은 바이트를 동시에 읽는 다른 시험 파일이 먼저 지우지 않게)
    const inp = join(CACHE, `${h}-${RUN}.dwg`);
    writeFileSync(inp, bytes);
    todo.push({ in: inp, out });
  }
  if (todo.length) {
    const list = join(CACHE, `jobs-${RUN}.json`);
    writeFileSync(list, JSON.stringify(todo));
    try {
      execFileSync(PYTHON, ['-I', '-c', SCRIPT, list], { stdio: 'pipe', timeout: 1_800_000, maxBuffer: 1 << 26 });
    } finally {
      for (const t of todo) rmSync(t.in, { force: true });
      rmSync(list, { force: true });
    }
  }
  const out = new Map<string, EngineRead>();
  for (const [k, h] of hashes) {
    const p = join(CACHE, `${h}.json`);
    out.set(k, existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as EngineRead) : { ok: false, error: '결과 없음' });
  }
  return out;
}
