import './styles.css';
import { App } from './app/app';
import { registerCommands } from './app/commands';
import { registerDrawCommands } from './app/draw';
import { registerBlockCommands } from './app/blocks';
import { registerEditCommands } from './app/editcmds';
import { registerTableCommands } from './app/tables';
import { registerPlotCommands } from './app/plot';
import { registerAnnotateCommands } from './app/annotate';
import { Shell } from './app/ui/shell';
import { dialog, h, toast } from './app/ui/dom';
import { baseName, download, exportPng, exportSvg } from './app/export';

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
registerAnnotateCommands(app);

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
app.register({
  name: 'PNGOUT',
  aliases: ['JPGOUT', 'BMPOUT'],
  title: 'PNG로 내보내기',
  async run(ctx) {
    const b = await exportPng(app);
    if (!b) return;
    download(b, `${baseName(app.active!.name)}.png`);
    ctx.print('지금 화면을 PNG로 저장했습니다.');
  },
});
app.register({
  name: 'SVGOUT',
  aliases: ['EXPORTSVG'],
  title: 'SVG로 내보내기',
  async run(ctx) {
    const b = exportSvg(app);
    if (!b) return;
    download(b, `${baseName(app.active!.name)}.svg`);
    ctx.print(app.active!.isModel ? '지금 화면 범위를 SVG로 저장했습니다.' : '배치 용지를 SVG로 저장했습니다(단위 mm).');
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
      ['F1 · F2 · F3 · F8', '도움말 · 명령 기록 펼치기 · 객체 스냅 · 직교'],
      ['Ctrl+O · Ctrl+1 · Ctrl+A · Ctrl+P · Ctrl+9', '열기 · 특성 · 모두 선택 · PDF · 명령행 숨기기'],
      ['Ctrl+Tab · Ctrl+PgUp/PgDn', '다음 도면 · 배치 전환'],
      ['터치', '한 손가락 = 이동, 두 손가락 = 확대·축소, 탭 = 선택'],
    ];
    const cmds = [...app.commands.values()]
      .filter((c) => !['MEASURERADIUS', 'ZOOMIN', 'ZOOMOUT'].includes(c.name))
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
