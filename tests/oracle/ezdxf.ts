/** ezdxf 요약을 만들어 .runtime/oracle에 캐시한다(로컬 개발 전용). */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PYTHON = process.env.CAD_PYTHON ?? '/opt/homebrew/Caskroom/miniconda/base/envs/prisme-engine314/bin/python';
export const FIXTURES = process.env.CAD_FIXTURES ?? '/Users/sean/code/prisme-service/.runtime/cad2d-handoff/dwgref';
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const CACHE = join(ROOT, '.runtime/oracle');

export const hasPython = existsSync(PYTHON);

export function ezdxfSummary(dxfPath: string): unknown {
  const st = statSync(dxfPath);
  const key = createHash('sha1').update(`${dxfPath}:${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 12);
  mkdirSync(CACHE, { recursive: true });
  const out = join(CACHE, `${basename(dxfPath)}.${key}.json`);
  if (!existsSync(out)) {
    execFileSync(PYTHON, ['-I', join(ROOT, 'scripts/oracle/ezdxf_dump.py'), dxfPath, out], { stdio: 'pipe' });
  }
  return JSON.parse(readFileSync(out, 'utf8'));
}
