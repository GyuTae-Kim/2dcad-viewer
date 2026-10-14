/**
 * 해치 편집: HATCHEDIT(HE, 대화상자), -HATCHEDIT(명령행). 해치를 두 번 눌러도 연다.
 * 무늬·축척·각도·이중·간격·섬 검출을 바꾸면 같은 경계로 무늬를 다시 만들고, 연관을 끊을 수 있다.
 * 무늬 사전에 없는 무늬(파일에서 온 사용자 무늬)는 지금 무늬 선을 축척·각도만큼 바꾼다.
 */
import type { HatchEntity, HatchPatternLine } from '../core/model';
import { PATTERNS, createHatch, estimatePatternLines, findPattern, reactorUnlinks } from '../edit/hatch';
import type { EditOp } from '../edit/session';
import { HATCH_LINE_LIMIT } from '../render/hatch';
import type { App, CommandContext } from './app';
import { unlockedOnly } from './layers';
import { form } from './ui/dom';

interface Edit {
  pattern: string;
  scale: number;
  /** 라디안 */
  angle: number;
  double: boolean;
  spacing: number;
  style: 0 | 1 | 2;
  associative: boolean;
}

function current(h: HatchEntity): Edit {
  const user = h.patternType === 0 || h.patternName.toUpperCase() === '_USER';
  return {
    pattern: h.solid && !h.gradient ? 'SOLID' : user ? '_USER' : h.patternName.toUpperCase(),
    scale: user ? 1 : h.patternScale || 1,
    angle: h.patternAngle,
    double: h.patternDouble,
    spacing: user ? h.patternScale || 1 : 1,
    style: (h.hatchStyle === 1 || h.hatchStyle === 2 ? h.hatchStyle : 0) as 0 | 1 | 2,
    associative: h.associative,
  };
}

/** 무늬 선을 원점 기준으로 k배·da 회전 */
function transformLines(lines: readonly HatchPatternLine[], k: number, da: number): HatchPatternLine[] {
  const c = Math.cos(da);
  const s = Math.sin(da);
  const R = (p: { x: number; y: number }) => ({ x: (p.x * c - p.y * s) * k, y: (p.x * s + p.y * c) * k });
  return lines.map((l) => ({ angle: l.angle + da, base: R(l.base), offset: R(l.offset), dashes: l.dashes.map((d) => d * k) }));
}

/** 바뀐 설정으로 다시 만든 해치(정체·특성은 그대로). 만들 수 없으면 까닭 */
export function rebuildHatch(app: App, h: HatchEntity, e: Edit): HatchEntity | string {
  const doc = app.active!.doc;
  const old = current(h);
  const keepAssoc = e.associative && h.associative;
  const same = e.pattern === old.pattern;
  let n: HatchEntity;
  if (h.gradient && same) n = { ...h, hatchStyle: e.style, associative: keepAssoc };
  else if (e.pattern !== 'SOLID' && e.pattern !== '_USER' && !findPattern(e.pattern)) {
    if (!same) return `무늬 ${e.pattern}을(를) 찾을 수 없습니다.`;
    // 사전에 없는 무늬: 지금 선을 축척·각도만큼
    const k = e.scale / (old.scale || 1);
    n = { ...h, patternScale: e.scale, patternAngle: e.angle, patternLines: transformLines(h.patternLines, k, e.angle - old.angle), hatchStyle: e.style, associative: keepAssoc };
  } else {
    const made = createHatch(doc, h.paths, {
      pattern: e.pattern,
      scale: e.scale,
      angle: e.angle,
      double: e.double,
      userSpacing: e.pattern === '_USER' ? e.spacing : undefined,
      style: e.style,
      associative: keepAssoc,
      layer: h.layer,
      seedPoints: h.seedPoints,
    });
    n = { ...h, patternName: made.patternName, solid: made.solid, patternType: made.patternType, patternAngle: made.patternAngle, patternScale: made.patternScale, patternDouble: made.patternDouble, patternLines: made.patternLines, hatchStyle: made.hatchStyle, associative: made.associative, paths: made.paths };
    delete n.gradient;
  }
  if (!keepAssoc)
    n.paths = n.paths.map((p) => {
      const q = { ...p };
      delete q.sources;
      return q;
    });
  if (estimatePatternLines(n) > HATCH_LINE_LIMIT) return '해치 무늬 축척이 너무 작거나 영역이 너무 큽니다. 축척을 키우십시오.';
  return n;
}

function commit(app: App, ctx: CommandContext, before: HatchEntity, after: HatchEntity): void {
  const st = app.active!;
  const block = st.session.ownerOf(before.handle);
  if (!block) return;
  const ops: EditOp[] = [{ kind: 'modify', block, before, after }];
  // 연관을 끊으면 경계 객체의 반응자에서도 뺀다
  if (before.associative && !after.associative)
    for (const u of reactorUnlinks(st.doc, before)) {
      const b = st.session.ownerOf(u.before.handle);
      if (b) ops.push({ kind: 'modify', block: b, before: u.before, after: u.after });
    }
  st.session.commit({ label: 'HATCHEDIT', ops, group: ctx.group, rebuildNow: true });
}

async function pickHatch(app: App, ctx: CommandContext): Promise<HatchEntity | null> {
  const st = app.active!;
  const pre = [...st.selection].map((h) => st.doc.entityIndex.get(h)).filter((e): e is HatchEntity => e?.type === 'HATCH');
  if (pre.length === 1 && unlockedOnly(app, [pre[0]!.handle]).length) return pre[0]!;
  for (;;) {
    const r = await ctx.getEntity('해치 객체 선택:');
    if (!('handle' in r)) return null;
    const e = st.doc.entityIndex.get(r.handle);
    if (e?.type !== 'HATCH') {
      ctx.print('선택한 객체는 해치가 아닙니다.', 'err');
      continue;
    }
    if (!unlockedOnly(app, [e.handle]).length) {
      ctx.print('객체가 잠긴 도면층에 있습니다.', 'err');
      continue;
    }
    return e as HatchEntity;
  }
}

export function registerHatchEditCommands(app: App): void {
  app.register({
    name: 'HATCHEDIT',
    aliases: ['HE'],
    title: '해치 편집',
    async run(ctx) {
      const h = await pickHatch(app, ctx);
      if (!h) return;
      const c = current(h);
      const v = await form('해치 편집', [
        {
          key: 'pattern',
          label: '무늬',
          type: 'select',
          value: c.pattern,
          options: [
            ...(h.gradient ? [{ value: c.pattern, label: `그라데이션(${h.gradient.name || h.patternName})` }] : []),
            ...(!findPattern(c.pattern) && !['SOLID', '_USER'].includes(c.pattern) && !h.gradient ? [{ value: c.pattern, label: `${c.pattern}(이 도면의 무늬)` }] : []),
            { value: 'SOLID', label: 'SOLID — 단색 채우기' },
            { value: '_USER', label: '사용자 정의(평행선)' },
            ...PATTERNS.filter((p) => p.name !== 'SOLID').map((p) => ({ value: p.name, label: `${p.name} — ${p.description}` })),
          ],
        },
        { key: 'scale', label: '축척', type: 'number', value: c.scale },
        { key: 'angle', label: '각도(도)', type: 'number', value: +((c.angle * 180) / Math.PI).toFixed(6) },
        { key: 'spacing', label: '간격(사용자 정의)', type: 'number', value: c.spacing },
        { key: 'double', label: '이중(사용자 정의, 90° 교차)', type: 'check', value: c.double },
        {
          key: 'style',
          label: '섬 검출',
          type: 'select',
          value: String(c.style),
          options: [
            { value: '0', label: '일반(홀짝)' },
            { value: '1', label: '외부(가장 바깥)' },
            { value: '2', label: '무시' },
          ],
        },
        { key: 'associative', label: h.associative ? '연관(끄면 경계와의 연결을 끊음)' : '연관(이 해치는 연관이 아님)', type: 'check', value: h.associative },
      ], { ok: '확인', validate: (x) => (Number(x.scale) > 0 && Number(x.spacing) > 0 ? null : '축척·간격은 0보다 커야 합니다.') });
      if (!v) return;
      const e: Edit = {
        pattern: String(v.pattern),
        scale: Number(v.scale),
        angle: (Number(v.angle) * Math.PI) / 180,
        double: !!v.double,
        spacing: Number(v.spacing),
        style: Number(v.style) as 0 | 1 | 2,
        associative: !!v.associative,
      };
      const n = rebuildHatch(app, h, e);
      if (typeof n === 'string') {
        ctx.print(n, 'err');
        return;
      }
      commit(app, ctx, h, n);
    },
  });

  app.register({
    name: '-HATCHEDIT',
    aliases: ['-HE'],
    title: '해치 편집(명령행)',
    async run(ctx) {
      const h = await pickHatch(app, ctx);
      if (!h) return;
      const c = current(h);
      const r = await ctx.getPoint('해치 옵션 입력 [연관 해제(DI)/스타일(S)/특성(P)] <특성>:', {
        keywords: [
          { key: 'DI', label: '연관 해제' },
          { key: 'S', label: '스타일' },
          { key: 'P', label: '특성' },
        ],
      });
      const k = 'keyword' in r ? r.keyword : 'P';
      if (!('keyword' in r) && !('enter' in r)) return;
      const e: Edit = { ...c };
      if (k === 'DI') {
        if (!h.associative) {
          ctx.print('해치가 연관되어 있지 않습니다.');
          return;
        }
        e.associative = false;
      } else if (k === 'S') {
        const s = await ctx.getPoint(`해치 스타일 입력 [무시(I)/외부(O)/일반(N)] <${c.style === 2 ? '무시' : c.style === 1 ? '외부' : '일반'}>:`, {
          keywords: [
            { key: 'I', label: '무시' },
            { key: 'O', label: '외부' },
            { key: 'N', label: '일반' },
          ],
        });
        if ('keyword' in s) e.style = s.keyword === 'I' ? 2 : s.keyword === 'O' ? 1 : 0;
      } else {
        const name = await ctx.getPoint(`무늬 이름 입력 또는 [?/단색(S)/사용자 정의(U)] <${c.pattern}>:`, { allowText: true });
        if ('text' in name) {
          const t = name.text.trim().toUpperCase();
          if (t === '?') {
            ctx.print(PATTERNS.map((p) => p.name).join(', '));
            return;
          }
          e.pattern = t === 'S' ? 'SOLID' : t === 'U' ? '_USER' : t;
        } else if (!('enter' in name)) return;
        if (e.pattern === '_USER') {
          const a = await ctx.getPoint(`선 각도 지정 <${((c.angle * 180) / Math.PI).toFixed(0)}>:`, { preferNumber: true, allowText: true });
          if ('text' in a && Number.isFinite(Number(a.text))) e.angle = (Number(a.text) * Math.PI) / 180;
          const sp = await ctx.getPoint(`선 간격 지정 <${c.spacing}>:`, { preferNumber: true, allowText: true });
          if ('text' in sp && Number(sp.text) > 0) e.spacing = Number(sp.text);
          const d = await ctx.getPoint(`해치 영역을 이중 해치하시겠습니까? [예(Y)/아니오(N)] <${c.double ? '예' : '아니오'}>:`, {
            keywords: [
              { key: 'Y', label: '예' },
              { key: 'N', label: '아니오' },
            ],
          });
          if ('keyword' in d) e.double = d.keyword === 'Y';
        } else if (e.pattern !== 'SOLID') {
          const sc = await ctx.getPoint(`무늬에 대한 축척 지정 <${c.scale}>:`, { preferNumber: true, allowText: true });
          if ('text' in sc && Number(sc.text) > 0) e.scale = Number(sc.text);
          const a = await ctx.getPoint(`무늬에 대한 각도 지정 <${((c.angle * 180) / Math.PI).toFixed(0)}>:`, { preferNumber: true, allowText: true });
          if ('text' in a && Number.isFinite(Number(a.text))) e.angle = (Number(a.text) * Math.PI) / 180;
        }
      }
      const n = rebuildHatch(app, h, e);
      if (typeof n === 'string') {
        ctx.print(n, 'err');
        return;
      }
      commit(app, ctx, h, n);
    },
  });
}
