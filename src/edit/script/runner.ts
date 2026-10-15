/**
 * 스크립트 실행기: 읽은 입력을 명령행에 하나씩 넣는다(화면·DOM 없음 — 명령행과의 연결은 ScriptHost).
 * - 명령 자리: 접두어(_ . ')를 떼고, 대화상자 명령에 명령행 버전이 있으면 그것을 부른다. 빈 입력은 직전 명령 반복(AutoCAD와 같다).
 *   명령이 아닌 이름이 도면 변수면 SETVAR로 넘긴다. 알 수 없는 이름이면 멈추고 줄 번호를 알린다.
 * - 프롬프트: 입력을 그대로 넣는다(공백을 받는 프롬프트는 줄 끝까지). 국제 키워드 접두어 _는 뗀다.
 * - 객체 선택 프롬프트: 점(그 자리 객체, 없으면 반대 구석까지 창), W·C·BOX(두 구석)를 여기서 처리한다.
 * - 명령이 오류를 출력하면(err) 멈추고 줄 번호를 알린다. Esc·Backspace로 멈추고 RESUME으로 이어서, RSCRIPT로 처음부터.
 * - 한 번 이어서 실행한 동안의 편집은 명령 취소 한 번으로 되돌린다.
 */
import { type ScriptToken, ScriptReader, parseCommandWord, parseScriptPoint, scriptCommandName, stripKeywordPrefix } from './reader';

export type HostState = 'command' | 'input' | 'busy';
type Pt = { x: number; y: number };

export interface ScriptHost {
  /** command: 명령 없음, input: 명령이 입력을 기다림, busy: 명령이 일하는 중(대화상자·비동기 작업) */
  state(): HostState;
  /** 기다리는 입력 종류 */
  inputKind(): 'point' | 'entity' | 'select' | null;
  /** 지금 프롬프트가 공백을 입력으로 받는가(문자 입력) */
  acceptsSpaces(): boolean;
  /** 이름(별칭) → 등록된 명령 이름. 없으면 null */
  findCommand(name: string): string | null;
  /** 정확히 그 이름으로 등록된 명령이 있는가 */
  hasCommand(name: string): boolean;
  /** 도면 변수(SETVAR로 바꿀 수 있는 이름)인가 */
  isVariable(name: string): boolean;
  runCommand(name: string, arg?: string): void;
  /** 프롬프트에 답을 넣는다 */
  submit(text: string): void;
  print(text: string, cls?: 'err' | 'res'): void;
  /** 명령행 출력을 지켜본다. 해제 함수를 돌려준다 */
  watchPrint(f: (text: string, cls?: 'err' | 'res') => void): () => void;
  /** Esc·Backspace를 지켜본다(없으면 생략) */
  watchKeys?(f: (key: 'esc' | 'backspace') => void): () => void;
  /** 선택 프롬프트: 그 점의 객체를 고른다. 고른 수 */
  selectAt(p: Pt): number;
  /** 객체 하나 고르기 프롬프트: 그 점의 객체를 답으로 넣는다. 객체가 없으면 false */
  pickEntity(p: Pt): boolean;
  /** 선택 프롬프트: 창(crossing이면 걸침)으로 고른다. 고른 수 */
  selectWindow(a: Pt, b: Pt, crossing: boolean): number;
  clearSelection(): void;
  /** 대화상자가 열려 있는가 */
  dialogOpen(): boolean;
  /** 명령 취소 기록의 지금 자리(문서와 깊이) */
  undoMark(): unknown;
  /** 그 자리 뒤에 쌓인 명령 취소 항목을 하나로 합친다(자리를 잡은 문서에서) */
  squashUndo(mark: unknown, label: string): void;
  /** ms만큼(0이면 다음 차례까지) 기다린다 */
  wait(ms: number): Promise<void>;
  /** 지금 시각(ms) */
  now(): number;
  /** 편집을 화면 장면에 반영한다(범위를 쓰는 ZOOM 등 앞에서. 없으면 생략) */
  flush?(): Promise<void>;
}

/** 부르기 전에 편집을 장면에 반영해야 하는 명령(도면 범위를 쓴다) */
const NEEDS_FLUSH = new Set(['ZOOM', 'PAN', '-PAN', 'REGEN', 'REGENALL', 'VIEW', '-VIEW']);

export type ScriptStatus = 'idle' | 'running' | 'paused';

export class ScriptRunner {
  status: ScriptStatus = 'idle';
  /** 실행 중(또는 멈춘) 스크립트 이름 */
  name = '';
  private reader: ScriptReader | null = null;
  private looping = false;
  private failed: string | null = null;
  private quiet = false;
  private current: ScriptToken | null = null;
  private lastCommand: string | null = null;
  private corner: { mode: 'W' | 'C' | 'BOX' | 'AUTO'; first: Pt | null } | null = null;
  private lastPoint: Pt | null = null;
  /** 끝나거나 멈출 때(시험·화면 갱신) */
  onStop: ((status: ScriptStatus, reason: 'end' | 'error' | 'interrupt') => void) | null = null;

  constructor(private readonly host: ScriptHost) {}

  /** 스크립트를 넣는다. 실행 중이면 지금 스크립트를 바꾸고(AutoCAD의 SCRIPT 안 SCRIPT), 아니면 실행을 시작한다 */
  load(name: string, text: string): void {
    this.reader = new ScriptReader(text);
    this.name = name;
    this.corner = null;
    this.failed = null;
    if (this.looping) this.status = 'running';
    else void this.loop();
  }

  /** 처음부터 다시(RSCRIPT). 스크립트가 없으면 false */
  restart(): boolean {
    if (!this.reader) return false;
    this.reader.reset();
    this.corner = null;
    this.failed = null;
    if (this.looping) this.status = 'running';
    else void this.loop();
    return true;
  }

  /** 멈춘 스크립트를 이어서(RESUME). 멈춘 것이 없으면 false */
  resume(): boolean {
    if (this.status !== 'paused' || !this.reader || this.reader.done) return false;
    if (this.looping) this.status = 'running';
    else void this.loop();
    return true;
  }

  /** 멈춤(Esc·Backspace) */
  interrupt(): void {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.say(`스크립트 "${this.name}"을(를) ${this.current?.line ?? 1}번째 줄에서 멈췄습니다. 이어서 하려면 RESUME을 입력하십시오.`);
    this.onStop?.('paused', 'interrupt');
  }

  /** 지금 줄(멈춘 자리) */
  get line(): number {
    return this.current?.line ?? 0;
  }

  get active(): boolean {
    return this.looping && this.status === 'running';
  }

  private say(text: string, cls?: 'err' | 'res'): void {
    this.quiet = true;
    try {
      this.host.print(text, cls);
    } finally {
      this.quiet = false;
    }
  }

  private fail(message: string): void {
    const t = this.current;
    this.status = 'paused';
    this.say(`스크립트 "${this.name}" ${t?.line ?? 0}번째 줄${t ? ` "${t.text}"` : ''}에서 멈췄습니다: ${message}`, 'err');
    this.say('고친 뒤 이어서 하려면 RESUME, 처음부터는 RSCRIPT를 입력하십시오.');
    this.onStop?.('paused', 'error');
  }

  private async loop(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    this.status = 'running';
    this.failed = null;
    const h = this.host;
    const mark = h.undoMark();
    const unwatch = h.watchPrint((text, cls) => {
      if (cls === 'err' && !this.quiet && this.status === 'running' && this.failed === null) this.failed = text;
    });
    const unkeys = h.watchKeys?.(() => this.interrupt()) ?? (() => {});
    let yielded = h.now();
    let finished = false;
    try {
      // 이 스크립트를 부른 명령(SCRIPT·RESUME)이 끝나기를 기다린다
      await h.wait(0);
      while (this.status === 'running') {
        await this.settle();
        if (this.status !== 'running') break;
        if (this.failed !== null) {
          this.fail(this.failed);
          break;
        }
        const state = h.state();
        const kind = state === 'input' ? h.inputKind() : null;
        const tok = this.reader!.next(state === 'input' && kind !== 'select' && !this.corner && h.acceptsSpaces());
        if (!tok) {
          if (this.corner) this.fail('반대 구석을 지정하지 않았습니다.');
          else finished = true;
          break;
        }
        this.current = tok;
        if (state === 'command') await this.commandToken(tok);
        else if (kind === 'select' || this.corner) this.selectToken(tok);
        else if (kind === 'entity') this.entityToken(tok);
        else h.submit(h.acceptsSpaces() ? tok.text : stripKeywordPrefix(tok.text));
        // 화면이 멈추지 않게 가끔 쉰다
        if (h.now() - yielded > 30) {
          await h.wait(0);
          yielded = h.now();
        }
      }
    } finally {
      unwatch();
      unkeys();
      this.corner = null;
      h.squashUndo(mark, `SCRIPT ${this.name}`);
      this.looping = false;
    }
    // 마지막 입력의 오류는 반복 첫머리(settle 뒤)에서 이미 보았다
    if (finished && this.status === 'running') {
      this.status = 'idle';
      this.say(`스크립트 "${this.name}"을(를) 끝까지 실행했습니다.`, 'res');
      if (this.host.state() === 'input') this.say('참고: 명령이 아직 입력을 기다립니다. 스크립트 마지막 줄 끝의 Enter(빈 줄)가 빠졌을 수 있습니다.');
      this.onStop?.('idle', 'end');
    }
  }

  /** 명령이 일을 마치고 입력을 기다리거나 끝날 때까지 */
  private async settle(): Promise<void> {
    const h = this.host;
    // 대부분은 마이크로태스크 몇 번이면 다음 프롬프트가 나온다
    for (let i = 0; i < 20 && h.state() === 'busy'; i++) await Promise.resolve();
    let noted = false;
    while (h.state() === 'busy' && this.status === 'running') {
      if (!noted && h.dialogOpen()) {
        this.say('스크립트: 대화상자를 닫으면 이어서 실행합니다.');
        noted = true;
      }
      await h.wait(16);
    }
    // 오류 출력이 뒤늦게 올 수 있다
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }

  private async commandToken(tok: ScriptToken): Promise<void> {
    const h = this.host;
    const raw = tok.text.trim();
    if (!raw) {
      // 명령 프롬프트의 Enter = 직전 명령 반복
      if (this.lastCommand) {
        h.clearSelection();
        h.runCommand(this.lastCommand);
      }
      return;
    }
    if (raw.startsWith('(')) {
      this.fail('AutoLISP 식은 이 웹 버전에서 실행할 수 없습니다.');
      return;
    }
    const w = parseCommandWord(raw);
    if (!w) {
      this.fail(`알 수 없는 명령 "${raw}".`);
      return;
    }
    const canonical = h.findCommand(w.name);
    if (!canonical) {
      if (h.isVariable(w.name)) {
        h.clearSelection();
        this.lastCommand = null;
        h.runCommand('SETVAR', w.name);
        return;
      }
      this.fail(`알 수 없는 명령 "${w.name}".`);
      return;
    }
    const name = scriptCommandName(w.name, canonical, (n) => h.hasCommand(n));
    if (NEEDS_FLUSH.has(name.toUpperCase())) {
      await h.flush?.();
      if (this.status !== 'running') return;
    }
    h.clearSelection();
    this.lastCommand = name;
    h.runCommand(name);
  }

  /** 객체 하나 고르기 프롬프트: 좌표면 그 자리의 객체 */
  private entityToken(tok: ScriptToken): void {
    const h = this.host;
    const p = parseScriptPoint(tok.text, this.lastPoint);
    if (!p) {
      h.submit(stripKeywordPrefix(tok.text));
      return;
    }
    this.lastPoint = p;
    if (!h.pickEntity(p)) this.fail(`${tok.text.trim()}에 객체가 없습니다.`);
  }

  private selectToken(tok: ScriptToken): void {
    const h = this.host;
    const t = tok.text.trim();
    const c = this.corner;
    if (c) {
      const p = parseScriptPoint(t, this.lastPoint);
      if (!p) {
        this.fail('점이 올바르지 않습니다. 예: 100,50');
        return;
      }
      this.lastPoint = p;
      if (!c.first) {
        c.first = p;
        this.say(`첫 번째 구석 지정: ${t}`);
        return;
      }
      const crossing = c.mode === 'C' || ((c.mode === 'BOX' || c.mode === 'AUTO') && p.x < c.first.x);
      const n = h.selectWindow(c.first, p, crossing);
      this.corner = null;
      this.say(`반대 구석 지정: ${t}`);
      this.say(`${n}개를 찾음`);
      return;
    }
    if (!t) {
      h.submit('');
      return;
    }
    const up = stripKeywordPrefix(t).toUpperCase();
    if (up === 'W' || up === 'WINDOW' || up === 'C' || up === 'CROSSING' || up === 'BOX') {
      this.corner = { mode: up.startsWith('W') ? 'W' : up.startsWith('C') ? 'C' : 'BOX', first: null };
      return;
    }
    const p = parseScriptPoint(t, this.lastPoint);
    if (p) {
      this.lastPoint = p;
      const n = h.selectAt(p);
      if (n) this.say(`${n}개를 찾음`);
      else {
        // 그 자리에 객체가 없으면 그 점이 창의 첫 구석(AutoCAD의 암시적 창)
        this.corner = { mode: 'AUTO', first: p };
        this.say(`첫 번째 구석 지정: ${t}`);
      }
      return;
    }
    h.submit(stripKeywordPrefix(t));
  }
}
