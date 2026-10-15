import './styles.css';
import { App } from './app/app';
import { registerCommands } from './app/commands';
import { registerDrawCommands } from './app/draw';
import { registerBlockCommands } from './app/blocks';
import { registerEditCommands } from './app/editcmds';
import { registerTableCommands } from './app/tables';
import { registerPlotCommands } from './app/plot';
import { registerModifyCommands } from './app/modify';
import { registerSaveCommands } from './app/save';
import { registerAnnotateCommands } from './app/annotate';
import { registerDimCommands } from './app/dimcmds';
import { registerHatchCommands } from './app/hatchcmd';
import { registerLayoutCommands } from './app/layoutcmds';
import { noteMissingShx, registerShxCommands, restoreShxFonts } from './app/shxfonts';
import { noteMissingRefs, registerRefCommands } from './app/refs';
import { registerIsolateCommands } from './app/isolate';
import { registerViewportCommands } from './app/vpcmds';
import { registerViewCommands } from './app/viewcmds';
import { registerDraftingCommands } from './app/drafting';
import { registerUcsCommands } from './app/ucs';
import { registerLayerToolCommands } from './app/laytools';
import { registerPropCommands } from './app/propcmds';
import { registerDimStyleCommands } from './app/dimstyle';
import { registerUtil2Commands } from './app/util2';
import { registerModify2Commands } from './app/modify2';
import { registerAnnot2Commands } from './app/annot2';
import { registerDimAssocCommands } from './app/dimassoc';
import { registerDimInspectCommands } from './app/diminspect';
import { registerDynBlockCommands } from './app/dynblock';
import { noteForeignConstraints, registerConstraintCommands } from './app/constraints';
import { drawConstraintOverlay } from './app/constraints-draw';
import { registerAnnoScaleCommands } from './app/annoscale';
import { registerHelixCommands } from './app/helix';
import { registerCompareCommands } from './app/compare';
import { registerSketchCommands } from './app/sketch';
import { registerCountCommands } from './app/count';
import { registerImageClipCommands } from './app/imageclip';
import { registerExportCommands } from './app/exportcmd';
import { registerLayerTools2Commands } from './app/layertools2';
import { registerCmds2Commands } from './app/cmds2';
import { registerTextToolCommands } from './app/textools';
import { registerRefEditCommands } from './app/refedit';
import { registerTransmitCommands } from './app/transmit';
import { registerTableEditCommands } from './app/tablecmds';
import { fieldDisplay, onFieldDisplayChange, registerFieldCommands } from './app/fieldcmds';
import { displayFlags } from './render/styles';
import { registerMLineCommands } from './app/mlinecmds';
import { registerVportCommands } from './app/vports';
import { registerAutosaveCommands } from './app/autosave';
import { registerHyperlinkCommands } from './app/hyperlink';
import { registerHatchEditCommands } from './app/hatchedit';
import { registerDataExtractCommands } from './app/dataextract';
import { registerSelectionCyclingCommands } from './app/selcycle';
import { registerXclipCommands } from './app/xclip';
import { registerThemeCommands } from './app/theme';
import { registerExportLayoutCommands } from './app/exportlayout';
import { registerPdfImportCommands } from './app/pdfimport';
import { registerLayerStateCommands } from './app/layerstate';
import { registerExpressCommands } from './app/express';
import { registerViewToolCommands } from './app/viewtools';
import { registerAssocArrayCommands } from './app/assocarray';
import { registerLayerFilterCommands } from './app/layerfilter';
import { registerDashCommands } from './app/dashcmds';
import { Shell } from './app/ui/shell';
import { dialog, h, toast } from './app/ui/dom';
import { baseName, download, exportRaster, exportSvg } from './app/export';

const root = document.getElementById('app')!;
const shell = new Shell(root);
let app: App;
try {
  app = new App(shell.drawingHost);
} catch (e) {
  root.innerHTML = '';
  root.append(
    h(
      'div',
      { style: 'padding:40px;max-width:640px;margin:auto;line-height:1.7' },
      h('h2', {}, '이 브라우저에서는 뷰어를 실행할 수 없습니다'),
      h('p', {}, e instanceof Error ? e.message : String(e)),
      h('p', {}, '최신 Chrome, Edge, Firefox, Safari에서 열어 주십시오. 하드웨어 가속(WebGL2)이 꺼져 있으면 켜 주십시오.'),
    ),
  );
  throw e;
}
app.ui = shell;
shell.attach(app);
registerCommands(app);
registerDrawCommands(app);
registerBlockCommands(app);
registerEditCommands(app);
registerTableCommands(app);
registerPlotCommands(app);
registerModifyCommands(app);
registerSaveCommands(app);
registerAnnotateCommands(app);
registerDimCommands(app);
registerHatchCommands(app);
registerLayoutCommands(app);
registerShxCommands(app);
registerRefCommands(app);
registerIsolateCommands(app);
registerViewportCommands(app);
registerViewCommands(app);
registerDraftingCommands(app);
registerUcsCommands(app);
registerLayerToolCommands(app);
registerPropCommands(app);
registerDimStyleCommands(app);
// OOPS가 등록된 ERASE를 감싸므로 그리기 명령 뒤에 등록한다
registerUtil2Commands(app);
registerModify2Commands(app);
registerAnnot2Commands(app);
registerDimAssocCommands(app);
registerDimInspectCommands(app);
registerDynBlockCommands(app);
registerConstraintCommands(app);
registerAnnoScaleCommands(app);
registerHelixCommands(app);
registerCompareCommands(app);
registerSketchCommands(app);
registerCountCommands(app);
registerImageClipCommands(app);
registerExportCommands(app);
registerLayerTools2Commands(app);
registerCmds2Commands(app);
registerTextToolCommands(app);
registerRefEditCommands(app);
registerTransmitCommands(app);
app.view.extraOverlay = (g, W, dark) => drawConstraintOverlay(app, g, W, dark);
registerTableEditCommands(app);
registerFieldCommands(app);
registerMLineCommands(app);
registerVportCommands(app);
registerAutosaveCommands(app);
registerHyperlinkCommands(app);
registerHatchEditCommands(app);
registerDataExtractCommands(app);
registerSelectionCyclingCommands(app);
registerXclipCommands(app);
registerThemeCommands(app);
registerExportLayoutCommands(app);
registerPdfImportCommands(app);
registerLayerStateCommands(app);
registerExpressCommands(app);
registerViewToolCommands(app);
registerAssocArrayCommands(app);
registerLayerFilterCommands(app);
// 명령행 버전 명령은 이미 등록된 이름을 건너뛰므로 맨 뒤에 둔다
registerDashCommands(app);
// 필드 회색 배경(FIELDDISPLAY): 화면 표시 설정만 바꾸고 다시 그린다
displayFlags.fieldBackground = fieldDisplay() === 1;
onFieldDisplayChange((v) => {
  displayFlags.fieldBackground = v === 1;
  app.view.requestRender();
});
app.onOpened = (st) => {
  noteMissingShx(app, st);
  noteForeignConstraints(app, st);
  void noteMissingRefs(app, st);
};
void restoreShxFonts(app);

app.register({ name: 'OPEN', title: '열기', noDoc: true, run: () => shell.pickFiles() });
app.register({
  name: 'CLOSE',
  title: '닫기',
  run: () => {
    if (app.active) app.close(app.active);
  },
});
app.register({ name: 'DWGINFO', aliases: ['DWGPROPS'], title: '도면 정보', run: () => shell.showInfo() });
app.register({
  name: 'FULLSCREEN',
  aliases: ['CLEANSCREENON'],
  title: '전체 화면',
  noDoc: true,
  transparent: true,
  run: () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => toast('전체 화면을 쓸 수 없습니다.', 'warn'));
  },
});
for (const [name, kind, label] of [
  ['PNGOUT', 'png', 'PNG'],
  ['JPGOUT', 'jpg', 'JPEG'],
  ['BMPOUT', 'bmp', 'BMP'],
] as const) {
  app.register({
    name,
    aliases: name === 'BMPOUT' ? ['BMP'] : name === 'JPGOUT' ? ['JPEG'] : [],
    title: `${label}로 내보내기`,
    async run(ctx) {
      const b = await exportRaster(app, kind);
      if (!b) return;
      download(b, `${baseName(app.active!.name)}.${kind}`);
      ctx.print(`지금 화면을 ${label}로 저장했습니다.`);
    },
  });
}
app.register({
  name: 'SVGOUT',
  aliases: ['EXPORTSVG'],
  title: 'SVG로 내보내기',
  async run(ctx) {
    const b = await exportSvg(app);
    if (!b) return;
    download(b, `${baseName(app.active!.name)}.svg`);
    ctx.print(!app.active!.onLayout ? '지금 화면 범위를 SVG로 저장했습니다.' : '배치 용지를 SVG로 저장했습니다(단위 mm).');
  },
});
app.register({
  name: 'HELP',
  aliases: ['?'],
  title: '도움말',
  noDoc: true,
  transparent: true,
  run: () => {
    const rows: [string, string][] = [
      ['휠', '커서 위치를 기준으로 확대·축소'],
      ['가운데 버튼 끌기 · Alt+끌기 · Space+끌기', '화면 이동'],
      ['가운데 버튼 두 번 누르기', '전체 보기(범위)'],
      ['왼쪽 클릭', '객체 선택(Shift+클릭 = 선택 빼기)'],
      ['빈 곳에서 오른쪽으로 끌기 / 왼쪽으로 끌기', '윈도우 선택 / 걸침 선택'],
      ['객체 두 번 클릭', '특성 보기'],
      ['오른쪽 클릭', '바로가기 메뉴(명령 중에는 Enter·옵션·스냅 재지정)'],
      ['Esc', '명령 취소, 선택 해제'],
      ['Enter · Space', '입력 마침, 빈 입력이면 직전 명령 반복'],
      ['선택한 객체의 파란 그립 누르기', '그립 편집: 신축(Enter로 이동 → 회전 → 축척 → 대칭)'],
      ['F1 · F2 · F3 · F8 · F10 · F11 · F12', '도움말 · 명령 기록 펼치기 · 객체 스냅 · 직교 · 극좌표 추적 · 객체 스냅 추적 · 동적 입력'],
      ['Ctrl+N · Ctrl+O · Ctrl+S · Ctrl+Shift+S', '새 도면 · 열기 · 저장 · 다른 이름으로 저장'],
      ['Ctrl+Z · Ctrl+Y · Ctrl+C · Ctrl+X · Ctrl+V', '명령 취소 · 복구 · 복사 · 잘라내기 · 붙여넣기'],
      ['F5 · Ctrl+E', '등각평면 전환(등각투영 제도가 켜졌을 때)'],
      ['Shift+Ctrl+L', '도면층 상태 관리자'],
      ['Ctrl+R', '최대화한 뷰포트에서 다음 뷰포트로'],
      ['Ctrl+1 · Ctrl+A · Ctrl+P · Ctrl+9', '특성 · 모두 선택 · 플롯 · 명령행 숨기기'],
      ['Ctrl+Tab · Ctrl+PgUp/PgDn', '다음 도면 · 배치 전환'],
      ['터치', '한 손가락 = 이동, 두 손가락 = 확대·축소, 탭 = 선택'],
    ];
    const cmds = [...app.commands.values()]
      .filter((c) => !['MEASURERADIUS', 'ZOOMIN', 'ZOOMOUT', 'GRIPEDIT'].includes(c.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    dialog(
      '도움말',
      h(
        'div',
        {},
        h('h4', { style: 'margin:0 0 6px' }, '조작'),
        h('table', { class: 'grid' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('td', { style: 'white-space:normal;color:var(--text-dim);width:45%' }, k), h('td', { style: 'white-space:normal' }, v))))),
        h('h4', { style: 'margin:14px 0 6px' }, '명령(명령행에 입력)'),
        h(
          'table',
          { class: 'grid' },
          h('tbody', {}, ...cmds.map((c) => h('tr', {}, h('td', { style: 'font-family:var(--mono)' }, c.name), h('td', { style: 'font-family:var(--mono);color:var(--text-dim)' }, (c.aliases ?? []).join(', ')), h('td', {}, c.title)))),
        ),
        h('h4', { style: 'margin:14px 0 6px' }, '점 입력'),
        h('div', { style: 'color:var(--text-dim)' }, '100,50 (절대 좌표) · @20,0 (직전 점에서 상대) · @30<45 (거리<각도) · 숫자만 입력하면 커서 방향으로 그 거리'),
      ),
    );
  },
});
app.register({
  name: 'ABOUT',
  title: '이 뷰어에 대하여',
  noDoc: true,
  run: () => {
    dialog(
      'OpenCAD 2D 뷰어',
      `<p>CAD 파일을 특정 프로그램 없이 누구나 열어 볼 수 있게 하려는 OpenCAD 프로젝트의 2D 뷰어입니다. 서버 없이 브라우저 안에서만 동작하며, 연 파일은 이 컴퓨터를 떠나지 않습니다.</p>
       <p>DXF 리더와 DWG 리더(ODA 공개 명세 기반)를 직접 구현했습니다. 글꼴: Hershey Roman Simplex(공개 도메인), Noto Sans KR(SIL OFL 1.1).</p>
       <p>소스: <a href="https://github.com/GyuTae-Kim/2dcad-viewer" target="_blank" rel="noopener">github.com/GyuTae-Kim/2dcad-viewer</a> (MIT)</p>`,
    );
  },
});

app.activate(null);

// 주소에 ?sample 이 있으면 예제를, ?open=주소 가 있으면 그 파일을 연다
const params = new URLSearchParams(location.search);
if (params.has('sample')) void shell.openSample();
const openUrl = params.get('open');
if (openUrl) {
  void (async () => {
    try {
      const u = new URL(openUrl, document.baseURI);
      if (u.protocol !== 'https:' && u.origin !== location.origin) throw new Error('https 주소만 열 수 있습니다.');
      const r = await fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const name = decodeURIComponent(u.pathname.split('/').pop() || 'drawing.dxf');
      await app.openFile(name, await r.arrayBuffer());
    } catch (e) {
      toast(`파일을 받지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'error', 7000);
    }
  })();
}

// 개발용 접근
(window as unknown as { opencad: App }).opencad = app;
