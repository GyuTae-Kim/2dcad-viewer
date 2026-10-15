/**
 * 명령행 버전 명령(-INSERT 등)이 함께 쓰는 프롬프트 도우미.
 * 공백은 Enter(스크립트와 같다)이고, 숫자는 직접 거리 입력이 아니라 값으로 받는다(preferNumber).
 * 잘못된 입력은 오류(err)로 알리고 다시 묻는다 — 스크립트는 오류에서 멈춘다.
 */
import type { CommandContext, Keyword } from './app';
import type { Pt } from './view';

/** 낱말 입력(공백 = Enter). Enter면 null. 점으로 읽힌 입력은 "x,y" 글로, 키워드는 키로 돌린다 */
export async function askWord(ctx: CommandContext, prompt: string, keywords: Keyword[] = []): Promise<string | null> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { allowText: true, preferNumber: true, keywords });
    if ('text' in r) return r.text.trim().replace(/^"(.*)"$/, '$1');
    if ('enter' in r) return null;
    if ('keyword' in r) return r.keyword;
    if ('point' in r) return `${+r.point.x.toPrecision(12)},${+r.point.y.toPrecision(12)}`;
  }
}

/** 글 입력(공백 포함, 줄 끝까지). Enter면 def */
export async function askLine(ctx: CommandContext, prompt: string, def: string): Promise<string> {
  const app = ctx.app;
  const prev = app.cmd.acceptSpaces;
  app.cmd.acceptSpaces = true;
  try {
    const r = await ctx.getPoint(prompt, { allowText: true, preferNumber: true });
    if ('text' in r) return r.text;
    if ('point' in r) return `${+r.point.x.toPrecision(12)},${+r.point.y.toPrecision(12)}`;
    return def;
  } finally {
    app.cmd.acceptSpaces = prev;
  }
}

/** 키워드 고르기(열쇠·한국어 이름, 대소문자 무시). Enter면 def(null이면 null) */
export async function askOption(ctx: CommandContext, prompt: string, keywords: Keyword[], def: string | null): Promise<string | null> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { keywords, allowText: true });
    if ('keyword' in r) return r.keyword;
    if ('enter' in r) return def;
    if ('text' in r) {
      const k = matchKeyword(r.text, keywords);
      if (k) return k;
    }
    ctx.print('옵션 키워드가 필요합니다.', 'err');
  }
}

/** 입력 → 키워드 열쇠(열쇠·이름, 앞의 _는 뗀다) */
export function matchKeyword(text: string, keywords: readonly Keyword[]): string | null {
  const t = text.trim().replace(/^_/, '');
  const up = t.toUpperCase();
  return keywords.find((k) => k.key.toUpperCase() === up || k.label === t)?.key ?? null;
}

/** 예/아니오(Enter = def) */
export async function askYN(ctx: CommandContext, prompt: string, def: boolean): Promise<boolean> {
  const k = await askOption(ctx, `${prompt} [예(Y)/아니오(N)] <${def ? '예' : '아니오'}>:`, YES_NO, def ? 'Y' : 'N');
  return k === 'Y';
}

export const YES_NO: Keyword[] = [
  { key: 'Y', label: '예' },
  { key: 'N', label: '아니오' },
];

/** 실수 입력. Enter면 def(null이면 다시 묻는다). check가 글을 돌려주면 오류로 알리고 다시 */
export async function askReal(ctx: CommandContext, prompt: string, def: number | null, check: (v: number) => string | null = () => null): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { preferNumber: true, allowText: true });
    if ('enter' in r && def !== null) return def;
    if ('text' in r) {
      const v = parseReal(r.text);
      if (v !== null) {
        const e = check(v);
        if (!e) return v;
        ctx.print(e, 'err');
        continue;
      }
    }
    ctx.print('숫자 값이 필요합니다.', 'err');
  }
}

/** 정수 입력(min~max). Enter면 def(null이면 다시 묻는다) */
export async function askInteger(ctx: CommandContext, prompt: string, def: number | null, min: number, max: number): Promise<number> {
  return askReal(ctx, prompt, def, (v) => (Number.isInteger(v) && v >= min && v <= max ? null : `${min}에서 ${max} 사이의 정수가 필요합니다.`));
}

/** 각도(도) 입력 또는 기준점에서 찍은 점의 방향. 라디안을 돌려준다. Enter면 def(라디안) */
export async function askAngleDeg(ctx: CommandContext, prompt: string, base: Pt | null, def: number): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { base, preferNumber: true, allowText: true });
    if ('enter' in r) return def;
    if ('point' in r && base) return Math.atan2(r.point.y - base.y, r.point.x - base.x);
    if ('text' in r) {
      const v = parseReal(r.text);
      if (v !== null) return (v * Math.PI) / 180;
    }
    ctx.print('각도 또는 점이 필요합니다.', 'err');
  }
}

/** 숫자 글 → 수(지수 표기 허용). 아니면 null */
export function parseReal(text: string): number | null {
  const t = text.trim();
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** 숫자를 프롬프트 기본값 꼴로(소수 네 자리, AutoCAD처럼) */
export function fmt4(v: number): string {
  return v.toFixed(4);
}
