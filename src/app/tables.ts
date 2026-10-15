/**
 * 표·설정 명령: STYLE(문자 스타일), LINETYPE(선종류 불러오기), LTSCALE·CELTSCALE·PSLTSCALE, UNITS, SETVAR
 */
import type { HeaderValue, TextStyle } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { STANDARD_LINETYPES, makeLinetype } from '../edit/linetypes';
import type { App, CommandContext } from './app';
import { dialog, form, h } from './ui/dom';
import { annotativeFlag, textStyleAnnotative, withAnnotativeFlag } from '../edit/annoscale/xdata';
import { compareVar } from '../edit/compare/settings';

/** 웹에서 바로 쓸 수 있는 글꼴(없으면 대체 글꼴로 그린다) */
const FONTS = [
  { value: 'txt.shx', label: 'txt.shx (선 글꼴)' },
  { value: 'simplex.shx', label: 'simplex.shx (선 글꼴)' },
  { value: 'romans.shx', label: 'romans.shx (선 글꼴)' },
  { value: 'isocp.shx', label: 'isocp.shx (선 글꼴)' },
  { value: 'arial.ttf', label: 'Arial' },
  { value: 'times.ttf', label: 'Times New Roman' },
  { value: 'cour.ttf', label: 'Courier New' },
  { value: 'malgun.ttf', label: '맑은 고딕' },
  { value: 'gulim.ttc', label: '굴림' },
  { value: 'batang.ttc', label: '바탕' },
];

function setHeaderOps(doc: { header: Map<string, HeaderValue> }, values: Record<string, HeaderValue>): EditOp[] {
  const ops: EditOp[] = [];
  for (const [name, after] of Object.entries(values)) {
    const before = doc.header.get(name);
    if (before !== after) ops.push({ kind: 'header', name, before, after });
  }
  return ops;
}

async function askNumber(ctx: CommandContext, prompt: string, def: number, check: (v: number) => boolean = (v) => v > 0): Promise<number | null> {
  for (;;) {
    const r = await ctx.getPoint(`${prompt} <${+def.toFixed(6)}>:`, { allowText: true });
    if ('enter' in r) return def;
    if ('text' in r) {
      const v = Number(r.text.trim());
      if (Number.isFinite(v) && check(v)) return v;
    }
    if (!('text' in r) && !('point' in r)) return null;
    ctx.print('올바른 값을 입력하십시오.', 'err');
  }
}

export function registerTableCommands(app: App): void {
  // ------------------------------------------------------------- STYLE
  app.register({
    name: 'STYLE',
    aliases: ['ST', 'DDSTYLE'],
    title: '문자 스타일',
    async run(ctx) {
      const st = app.active!;
      const styles = [...st.doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1));
      const cur = String(st.doc.header.get('$TEXTSTYLE') ?? 'Standard');
      const v = await form(
        '문자 스타일',
        [
          { key: 'name', label: '스타일 이름', type: 'text', value: styles.find((s) => tableKey(s.name) === tableKey(cur))?.name ?? cur, placeholder: '새 이름을 쓰면 새로 만듭니다' },
          { key: 'font', label: '글꼴', type: 'select', value: 'txt.shx', options: FONTS },
          { key: 'height', label: '높이(0 = 가변)', type: 'number', value: 0 },
          { key: 'width', label: '폭 비율', type: 'number', value: 1 },
          { key: 'oblique', label: '기울기(도)', type: 'number', value: 0 },
          { key: 'annotative', label: '주석(높이 = 용지 문자 높이)', type: 'check', value: textStyleAnnotative(st.doc, cur) },
          { key: 'current', label: '현재 스타일로', type: 'check', value: true },
        ],
        {
          ok: '적용',
          note: `있는 스타일: ${styles.map((s) => s.name).join(', ')}`,
          validate: (x) => {
            const n = String(x.name).trim();
            if (!n || /[<>/\\":;?*|,=`]/.test(n)) return '이름이 올바르지 않습니다.';
            if (!(Number(x.width) > 0)) return '폭 비율은 0보다 커야 합니다.';
            if (Number(x.height) < 0) return '높이는 0 이상이어야 합니다.';
            return null;
          },
        },
      );
      if (!v) return;
      const name = String(v.name).trim();
      const key = tableKey(name);
      const before = st.doc.textStyles.get(key) ?? null;
      const font = String(v.font);
      const ttf = /\.tt[fc]$/i.test(font);
      const after: TextStyle = {
        ...(before ? structuredClone(before) : { handle: st.session.newHandle(), flags: 0, generation: 0, lastHeight: 2.5, bigFont: '' }),
        name: before?.name ?? name,
        font,
        bigFont: ttf ? '' : (before?.bigFont ?? ''),
        fontFamily: ttf ? FONTS.find((f) => f.value === font)?.label : undefined,
        height: Number(v.height),
        widthFactor: Number(v.width),
        oblique: (Number(v.oblique) * Math.PI) / 180,
      } as TextStyle;
      // 주석 스타일(AcadAnnotative). 끄면 실물처럼 {1, 0}으로 남기고, 처음부터 끈 새 스타일에는 붙이지 않는다
      if (v.annotative || annotativeFlag(after.xdata) !== undefined) after.xdata = withAnnotativeFlag(after.xdata, !!v.annotative);
      const ops: EditOp[] = [{ kind: 'textStyle', key, before, after }];
      if (v.current) ops.push(...setHeaderOps(st.doc, { $TEXTSTYLE: after.name }));
      st.session.commit({ label: 'STYLE', ops });
      ctx.print(`문자 스타일 "${after.name}"을(를) ${before ? '고쳤습니다' : '만들었습니다'}.`);
    },
  });

  // ------------------------------------------------------------- LINETYPE
  app.register({
    name: 'LINETYPE',
    aliases: ['LT', 'LTYPE', 'DDLTYPE'],
    title: '선종류 관리자',
    async run(ctx) {
      const st = app.active!;
      const metric = Number(st.doc.header.get('$MEASUREMENT') ?? 1) === 1;
      const loaded = new Set(st.doc.linetypes.keys());
      const list = h('div', { class: 'lt-list' });
      const checks: { name: string; box: HTMLInputElement }[] = [];
      for (const d of STANDARD_LINETYPES) {
        const box = h('input', { type: 'checkbox', disabled: loaded.has(tableKey(d.name)) }) as HTMLInputElement;
        box.checked = loaded.has(tableKey(d.name));
        checks.push({ name: d.name, box });
        list.append(h('label', { class: 'lt-row' }, box, h('b', {}, d.name), h('span', {}, d.description)));
      }
      const cur = String(st.doc.header.get('$CELTYPE') ?? 'ByLayer');
      const sel = h('select', {}, h('option', { value: 'ByLayer' }, 'ByLayer'), h('option', { value: 'ByBlock' }, 'ByBlock'), ...[...st.doc.linetypes.values()].filter((l) => !/^by(layer|block)$/i.test(l.name)).map((l) => h('option', { value: l.name }, l.name))) as HTMLSelectElement;
      sel.value = [...sel.options].find((o) => o.value.toUpperCase() === cur.toUpperCase())?.value ?? 'ByLayer';
      const lts = h('input', { value: String(st.doc.header.get('$LTSCALE') ?? 1) }) as HTMLInputElement;
      const celts = h('input', { value: String(st.doc.header.get('$CELTSCALE') ?? 1) }) as HTMLInputElement;
      await new Promise<void>((resolve) => {
        const back = dialog(
          '선종류 관리자',
          h(
            'div',
            { class: 'form' },
            h('div', { class: 'form-row' }, h('span', {}, '현재 선종류'), sel),
            h('div', { class: 'form-row' }, h('span', {}, '전역 축척(LTSCALE)'), lts),
            h('div', { class: 'form-row' }, h('span', {}, '현재 객체 축척'), celts),
            h('h4', { style: 'margin:10px 0 4px' }, '불러올 선종류'),
            list,
          ),
          [
            { label: '취소', run: () => resolve() },
            {
              label: '확인',
              primary: true,
              run: () => {
                const ops: EditOp[] = [];
                for (const c of checks) {
                  if (!c.box.checked || loaded.has(tableKey(c.name))) continue;
                  const def = STANDARD_LINETYPES.find((d) => d.name === c.name)!;
                  ops.push({ kind: 'linetype', key: tableKey(c.name), before: null, after: makeLinetype(def, st.session.newHandle(), metric) });
                }
                const ltsV = Number(lts.value);
                const celV = Number(celts.value);
                ops.push(
                  ...setHeaderOps(st.doc, {
                    $CELTYPE: sel.value,
                    ...(ltsV > 0 ? { $LTSCALE: ltsV } : {}),
                    ...(celV > 0 ? { $CELTSCALE: celV } : {}),
                  }),
                );
                if (ops.length) st.session.commit({ label: 'LINETYPE', ops });
                const n = ops.filter((o) => o.kind === 'linetype').length;
                if (n) ctx.print(`선종류 ${n}개를 불러왔습니다.`);
                resolve();
              },
            },
          ],
        );
        new MutationObserver((_, obs) => {
          if (!back.isConnected) {
            obs.disconnect();
            resolve();
          }
        }).observe(document.body, { childList: true });
      });
    },
  });

  const scaleVar = (name: string, varName: string, title: string, aliases: string[] = []) =>
    app.register({
      name,
      aliases,
      title,
      async run(ctx, arg) {
        const st = app.active!;
        const cur = Number(st.doc.header.get(varName) ?? 1) || 1;
        const v = arg !== undefined && Number(arg) > 0 ? Number(arg) : await askNumber(ctx, '새 축척 비율 입력', cur);
        if (v === null) return;
        const ops = setHeaderOps(st.doc, { [varName]: v });
        if (ops.length) st.session.commit({ label: name, ops });
      },
    });
  scaleVar('LTSCALE', '$LTSCALE', '선종류 전역 축척', ['LTS']);
  scaleVar('CELTSCALE', '$CELTSCALE', '새 객체 선종류 축척');
  app.register({
    name: 'PSLTSCALE',
    title: '배치 선종류 축척',
    async run(ctx) {
      const st = app.active!;
      const cur = Number(st.doc.header.get('$PSLTSCALE') ?? 1);
      const v = await askNumber(ctx, 'PSLTSCALE에 대한 새 값 입력(0 또는 1)', cur, (x) => x === 0 || x === 1);
      if (v === null) return;
      const ops = setHeaderOps(st.doc, { $PSLTSCALE: v });
      if (ops.length) st.session.commit({ label: 'PSLTSCALE', ops });
    },
  });

  // ------------------------------------------------------------- UNITS
  app.register({
    name: 'UNITS',
    aliases: ['UN', 'DDUNITS'],
    title: '도면 단위',
    async run(ctx) {
      const st = app.active!;
      const u = st.units;
      const v = await form(
        '도면 단위',
        [
          {
            key: 'lunits',
            label: '길이 유형',
            type: 'select',
            value: String(u.lunits),
            options: [
              { value: '1', label: '과학' },
              { value: '2', label: '십진' },
              { value: '3', label: '공학' },
              { value: '4', label: '건축' },
              { value: '5', label: '분수' },
            ],
          },
          { key: 'luprec', label: '길이 정밀도', type: 'select', value: String(u.luprec), options: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: n ? `0.${'0'.repeat(n)}` : '0' })) },
          {
            key: 'aunits',
            label: '각도 유형',
            type: 'select',
            value: String(u.aunits),
            options: [
              { value: '0', label: '십진 도수' },
              { value: '1', label: '도/분/초' },
              { value: '2', label: '그라디안' },
              { value: '3', label: '라디안' },
              { value: '4', label: '측량 단위' },
            ],
          },
          { key: 'auprec', label: '각도 정밀도', type: 'select', value: String(u.auprec), options: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) })) },
          { key: 'angdir', label: '시계 방향', type: 'check', value: !!u.angdir },
          {
            key: 'insunits',
            label: '삽입 축척 단위',
            type: 'select',
            value: String(u.insunits),
            options: [
              [0, '단위 없음'],
              [1, '인치'],
              [2, '피트'],
              [4, '밀리미터'],
              [5, '센티미터'],
              [6, '미터'],
              [7, '킬로미터'],
              [3, '마일'],
              [10, '야드'],
            ].map(([n, l]) => ({ value: String(n), label: String(l) })),
          },
        ],
        { ok: '확인' },
      );
      if (!v) return;
      const ops = setHeaderOps(st.doc, {
        $LUNITS: Number(v.lunits),
        $LUPREC: Number(v.luprec),
        $AUNITS: Number(v.aunits),
        $AUPREC: Number(v.auprec),
        $ANGDIR: v.angdir ? 1 : 0,
        $INSUNITS: Number(v.insunits),
      });
      if (!ops.length) return;
      st.session.commit({ label: 'UNITS', ops });
      ctx.print('도면 단위를 바꿨습니다.');
    },
  });

  // ------------------------------------------------------------- SETVAR
  app.register({
    name: 'SETVAR',
    aliases: ['SET'],
    title: '시스템 변수',
    async run(ctx, arg) {
      const st = app.active!;
      let name = arg?.trim();
      if (!name) {
        const r = await ctx.getPoint('변수 이름 입력 또는 [?]:', { allowText: true });
        if (!('text' in r)) return;
        name = r.text.trim();
      }
      if (name === '?') {
        const names = [...st.doc.header.keys()].sort();
        for (const n of names.slice(0, 400)) ctx.print(`${n.slice(1).padEnd(14)} ${show(st.doc.header.get(n))}`);
        if (names.length > 400) ctx.print(`… 외 ${names.length - 400}개`);
        return;
      }
      const key = `$${name.replace(/^\$/, '').toUpperCase()}`;
      // 헤더가 아니라 객체에 저장되는 변수
      if (key === '$IMAGEFRAME' || key === '$WIPEOUTFRAME') {
        await app.run(key.slice(1));
        return;
      }
      // 도면 비교 변수(COMPARECOLOR1 …)·XFADECTL·SETBYLAYERMODE·LAYERPMODE는 이 브라우저에 저장하고, 변수 이름이 곧 명령이다
      if (compareVar(key.slice(1)) || key === '$XFADECTL' || key === '$SETBYLAYERMODE' || key === '$LAYERPMODE') {
        await app.run(key.slice(1));
        return;
      }
      const cur = st.doc.header.get(key);
      if (cur === undefined) {
        ctx.print(`변수 "${name}"이(가) 이 도면에 없습니다.`, 'err');
        return;
      }
      if (typeof cur === 'object') {
        ctx.print(`${key.slice(1)} = ${show(cur)} (읽기 전용)`);
        return;
      }
      const r = await ctx.getPoint(`${key.slice(1)}에 대한 새 값 입력 <${show(cur)}>:`, { allowText: true });
      if (!('text' in r)) return;
      let after: HeaderValue = r.text;
      if (typeof cur === 'number') {
        const n = Number(r.text);
        if (!Number.isFinite(n)) {
          ctx.print('숫자를 입력하십시오.', 'err');
          return;
        }
        after = n;
      }
      const ops = setHeaderOps(st.doc, { [key]: after });
      if (ops.length) st.session.commit({ label: key.slice(1), ops });
    },
  });
}

function show(v: HeaderValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'object') return `${+v.x.toFixed(4)},${+v.y.toFixed(4)}${'z' in v ? `,${+(v as { z: number }).z.toFixed(4)}` : ''}`;
  return typeof v === 'number' ? String(+v.toFixed(6)) : `"${v}"`;
}
