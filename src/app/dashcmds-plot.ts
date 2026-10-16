/**
 * 명령행 출력: -PLOT, 페이지 설정 가져오기 PSETUPIN(대화상자)·-PSETUPIN(명령행).
 * -PLOT: `상세한 플롯 구성을 원하십니까? [예(Y)/아니오(N)] <아니오>:` 뒤로 AutoCAD 2026 한국어판 순서대로 묻고,
 * PLOT과 같은 출력(plotPages → PDF·SVG 내려받기)을 쓴다. 이 웹 버전의 장치는 PDF 다섯 이름·SVG·없음이다.
 * 할 수 없는 값(뒤집어 플롯, 간격띄우기, 음영 플롯 종류, 배치의 부분 영역)은 묻기는 하고 안내한다.
 */
import type { CadDocument, Layout, PlotSettings as PageSettings } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { matchNameList } from '../edit/layercmd';
import { importPageSetupOps, namedPageSetups, type NamedPageSetup, validSetupName } from '../edit/script/pagesetup';
import type { App, CommandContext } from './app';
import { ctbByName, ctbList } from './ctblib';
import { askLine, askOption, askWord, askYN, parseReal } from './dashcmds-ask';
import { DRAWING_ACCEPT, loadedDrawings, pickFiles, readDrawingFile } from './drawingfiles';
import { PT_PER_MM, baseName, download, exportPageSvg, pdfDocument } from './export';
import { PAPERS, type PlotSettings, lastSettings, plotPages, styleSheetPlotStyle, unitMm } from './plot';
import { fileNameMode } from './script';
import { ask, form } from './ui/dom';

export const PLOT_DEVICES = ['DWG To PDF.pc3', 'AutoCAD PDF (General Documentation).pc3', 'AutoCAD PDF (High Quality Print).pc3', 'AutoCAD PDF (Smallest File).pc3', 'AutoCAD PDF (Web and Mobile).pc3', 'SVG', '없음'];

/** 장치 이름 → 출력 종류 */
export function deviceKind(name: string): 'pdf' | 'svg' | 'none' | null {
  const t = name.trim().toLowerCase().replace(/\.pc3$/, '');
  if (t === 'svg') return 'svg';
  if (t === '없음' || t === 'none' || t === 'none_device') return 'none';
  if (t.includes('pdf')) return 'pdf';
  return null;
}

/** 용지 이름 → PAPERS 열쇠(ISO A0~A4, Letter·Legal·ANSI B~E). 모르면 null */
export function paperKeyOf(text: string): string | null {
  const t = text.toUpperCase().replace(/_/g, ' ').trim();
  const exact = PAPERS.find((p) => p.key === t.replace(/\s+/g, '') || p.label.toUpperCase() === t);
  if (exact) return exact.key;
  const iso = /(?:^|[^A-Z])A([0-4])(?:[^0-9]|$)/.exec(` ${t} `);
  if (iso && !/ANSI/.test(t)) return `A${iso[1]}`;
  if (/LETTER|ANSI A\b/.test(t)) return 'LETTER';
  if (/LEGAL/.test(t)) return 'LEGAL';
  if (/TABLOID|ANSI B\b/.test(t)) return 'TABLOID';
  const ansi = /ANSI ([CDE])\b/.exec(t);
  if (ansi) return `ANSI${ansi[1]}`;
  return null;
}

/** 플롯 축척 "1=100"·"1:100"·숫자 → 용지 길이(용지 단위)·도면 단위. 맞춤(F)이면 'fit'. 모르면 null */
export function parsePlotScale(text: string): 'fit' | { paper: number; units: number } | null {
  const t = text.trim();
  if (/^(f|fit|맞춤)$/i.test(t)) return 'fit';
  const m = /^([\d.]+)\s*[=:]\s*([\d.]+)$/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a > 0 && b > 0 ? { paper: a, units: b } : null;
  }
  const v = parseReal(t);
  return v !== null && v > 0 ? { paper: v, units: 1 } : null;
}

/** 페이지 설정의 용지 → PAPERS 열쇠 */
function keyOfPage(p: PageSettings): string | null {
  const a = Math.min(p.paperWidth, p.paperHeight);
  const b = Math.max(p.paperWidth, p.paperHeight);
  return PAPERS.find((x) => Math.abs(x.w - a) < 1 && Math.abs(x.h - b) < 1)?.key ?? null;
}

/** AutoCAD식 용지 이름(가로면 회전 1) */
function mediaName(key: string): string {
  const p = PAPERS.find((x) => x.key === key)!;
  if (/^A\d$/.test(key)) return `ISO_full_bleed_${key}_(${p.w.toFixed(2)}_x_${p.h.toFixed(2)}_MM)`;
  const names: Record<string, string> = { LETTER: 'ANSI_A', LEGAL: 'Legal', TABLOID: 'ANSI_B', ANSIC: 'ANSI_C', ANSID: 'ANSI_D', ANSIE: 'ANSI_E' };
  return `${names[key] ?? key}_(${(p.w / 25.4).toFixed(2)}_x_${(p.h / 25.4).toFixed(2)}_Inches)`;
}

async function runDashPlot(app: App, ctx: CommandContext): Promise<void> {
  let st = app.active!;
  const detailed = await askYN(ctx, '상세한 플롯 구성을 원하십니까?', false);
  // 배치
  const layoutName = (l: Layout) => (tableKey(l.blockName) === MODEL_SPACE ? '모형' : l.name);
  let layout: Layout | undefined;
  for (;;) {
    const cur = st.layoutFor(st.displaySpace);
    const def = cur ? layoutName(cur) : '모형';
    const t = await askWord(ctx, `배치 이름 또는 [?] 입력 <${def}>:`);
    if (t === '?') {
      for (const l of st.layouts) ctx.print(`  ${layoutName(l)}`);
      continue;
    }
    const name = t ?? def;
    const up = name.toUpperCase();
    layout = st.layouts.find((l) => (up === '모형' || up === 'MODEL' ? tableKey(l.blockName) === MODEL_SPACE : l.name.toUpperCase() === up));
    if (!layout && (up === '모형' || up === 'MODEL')) break;
    if (!layout) {
      ctx.print(`배치 "${name}"이(가) 없습니다.`, 'err');
      continue;
    }
    break;
  }
  const model = !layout || tableKey(layout.blockName) === MODEL_SPACE;
  // 이 배치를 플롯하려면 그 공간을 보여야 한다(PLOT과 같은 출력 경로)
  if (!model && layout && st.displaySpace !== tableKey(layout.blockName)) {
    await app.setSpace(layout.blockName);
    st = app.active!;
  } else if (model && st.onLayout) {
    await app.setSpace(MODEL_SPACE);
    st = app.active!;
  }
  const prev = lastSettings.get(st);
  const page = layout?.plot;
  const metric = !!st.units.measurement;
  const s: PlotSettings = {
    what: model ? (prev?.what === 'extents' || prev?.what === 'window' ? prev.what : 'display') : 'layout',
    paper: prev?.paper ?? (page && keyOfPage(page)) ?? (metric ? 'A3' : 'TABLOID'),
    landscape: prev?.landscape ?? true,
    scale: prev?.scale ?? 'fit',
    plotStyle: prev?.plotStyle ?? styleSheetPlotStyle(page?.styleSheet) ?? 'mono',
    ctb: prev?.ctb ?? ctbByName(page?.styleSheet)?.name,
    lineweights: prev?.lineweights ?? true,
    format: 'pdf',
    margin: 5,
    window: prev?.window,
  };
  let devName = page?.printerName && deviceKind(page.printerName) ? page.printerName : 'DWG To PDF.pc3';
  const askDevice = async () => {
    for (;;) {
      const t = await askWord(ctx, `출력 장치 이름 또는 [?] 입력 <${devName}>:`);
      if (t === '?') {
        ctx.print('사용할 수 있는 장치:');
        for (const d of PLOT_DEVICES) ctx.print(`  ${d}`);
        continue;
      }
      const name = t ?? devName;
      if (!deviceKind(name)) {
        ctx.print(`장치 "${name}"을(를) 찾을 수 없습니다. ?로 목록을 보십시오(이 웹 버전은 PDF·SVG 파일로만 출력합니다).`, 'err');
        continue;
      }
      devName = name;
      return;
    }
  };
  if (!detailed) {
    const { items } = namedPageSetups(st.doc);
    for (;;) {
      const t = await askWord(ctx, `페이지 설정 이름 입력 <${page?.pageSetupName ?? ''}>:`);
      if (t === null) break;
      const hit = items.find((x) => x.name.toUpperCase() === t.toUpperCase());
      if (!hit) {
        ctx.print(`페이지 설정 "${t}"을(를) 찾을 수 없습니다.`, 'err');
        continue;
      }
      const k = keyOfPage(hit.plot);
      if (k) s.paper = k;
      const w = hit.plot.rotation & 1 ? hit.plot.paperHeight : hit.plot.paperWidth;
      const h = hit.plot.rotation & 1 ? hit.plot.paperWidth : hit.plot.paperHeight;
      s.landscape = w >= h;
      if (hit.plot.styleSheet) {
        s.ctb = ctbByName(hit.plot.styleSheet)?.name;
        s.plotStyle = styleSheetPlotStyle(hit.plot.styleSheet) ?? 'color';
      }
      if (deviceKind(hit.plot.printerName)) devName = hit.plot.printerName;
      break;
    }
    await askDevice();
  } else {
    await askDevice();
    // 용지
    for (;;) {
      const cur = PAPERS.find((p) => p.key === s.paper) ?? PAPERS[1]!;
      const t = await askWord(ctx, `용지 크기 또는 [?] 입력 <${cur.label}>:`);
      if (t === '?') {
        for (const p of PAPERS) ctx.print(`  ${p.label}`);
        continue;
      }
      if (t === null) break;
      const k = paperKeyOf(t);
      if (!k) {
        ctx.print(`용지 "${t}"을(를) 찾을 수 없습니다. ?로 목록을 보십시오.`, 'err');
        continue;
      }
      s.paper = k;
      break;
    }
    const inches = (await askOption(
      ctx,
      `용지 단위 입력 [인치(I)/밀리미터(M)] <${metric ? '밀리미터' : '인치'}>:`,
      [
        { key: 'I', label: '인치' },
        { key: 'M', label: '밀리미터' },
      ],
      metric ? 'M' : 'I',
    )) === 'I';
    s.landscape =
      (await askOption(
        ctx,
        `용지 방향 입력 [세로(P)/가로(L)] <${s.landscape ? '가로' : '세로'}>:`,
        [
          { key: 'P', label: '세로' },
          { key: 'L', label: '가로' },
        ],
        s.landscape ? 'L' : 'P',
      )) === 'L';
    if (await askYN(ctx, '위 아래를 뒤집어 플롯?', false)) ctx.print('위 아래를 뒤집은 플롯은 이 웹 버전에서 할 수 없습니다. 바로 놓아 플롯합니다.');
    // 플롯 영역
    if (model) {
      const area = await askOption(
        ctx,
        `플롯 영역 입력 [화면표시(D)/범위(E)/한계(L)/뷰(V)/윈도우(W)] <${s.what === 'extents' ? '범위' : s.what === 'window' ? '윈도우' : '화면표시'}>:`,
        [
          { key: 'D', label: '화면표시' },
          { key: 'E', label: '범위' },
          { key: 'L', label: '한계' },
          { key: 'V', label: '뷰' },
          { key: 'W', label: '윈도우' },
        ],
        s.what === 'extents' ? 'E' : s.what === 'window' ? 'W' : 'D',
      );
      if (area === 'D') s.what = 'display';
      else if (area === 'E') s.what = 'extents';
      else if (area === 'L') {
        const a = st.doc.header.get('$LIMMIN') as { x: number; y: number } | undefined;
        const b = st.doc.header.get('$LIMMAX') as { x: number; y: number } | undefined;
        if (a && b && typeof a === 'object' && typeof b === 'object') {
          s.what = 'window';
          s.window = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
        } else {
          ctx.print('도면 한계가 없어 범위를 플롯합니다.');
          s.what = 'extents';
        }
      } else if (area === 'V') {
        for (;;) {
          const t = await askWord(ctx, '뷰 이름 입력:');
          if (t === null) break;
          const v = st.doc.views.get(tableKey(t));
          if (!v) {
            ctx.print(`뷰 "${t}"을(를) 찾을 수 없습니다.`, 'err');
            continue;
          }
          s.what = 'window';
          s.window = [v.center.x - v.width / 2, v.center.y - v.height / 2, v.center.x + v.width / 2, v.center.y + v.height / 2];
          break;
        }
      } else {
        const w0 = s.window ?? [0, 0, 0, 0];
        const p1 = await askWord(ctx, `윈도우 왼쪽 아래 좌표를 입력하십시오 <${w0[0]},${w0[1]}>:`);
        const p2 = await askWord(ctx, `윈도우 오른쪽 위 좌표를 입력하십시오 <${w0[2]},${w0[3]}>:`);
        const xy = (t: string | null, dx: number, dy: number) => {
          const m = t ? /^(-?[\d.]+),(-?[\d.]+)/.exec(t) : null;
          return m ? [Number(m[1]), Number(m[2])] : [dx, dy];
        };
        const [x0, y0] = xy(p1, w0[0], w0[1]) as [number, number];
        const [x1, y1] = xy(p2, w0[2], w0[3]) as [number, number];
        if (x0 === x1 || y0 === y1) {
          ctx.print('윈도우는 폭과 높이가 0이 아니어야 합니다.', 'err');
          return;
        }
        s.what = 'window';
        s.window = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      }
    } else {
      const area = await askOption(
        ctx,
        '플롯 영역 입력 [화면표시(D)/범위(E)/배치(L)/뷰(V)/윈도우(W)] <배치>:',
        [
          { key: 'D', label: '화면표시' },
          { key: 'E', label: '범위' },
          { key: 'L', label: '배치' },
          { key: 'V', label: '뷰' },
          { key: 'W', label: '윈도우' },
        ],
        'L',
      );
      if (area === 'V') await askWord(ctx, '뷰 이름 입력:');
      if (area === 'W') {
        await askWord(ctx, '윈도우 왼쪽 아래 좌표를 입력하십시오 <0,0>:');
        await askWord(ctx, '윈도우 오른쪽 위 좌표를 입력하십시오 <0,0>:');
      }
      if (area !== 'L') ctx.print('배치는 용지 전체(배치)로만 플롯할 수 있습니다. 배치 전체를 플롯합니다.');
      s.what = 'layout';
    }
    // 축척
    for (;;) {
      const t = await askWord(ctx, `플롯 축척 입력 (출력 ${inches ? '인치' : '밀리미터'}=도면 단위)또는 [맞춤(F)] <${model ? (s.scale === 'fit' ? '맞춤' : s.scale.replace(':', '=')) : '1=1'}>:`, [{ key: 'F', label: '맞춤' }]);
      if (t === null) break;
      const v = parsePlotScale(t);
      if (!v) {
        ctx.print('축척은 "1=100"처럼 입력하거나 맞춤(F)을 입력하십시오.', 'err');
        continue;
      }
      if (!model) {
        if (v !== 'fit' && Math.abs(v.paper / v.units - 1) > 1e-9) ctx.print('배치는 1:1로만 플롯합니다(뷰포트 축척은 배치에서 정합니다).');
        break;
      }
      if (v === 'fit') s.scale = 'fit';
      else {
        // 용지 mm / 도면 단위 → PLOT 축척("용지 mm : 실제 mm")
        const mmPerUnit = ((inches ? 25.4 : 1) * v.paper) / v.units;
        const u = unitMm(st.units.insunits || (st.units.measurement ? 4 : 1));
        s.scale = `${+(mmPerUnit / u).toPrecision(12)}:1`;
      }
      break;
    }
    const off = await askWord(ctx, '플롯 간격띄우기 입력(x,y) 또는 [중심(C)] <0.00,0.00>:', [{ key: 'C', label: '중심' }]);
    if (off !== null && off !== 'C' && !/^0*\.?0*,0*\.?0*$/.test(off)) ctx.print('플롯 간격띄우기는 이 웹 버전에서 쓸 수 없습니다. 용지 가운데에 플롯합니다.');
    const withStyles = await askYN(ctx, '플롯 스타일로 플롯?', true);
    for (;;) {
      const curTable = s.ctb ?? (s.plotStyle === 'mono' ? 'monochrome.ctb' : s.plotStyle === 'gray' ? 'Grayscale.ctb' : '');
      const t = await askWord(ctx, `플롯 스타일 테이블 이름 또는 [?] 입력 (없는 경우 . 입력) <${curTable}>:`);
      if (t === '?') {
        for (const n of ['monochrome.ctb', 'Grayscale.ctb', ...ctbList().map((x) => x.name)]) ctx.print(`  ${n}`);
        continue;
      }
      const name = t ?? curTable;
      if (name === '.' || !name) {
        s.ctb = undefined;
        s.plotStyle = 'color';
      } else if (ctbByName(name)) {
        s.ctb = ctbByName(name)!.name;
        s.plotStyle = 'color';
      } else if (styleSheetPlotStyle(name) !== 'color') {
        s.ctb = undefined;
        s.plotStyle = styleSheetPlotStyle(name)!;
      } else {
        ctx.print(`플롯 스타일 테이블 "${name}"을(를) 불러오지 않았습니다. PLOT 대화상자에서 CTB 파일을 불러오십시오. 색 그대로 플롯합니다.`);
        s.ctb = undefined;
        s.plotStyle = 'color';
      }
      break;
    }
    if (!withStyles) {
      s.ctb = undefined;
      s.plotStyle = 'color';
    }
    s.lineweights = await askYN(ctx, '선가중치로 플롯?', s.lineweights);
    if (model) {
      const shade = await askOption(
        ctx,
        '음영 플롯 설정 입력 [화면표시대로(A)/와이어프레임(W)/숨김(H)/비주얼 스타일(V)/렌더(R)] <화면표시대로>:',
        [
          { key: 'A', label: '화면표시대로' },
          { key: 'W', label: '와이어프레임' },
          { key: 'H', label: '숨김' },
          { key: 'V', label: '비주얼 스타일' },
          { key: 'R', label: '렌더' },
        ],
        'A',
      );
      if (shade !== 'A' && shade !== 'W') ctx.print('2D 캐드라 화면표시대로 플롯합니다.');
    } else {
      await askYN(ctx, '선가중치를 플롯 축척에 적용?', false);
      await askYN(ctx, '도면 공간을 먼저 플롯?', false);
      await askYN(ctx, '도면 공간 객체 숨기기?', false);
    }
  }
  const kind = deviceKind(devName)!;
  const spaceName = model ? '모형' : (layout?.name ?? 'layout');
  let fileName = `${baseName(st.saveName)}-${spaceName}.${kind === 'svg' ? 'svg' : 'pdf'}`;
  if (kind !== 'none') {
    const t = (await askLine(ctx, `파일 이름 입력 <${fileName}>:`, fileName)).trim().replace(/^"(.*)"$/, '$1');
    if (t) fileName = t.replace(/^.*[\\/]/, '');
    if (!new RegExp(`\\.${kind}$`, 'i').test(fileName)) fileName += `.${kind}`;
  }
  // 페이지 설정 저장(배치·모형 탭의 플롯 설정)
  if (await askYN(ctx, '페이지 설정에 대한 변경 사항 저장', false)) {
    if (!layout) ctx.print('모형 탭의 페이지 설정이 이 도면에 없어 저장하지 않았습니다.');
    else {
      const p = PAPERS.find((x) => x.key === s.paper)!;
      const np: PageSettings = {
        ...structuredClone(layout.plot),
        printerName: kind === 'none' ? 'none_device' : devName,
        paperName: mediaName(s.paper),
        paperWidth: p.w,
        paperHeight: p.h,
        rotation: s.landscape ? 1 : 0,
        styleSheet: s.ctb ?? (s.plotStyle === 'mono' ? 'monochrome.ctb' : s.plotStyle === 'gray' ? 'Grayscale.ctb' : ''),
      };
      const ops: EditOp[] = [{ kind: 'layout', key: tableKey(layout.blockName), before: layout, after: { ...layout, plot: np } }];
      st.session.commit({ label: 'PLOT', ops, group: ctx.group });
    }
  }
  if (!(await askYN(ctx, '플롯을 진행합니까?', true))) return;
  if (kind === 'none') {
    ctx.print('출력 장치가 "없음"이라 플롯할 수 없습니다.', 'err');
    return;
  }
  lastSettings.set(st, { ...s, format: kind === 'svg' ? 'svg' : 'pdf' });
  const pages = await plotPages(app, st, s, kind === 'svg' ? 1 : PT_PER_MM);
  if (!pages.length) {
    ctx.print('출력할 내용이 없습니다.', 'err');
    return;
  }
  if (kind === 'svg') download(exportPageSvg(pages[0]!, 'mm'), fileName);
  else download(await pdfDocument(pages, st.saveName), fileName);
  ctx.print(`${fileName}(으)로 플롯했습니다.`);
}

// ---------------------------------------------------------------------------
// PSETUPIN · -PSETUPIN
// ---------------------------------------------------------------------------

/** 다른 도면 고르기: 파일 선택 창, 또는 스크립트·FILEDIA 0이면 이름(이번 세션에서 읽은 도면·열린 탭) */
async function sourceDrawing(app: App, ctx: CommandContext, byName: boolean): Promise<{ name: string; doc: CadDocument } | null> {
  if (byName) {
    const t = (await askLine(ctx, '파일 이름 입력:', '')).trim().replace(/^"(.*)"$/, '$1');
    if (!t) return null;
    const base = t.replace(/^.*[\\/]/, '').toLowerCase();
    const same = (n: string) => n.toLowerCase() === base || n.toLowerCase().replace(/\.[^.]*$/, '') === base;
    const read = loadedDrawings().find((d) => same(d.name));
    if (read) return { name: read.name, doc: read.doc };
    const open = app.docs.find((d) => same(d.saveName) || same(d.name));
    if (open) return { name: open.saveName, doc: open.doc };
    ctx.print(`"${t}"을(를) 찾을 수 없습니다. 이 웹 버전은 경로로 파일을 열 수 없어 열린 도면이나 이번 세션에서 읽은 도면(디자인센터 등)만 이름으로 쓸 수 있습니다.`, 'err');
    return null;
  }
  const files = await pickFiles(DRAWING_ACCEPT, false);
  const f = files[0];
  if (!f) return null;
  try {
    const d = await readDrawingFile(app, f);
    return { name: d.name, doc: d.doc };
  } catch (e) {
    ctx.print(`${f.name}을(를) 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    return null;
  } finally {
    app.ui.setBusy(null);
  }
}

function commitImport(app: App, ctx: CommandContext, setups: NamedPageSetup[], overwrite: Set<string>): void {
  const st = app.active!;
  const r = importPageSetupOps(st.doc, setups, overwrite, () => st.session.newHandle());
  if (!r) {
    ctx.print('이 도면에 이름 있는 객체 사전이 없어 페이지 설정을 넣을 수 없습니다.', 'err');
    return;
  }
  if (r.ops.length) st.session.commit({ label: 'PSETUPIN', ops: r.ops, group: ctx.group });
  ctx.print(`페이지 설정 ${r.added.length + r.replaced.length}개를 가져왔습니다${r.replaced.length ? `(재정의 ${r.replaced.length}개)` : ''}.`);
}

async function runDashPsetupin(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const src = await sourceDrawing(app, ctx, fileNameMode(app));
  if (!src) return;
  const { items } = namedPageSetups(src.doc);
  if (!items.length) {
    ctx.print(`${src.name}에 가져올 사용자 정의 페이지 설정이 없습니다.`);
    return;
  }
  for (;;) {
    const spec = await askWord(ctx, '가져올 사용자 정의 페이지 설정 입력 또는 [?]:');
    if (spec === null) return;
    if (spec === '?') {
      for (const it of items) ctx.print(`  ${it.name.padEnd(24)}${it.model ? '모형' : '배치'}`);
      continue;
    }
    const m = matchNameList(
      items.map((x) => x.name),
      spec,
    );
    for (const u of m.unmatched) ctx.print(`페이지 설정 "${u}"을(를) 찾을 수 없습니다.`);
    if (!m.names.length) continue;
    const chosen = items.filter((x) => m.names.includes(x.name) && validSetupName(x.name));
    const existing = new Set(namedPageSetups(st.doc).items.map((x) => x.name.toUpperCase()));
    const overwrite = new Set<string>();
    const take: NamedPageSetup[] = [];
    for (const it of chosen) {
      if (existing.has(it.name.toUpperCase())) {
        if (!(await askYN(ctx, `페이지 설정 "${it.name}"이(가) 이미 있습니다. 재정의하시겠습니까?`, false))) continue;
        overwrite.add(it.name.toUpperCase());
      }
      take.push(it);
    }
    if (take.length) commitImport(app, ctx, take, overwrite);
    return;
  }
}

async function runPsetupin(app: App, ctx: CommandContext): Promise<void> {
  if (fileNameMode(app)) return runDashPsetupin(app, ctx);
  const st = app.active!;
  const src = await sourceDrawing(app, ctx, false);
  if (!src) return;
  const { items } = namedPageSetups(src.doc);
  if (!items.length) {
    ctx.print(`${src.name}에 가져올 사용자 정의 페이지 설정이 없습니다.`);
    return;
  }
  const v = await form(
    `페이지 설정 가져오기 - ${src.name}`,
    items.map((it, i) => ({ key: `p${i}`, label: `${it.name} (${it.model ? '모형' : '배치'})`, type: 'check' as const, value: false })),
    { ok: '확인', note: '가져올 페이지 설정을 고르십시오. 같은 이름이 있으면 재정의할지 묻습니다.' },
  );
  if (!v) return;
  const chosen = items.filter((it, i) => v[`p${i}`] && validSetupName(it.name));
  if (!chosen.length) return;
  const existing = new Set(namedPageSetups(st.doc).items.map((x) => x.name.toUpperCase()));
  const overwrite = new Set<string>();
  const take: NamedPageSetup[] = [];
  for (const it of chosen) {
    if (existing.has(it.name.toUpperCase())) {
      const a = await ask('페이지 설정 - 재정의', `페이지 설정 "${it.name}"이(가) 이 도면에 이미 있습니다. 재정의하시겠습니까?`, [
        { label: '예', value: 'Y', primary: true },
        { label: '아니오', value: 'N' },
        { label: '취소', value: 'C' },
      ]);
      if (a === 'C' || a === null) return;
      if (a === 'N') continue;
      overwrite.add(it.name.toUpperCase());
    }
    take.push(it);
  }
  if (take.length) commitImport(app, ctx, take, overwrite);
}

export function registerDashPlotCommands(app: App): void {
  app.register({ name: '-PLOT', aliases: ['-PRINT'], title: '플롯(명령행)', run: (ctx) => runDashPlot(app, ctx) });
  app.register({ name: 'PSETUPIN', title: '페이지 설정 가져오기', run: (ctx) => runPsetupin(app, ctx) });
  app.register({ name: '-PSETUPIN', title: '페이지 설정 가져오기(명령행)', run: (ctx) => runDashPsetupin(app, ctx) });
}
