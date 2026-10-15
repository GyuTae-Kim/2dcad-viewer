/**
 * 제도 설정: GRID, SNAP, DSETTINGS(DS·SE, 제도 설정 대화상자), OSNAP(대화상자)·-OSNAP(명령행)
 * 격자·스냅 간격은 문서마다 둔다(저장하지 않음). 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import { formatLength } from '../core/units';
import type { App } from './app';
import { ALL_SNAPS, SNAP_NAMES } from './snap';
import type { SnapKind } from './view';
import { form } from './ui/dom';
import { isoState, setIso } from './viewtools-iso';

/** -OSNAP·명령행에서 쓰는 영문 약어 */
const SNAP_ABBR: Record<string, SnapKind> = { END: 'end', MID: 'mid', CEN: 'cen', QUA: 'qua', INT: 'int', INS: 'ins', NOD: 'nod', PER: 'per', NEA: 'nea' };

export function registerDraftingCommands(app: App): void {
  app.register({
    name: 'GRID',
    title: '격자',
    transparent: true,
    async run(ctx) {
      const st = app.active!;
      const cur = formatLength(st.grid.x, st.units);
      const r = await ctx.getPoint(`격자 간격두기(X) 지정 또는 [켜기(ON)/끄기(OFF)/스냅(S)/주(M)/종횡비(A)] <${cur}>:`, {
        keywords: [
          { key: 'ON', label: '켜기' },
          { key: 'OFF', label: '끄기' },
          { key: 'S', label: '스냅' },
          { key: 'M', label: '주' },
          { key: 'A', label: '종횡비' },
        ],
        allowText: true,
        preferNumber: true,
      });
      if ('enter' in r) return;
      if ('keyword' in r) {
        if (r.keyword === 'ON' || r.keyword === 'OFF') app.toggleGrid(r.keyword === 'ON');
        else if (r.keyword === 'S') {
          st.grid.x = st.snap.x;
          st.grid.y = st.snap.y;
          app.toggleGrid(true);
        } else if (r.keyword === 'M') {
          const m = await ctx.getPoint(`주 격자선 사이의 격자선 수 지정 <${st.grid.major}>:`, { allowText: true, preferNumber: true });
          const n = 'text' in m ? Math.round(Number(m.text)) : NaN;
          if (n >= 1 && n <= 100) st.grid.major = n;
          app.view.requestOverlay();
        } else if (r.keyword === 'A') {
          const x = await ctx.getPoint(`수평 간격두기(X) 지정 <${cur}>:`, { allowText: true, preferNumber: true });
          const y = await ctx.getPoint(`수직 간격두기(Y) 지정 <${formatLength(st.grid.y, st.units)}>:`, { allowText: true, preferNumber: true });
          const vx = 'text' in x ? Number(x.text) : st.grid.x;
          const vy = 'text' in y ? Number(y.text) : st.grid.y;
          if (vx > 0 && vy > 0) {
            st.grid.x = vx;
            st.grid.y = vy;
          }
          app.toggleGrid(true);
        }
        return;
      }
      if ('text' in r) {
        // 10x처럼 끝이 X면 스냅 간격의 배수
        const t = r.text.trim().toUpperCase();
        const v = t.endsWith('X') ? Number(t.slice(0, -1)) * st.snap.x : Number(t);
        if (!(v > 0)) {
          ctx.print('값은 양수이고 0이 아니어야 합니다.', 'err');
          return;
        }
        st.grid.x = st.grid.y = v;
        app.toggleGrid(true);
      }
    },
  });

  app.register({
    name: 'SNAP',
    aliases: ['SN'],
    title: '스냅',
    transparent: true,
    async run(ctx) {
      const st = app.active!;
      const cur = formatLength(st.snap.x, st.units);
      const iso = isoState(st).style === 1;
      const r = await ctx.getPoint(`스냅 간격두기 지정 또는 [켜기(ON)/끄기(OFF)/${iso ? '' : '종횡비(A)/'}스타일(S)/유형(T)] <${iso ? formatLength(st.snap.y, st.units) : cur}>:`, {
        keywords: [
          { key: 'ON', label: '켜기' },
          { key: 'OFF', label: '끄기' },
          ...(iso ? [] : [{ key: 'A', label: '종횡비' }]),
          { key: 'S', label: '스타일' },
          { key: 'T', label: '유형' },
        ],
        allowText: true,
        preferNumber: true,
      });
      if ('enter' in r) return;
      if ('keyword' in r) {
        if (r.keyword === 'S') {
          // 스냅 스타일: 표준(직사각형) 또는 등각투영(SNAPSTYL)
          const s = await ctx.getPoint(`스냅 그리드 스타일 입력 [표준(S)/등각투영(I)] <${iso ? 'I' : 'S'}>:`, {
            keywords: [
              { key: 'S', label: '표준' },
              { key: 'I', label: '등각투영' },
            ],
          });
          const toIso = 'keyword' in s ? s.keyword === 'I' : 'enter' in s ? iso : null;
          if (toIso === null) return;
          if (toIso) {
            const y = await ctx.getPoint(`수직 간격두기 지정 <${formatLength(st.snap.y, st.units)}>:`, { allowText: true, preferNumber: true });
            const vy = 'text' in y ? Number(y.text) : st.snap.y;
            if (!(vy > 0)) {
              ctx.print('값은 양수이고 0이 아니어야 합니다.', 'err');
              return;
            }
            st.snap.y = vy;
            setIso(app, st, { style: 1 });
          } else {
            setIso(app, st, { style: 0 });
            const x = await ctx.getPoint(`스냅 간격두기 지정 또는 [종횡비(A)] <${formatLength(st.snap.x, st.units)}>:`, { keywords: [{ key: 'A', label: '종횡비' }], allowText: true, preferNumber: true });
            if ('text' in x && Number(x.text) > 0) st.snap.x = st.snap.y = Number(x.text);
            else if ('keyword' in x) {
              const ax = await ctx.getPoint(`수평 간격두기 지정 <${formatLength(st.snap.x, st.units)}>:`, { allowText: true, preferNumber: true });
              const ay = await ctx.getPoint(`수직 간격두기 지정 <${formatLength(st.snap.y, st.units)}>:`, { allowText: true, preferNumber: true });
              if ('text' in ax && Number(ax.text) > 0) st.snap.x = Number(ax.text);
              if ('text' in ay && Number(ay.text) > 0) st.snap.y = Number(ay.text);
            }
          }
          app.view.requestOverlay();
          return;
        }
        if (r.keyword === 'T') {
          const t = await ctx.getPoint('스냅 유형 입력 [극좌표(P)/그리드(G)] <그리드>:', {
            keywords: [
              { key: 'P', label: '극좌표' },
              { key: 'G', label: '그리드' },
            ],
          });
          if ('keyword' in t && t.keyword === 'P') ctx.print('극좌표 스냅(PolarSnap)은 이 웹 버전에서 지원하지 않습니다. 그리드 스냅을 그대로 씁니다.', 'err');
          return;
        }
        if (r.keyword === 'A') {
          const x = await ctx.getPoint(`수평 간격두기 지정 <${cur}>:`, { allowText: true, preferNumber: true });
          const y = await ctx.getPoint(`수직 간격두기 지정 <${formatLength(st.snap.y, st.units)}>:`, { allowText: true, preferNumber: true });
          const vx = 'text' in x ? Number(x.text) : st.snap.x;
          const vy = 'text' in y ? Number(y.text) : st.snap.y;
          if (vx > 0 && vy > 0) {
            st.snap.x = vx;
            st.snap.y = vy;
          }
          app.toggleSnap(true);
        } else app.toggleSnap(r.keyword === 'ON');
        return;
      }
      if ('text' in r) {
        const v = Number(r.text);
        if (!(v > 0)) {
          ctx.print('값은 양수이고 0이 아니어야 합니다.', 'err');
          return;
        }
        st.snap.x = st.snap.y = v;
        app.toggleSnap(true);
      }
    },
  });

  const settings = async (tab: 'snap' | 'polar' | 'osnap') => {
    const st = app.active;
    const deg = Math.round((app.polarInc * 180) / Math.PI * 1e6) / 1e6;
    const fields: Parameters<typeof form>[1] = [];
    if (st && tab === 'snap') {
      fields.push(
        { key: 'snapOn', label: '스냅 켜기 (F9)', type: 'check', value: app.snapOn },
        { key: 'snapX', label: '스냅 X 간격', type: 'number', value: st.snap.x },
        { key: 'snapY', label: '스냅 Y 간격', type: 'number', value: st.snap.y },
        {
          key: 'snapStyle',
          label: '스냅 유형',
          type: 'select',
          value: String(isoState(st).style),
          options: [
            { value: '0', label: '직사각형 스냅' },
            { value: '1', label: '등각투영 스냅' },
          ],
        },
        { key: 'gridOn', label: '격자 켜기 (F7)', type: 'check', value: app.gridOn },
        { key: 'gridX', label: '격자 X 간격', type: 'number', value: st.grid.x },
        { key: 'gridY', label: '격자 Y 간격', type: 'number', value: st.grid.y },
        { key: 'major', label: '주 격자선 간격(격자선 수)', type: 'number', value: st.grid.major },
      );
    }
    if (tab === 'polar') {
      fields.push(
        { key: 'polarOn', label: '극좌표 추적 켜기 (F10)', type: 'check', value: app.polarOn },
        {
          key: 'inc',
          label: '증분 각도',
          type: 'select',
          value: String(deg),
          options: ['90', '45', '30', '22.5', '18', '15', '10', '5'].map((v) => ({ value: v, label: v })),
        },
        { key: 'otrack', label: '객체 스냅 추적 켜기 (F11)', type: 'check', value: app.otrackOn },
      );
    }
    if (tab === 'osnap') {
      fields.push({ key: 'osnapOn', label: '객체 스냅 켜기 (F3)', type: 'check', value: app.osnapOn });
      for (const k of ALL_SNAPS) fields.push({ key: `s_${k}`, label: SNAP_NAMES[k] ?? k, type: 'check', value: app.snapModes.has(k) });
    }
    const v = await form(tab === 'snap' ? '제도 설정 - 스냅 및 그리드' : tab === 'polar' ? '제도 설정 - 극좌표 추적' : '제도 설정 - 객체 스냅', fields, {
      validate: (x) => (tab === 'snap' && !(Number(x.snapX) > 0 && Number(x.snapY) > 0 && Number(x.gridX) > 0 && Number(x.gridY) > 0 && Number(x.major) >= 1) ? '간격은 0보다 커야 합니다.' : null),
    });
    if (!v) return;
    if (st && tab === 'snap') {
      st.snap.x = Number(v.snapX);
      st.snap.y = Number(v.snapY);
      st.grid.x = Number(v.gridX);
      st.grid.y = Number(v.gridY);
      st.grid.major = Math.round(Number(v.major));
      if (Number(v.snapStyle) !== isoState(st).style) setIso(app, st, { style: Number(v.snapStyle) === 1 ? 1 : 0 });
      if (!!v.snapOn !== app.snapOn) app.toggleSnap(!!v.snapOn);
      if (!!v.gridOn !== app.gridOn) app.toggleGrid(!!v.gridOn);
      app.view.requestOverlay();
    }
    if (tab === 'polar') {
      app.polarInc = (Number(v.inc) * Math.PI) / 180;
      if (!!v.polarOn !== app.polarOn) app.togglePolar();
      if (!!v.otrack !== app.otrackOn) app.toggleOtrack();
    }
    if (tab === 'osnap') {
      app.snapModes.clear();
      for (const k of ALL_SNAPS) if (v[`s_${k}`]) app.snapModes.add(k);
      if (!!v.osnapOn !== app.osnapOn) app.toggleOsnap();
    }
    app.ui.refreshStatus();
  };

  app.register({
    name: 'DSETTINGS',
    aliases: ['DS', 'SE', 'DDRMODES'],
    title: '제도 설정',
    transparent: true,
    noDoc: true,
    async run(ctx) {
      const r = await ctx.getPoint('설정할 항목 [스냅 및 그리드(S)/극좌표 추적(P)/객체 스냅(O)] <스냅 및 그리드>:', {
        keywords: [
          { key: 'S', label: '스냅 및 그리드' },
          { key: 'P', label: '극좌표 추적' },
          { key: 'O', label: '객체 스냅' },
        ],
      });
      const k = 'keyword' in r ? r.keyword : 'S';
      await settings(k === 'P' ? 'polar' : k === 'O' ? 'osnap' : 'snap');
    },
  });

  app.register({ name: 'OSNAP', aliases: ['OS', 'DDOSNAP'], title: '객체 스냅 설정', transparent: true, noDoc: true, run: () => settings('osnap') });

  app.register({
    name: '-OSNAP',
    aliases: ['-OS'],
    title: '객체 스냅 모드(명령행)',
    transparent: true,
    noDoc: true,
    async run(ctx) {
      const cur = ALL_SNAPS.filter((k) => app.snapModes.has(k)).map((k) => Object.keys(SNAP_ABBR).find((a) => SNAP_ABBR[a] === k)).join(',') || '없음';
      const r = await ctx.getPoint(`객체 스냅 모드 리스트 입력 <${cur}>:`, { allowText: true });
      if (!('text' in r)) return;
      const t = r.text.trim().toUpperCase();
      if (t === 'NON' || t === 'NONE' || t === 'OFF') {
        app.snapModes.clear();
        app.ui.refreshStatus();
        return;
      }
      const next = new Set<SnapKind>();
      for (const p of t.split(',')) {
        const k = SNAP_ABBR[p.trim().slice(0, 3)];
        if (!k) {
          ctx.print(`알 수 없는 객체 스냅 모드 "${p.trim()}".`, 'err');
          return;
        }
        next.add(k);
      }
      app.snapModes.clear();
      for (const k of next) app.snapModes.add(k);
      if (!app.osnapOn) app.toggleOsnap();
      app.ui.refreshStatus();
    },
  });
}
