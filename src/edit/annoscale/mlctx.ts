/**
 * 다중 지시선 축척 레코드(ACDB_MLEADEROBJECTCONTEXTDATA_CLASS)의 본문 ↔ 모델의 컨텍스트 자료(MLeaderEntity.context).
 *
 * 본문 = MULTILEADER의 `300 CONTEXT_DATA{` ~ `301 }` 사이 태그(같은 순서, 표지 둘은 없다): 40 전체 축척, 10 내용 기준점,
 * 41 문자 높이, 140 화살촉 크기, 145 연결선 간격, 174~177, 290 문자 있음 → 304·11·340·12·13·42~45·170·90·171·172·91·141·92·
 * 291·292·173·293·142·143·294·(144…)·295, 296 블록 있음 → 341·14·15·16·46·93·47×16, 110·111·112 기준 평면, 297,
 * 지시선마다 `302 LEADER{` 290·291·10·11·(12·13…)·90·40, 선마다 `304 LEADER_LINE{` 10…·(90·11·12…)·91·(재지정)·`305 }`,
 * 271, `303 }`, 그리고 272·273. AutoCAD DXF 표본의 MULTILEADER와 태그가 같다(src/io/dwg/ctxcodec.ts 시험).
 */
import type { CadColor, MLeaderEntity, MLeaderLeader, MLeaderLine, RawTag, Vec3 } from '../../core/model';
import { rawColorToCad } from '../../core/color';

type Ctx = MLeaderEntity['context'];

/** CadColor → 원시 색 정수(0xC0 ByLayer, 0xC1 ByBlock, 0xC2 RGB, 0xC3 ACI) */
export function colorRaw(c: CadColor | undefined, d = 0xc1000000 | 0): number {
  if (!c) return d;
  if (c.rgb !== undefined) return (0xc2000000 | (c.rgb & 0xffffff)) | 0;
  if (c.aci === 256) return 0xc0000000 | 0;
  if (c.aci === 0) return 0xc1000000 | 0;
  if (c.aci === 257) return 0xc8000000 | 0;
  return (0xc3000000 | (c.aci & 0xff)) | 0;
}

const Z: Vec3 = { x: 0, y: 0, z: 0 };

function p3(out: RawTag[], code: number, p: Vec3 | undefined, d: Vec3 = Z): void {
  const v = p ?? d;
  out.push({ code, value: v.x }, { code: code + 10, value: v.y }, { code: code + 20, value: v.z });
}

const fin = (n: number | undefined, d = 0): number => (typeof n === 'number' && Number.isFinite(n) ? n : d);

/** 컨텍스트 자료 → 레코드 본문 태그(340 다음) */
export function mleaderContextTags(c: Ctx): RawTag[] {
  const out: RawTag[] = [];
  const t = (code: number, value: string | number) => out.push({ code, value });
  const CP = c.props ?? {};
  t(40, fin(c.scale, 1) || 1);
  p3(out, 10, c.contentBase);
  t(41, fin(c.textHeight));
  t(140, fin(c.arrowSize));
  t(145, fin(c.landingGap));
  t(174, CP[174] ?? 1);
  t(175, CP[175] ?? 1);
  t(176, CP[176] ?? 0);
  t(177, CP[177] ?? 0);
  const x = c.text;
  if (x) {
    const TP = x.props ?? {};
    t(290, 1);
    t(304, x.text);
    p3(out, 11, x.normal, { x: 0, y: 0, z: 1 });
    t(340, x.styleHandle ? x.styleHandle.toUpperCase() : '0');
    p3(out, 12, x.location);
    p3(out, 13, x.direction, { x: 1, y: 0, z: 0 });
    t(42, fin(x.rotation));
    t(43, fin(x.width));
    t(44, fin(x.height));
    t(45, fin(x.lineSpacingFactor, 1) || 1);
    t(170, x.lineSpacingStyle || 1);
    t(90, colorRaw(x.color));
    t(171, x.attachment || 1);
    t(172, x.flowDirection || 1);
    t(91, colorRaw(x.backgroundColor, 0xc0000000 | 0));
    t(141, fin(x.backgroundScale, 1.5));
    t(92, TP[92] ?? 0);
    t(291, TP[291] ?? 0);
    t(292, x.backgroundFill ? 1 : 0);
    t(173, TP[173] ?? 0);
    t(293, TP[293] ?? 0);
    t(142, TP[142] ?? 0);
    t(143, TP[143] ?? 0);
    t(294, TP[294] ?? 0);
    t(295, TP[295] ?? 0);
  } else t(290, 0);
  const b = c.block;
  if (b && b.blockHandle) {
    t(296, 1);
    t(341, b.blockHandle.toUpperCase());
    p3(out, 14, b.normal, { x: 0, y: 0, z: 1 });
    p3(out, 15, b.location);
    p3(out, 16, b.scale, { x: 1, y: 1, z: 1 });
    t(46, fin(b.rotation));
    t(93, colorRaw(b.color));
    const m = b.matrix && b.matrix.length === 16 ? b.matrix : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const v of m) t(47, v);
  } else t(296, 0);
  p3(out, 110, c.basePoint);
  p3(out, 111, c.baseDirection, { x: 1, y: 0, z: 0 });
  p3(out, 112, c.baseVertical, { x: 0, y: 1, z: 0 });
  t(297, CP[297] ?? 0);
  for (const ld of c.leaders) {
    t(302, 'LEADER{');
    t(290, ld.hasLastPoint ? 1 : 0);
    t(291, ld.hasDogleg ? 1 : 0);
    p3(out, 10, ld.lastLeaderPoint);
    p3(out, 11, ld.doglegVector, { x: 1, y: 0, z: 0 });
    t(90, ld.index);
    t(40, fin(ld.doglegLength));
    for (const ln of ld.lines) {
      t(304, 'LEADER_LINE{');
      for (const v of ln.vertices) p3(out, 10, v);
      for (const br of ln.breaks ?? []) {
        t(90, 0);
        p3(out, 11, br.start);
        p3(out, 12, br.end);
      }
      t(91, ln.index);
      t(305, '}');
    }
    t(271, ld.attachmentDirection || 0);
    t(303, '}');
  }
  t(272, CP[272] ?? 9);
  t(273, CP[273] ?? 9);
  return out;
}

const num = (v: string | number | undefined, d = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};

/** 레코드 본문 태그(340 다음) → 컨텍스트 자료. 읽을 수 없으면 null */
export function mleaderContextFromTags(body: readonly RawTag[]): Ctx | null {
  if (!body.some((t) => t.code === 40)) return null;
  const ctx: Ctx = {
    scale: 1,
    contentBase: { ...Z },
    textHeight: 0,
    arrowSize: 0,
    landingGap: 0,
    leaders: [],
    basePoint: { ...Z },
    baseDirection: { x: 1, y: 0, z: 0 },
    baseVertical: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  };
  let i = 0;
  const pt = (): Vec3 => {
    const x = num(body[i]!.value);
    const y = body[i + 1] && body[i + 1]!.code === body[i]!.code + 10 ? num(body[++i]!.value) : 0;
    const z = body[i + 1] && body[i + 1]!.code === body[i]!.code + 10 ? num(body[++i]!.value) : 0;
    return { x, y, z };
  };
  let content: 'none' | 'text' | 'block' = 'none';
  let ld: MLeaderLeader | null = null;
  let ln: MLeaderLine | null = null;
  let breakStart: Vec3 | null = null;
  const props: Record<number, number> = {};
  for (; i < body.length; i++) {
    const t = body[i]!;
    const c = t.code;
    const s = typeof t.value === 'string' ? t.value.trim() : '';
    if (c === 100) break;
    if (ln) {
      if (c === 305) ln = null;
      else if (c === 10) ln.vertices.push(pt());
      else if (c === 11) breakStart = pt();
      else if (c === 12) {
        const e = pt();
        if (breakStart) (ln.breaks ??= []).push({ start: breakStart, end: e });
        breakStart = null;
      } else if (c === 91) ln.index = num(t.value);
      else if (c === 92) ln.color = rawColorToCad(num(t.value));
      continue;
    }
    if (ld) {
      if (c === 303) ld = null;
      else if (c === 304 && s === 'LEADER_LINE{') {
        ln = { vertices: [], index: 0 };
        ld.lines.push(ln);
        breakStart = null;
      } else if (c === 290) ld.hasLastPoint = num(t.value) === 1;
      else if (c === 291) ld.hasDogleg = num(t.value) === 1;
      else if (c === 10) ld.lastLeaderPoint = pt();
      else if (c === 11) ld.doglegVector = pt();
      else if (c === 12 || c === 13) pt();
      else if (c === 90) ld.index = num(t.value);
      else if (c === 40) ld.doglegLength = num(t.value);
      else if (c === 271) ld.attachmentDirection = num(t.value);
      continue;
    }
    if (c === 302 && s === 'LEADER{') {
      ld = { doglegLength: 0, hasLastPoint: false, hasDogleg: false, lines: [], index: 0, attachmentDirection: 0 };
      ctx.leaders.push(ld);
      content = 'none';
      continue;
    }
    if (content === 'text' && ctx.text) {
      const x = ctx.text;
      let used = true;
      switch (c) {
        case 304:
          x.text = String(t.value);
          break;
        case 11:
          x.normal = pt();
          break;
        case 340:
          x.styleHandle = String(t.value).trim().toUpperCase();
          break;
        case 12:
          x.location = pt();
          break;
        case 13:
          x.direction = pt();
          break;
        case 42:
          x.rotation = num(t.value);
          break;
        case 43:
          x.width = num(t.value);
          break;
        case 44:
          x.height = num(t.value);
          break;
        case 45:
          x.lineSpacingFactor = num(t.value, 1) || 1;
          break;
        case 170:
          x.lineSpacingStyle = num(t.value, 1);
          break;
        case 90:
          x.color = rawColorToCad(num(t.value));
          break;
        case 171:
          x.attachment = num(t.value, 1);
          break;
        case 172:
          x.flowDirection = num(t.value, 1);
          break;
        case 91:
          x.backgroundColor = rawColorToCad(num(t.value));
          break;
        case 141:
          x.backgroundScale = num(t.value, 1.5);
          break;
        case 292:
          x.backgroundFill = num(t.value) === 1;
          break;
        case 92:
        case 291:
        case 173:
        case 293:
        case 142:
        case 143:
        case 294:
        case 295:
          (x.props ??= {})[c] = num(t.value);
          break;
        case 144:
          break;
        default:
          used = false;
          content = 'none';
      }
      if (used) continue;
    } else if (content === 'block' && ctx.block) {
      const b = ctx.block;
      let used = true;
      switch (c) {
        case 341:
          b.blockHandle = String(t.value).trim().toUpperCase();
          break;
        case 14:
          b.normal = pt();
          break;
        case 15:
          b.location = pt();
          break;
        case 16:
          b.scale = pt();
          break;
        case 46:
          b.rotation = num(t.value);
          break;
        case 93:
          b.color = rawColorToCad(num(t.value));
          break;
        case 47:
          (b.matrix ??= []).push(num(t.value));
          break;
        default:
          used = false;
          content = 'none';
      }
      if (used) continue;
    }
    switch (c) {
      case 40:
        ctx.scale = num(t.value, 1) || 1;
        break;
      case 10:
        ctx.contentBase = pt();
        break;
      case 41:
        ctx.textHeight = num(t.value);
        break;
      case 140:
        ctx.arrowSize = num(t.value);
        break;
      case 145:
        ctx.landingGap = num(t.value);
        break;
      case 110:
        ctx.basePoint = pt();
        break;
      case 111:
        ctx.baseDirection = pt();
        break;
      case 112:
        ctx.baseVertical = pt();
        break;
      case 174:
      case 175:
      case 176:
      case 177:
      case 297:
      case 272:
      case 273:
        props[c] = num(t.value);
        break;
      case 290:
        if (num(t.value) === 1) {
          content = 'text';
          ctx.text = {
            text: '',
            location: { ...Z },
            direction: { x: 1, y: 0, z: 0 },
            normal: { x: 0, y: 0, z: 1 },
            rotation: 0,
            width: 0,
            height: 0,
            lineSpacingFactor: 1,
            lineSpacingStyle: 1,
            color: { aci: 0 },
            attachment: 1,
            flowDirection: 1,
            backgroundFill: false,
            backgroundScale: 1.5,
          };
        }
        break;
      case 296:
        if (num(t.value) === 1) {
          content = 'block';
          ctx.block = { location: { ...Z }, normal: { x: 0, y: 0, z: 1 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, color: { aci: 0 } };
        }
        break;
    }
  }
  if (Object.keys(props).length) ctx.props = props;
  return ctx;
}

/** 레코드의 컨텍스트 자료를 객체에 넣는다(객체에만 있는 값 — 문자 스타일 등 — 은 객체 것을 둔다) */
export function withContext(m: MLeaderEntity, c: Ctx): MLeaderEntity {
  const ctx: Ctx = { ...c, normal: m.context.normal };
  if (c.text && m.context.text) ctx.text = { ...m.context.text, ...c.text, styleHandle: c.text.styleHandle && c.text.styleHandle !== '0' ? c.text.styleHandle : m.context.text.styleHandle };
  // 선 색은 레코드에 없다(재지정만): 객체 것을 둔다
  ctx.leaders = c.leaders.map((l, i) => {
    const o = m.context.leaders[i];
    return { ...l, lines: l.lines.map((ln, j) => ({ ...ln, color: ln.color ?? o?.lines[j]?.color })) };
  });
  return { ...m, context: ctx };
}
