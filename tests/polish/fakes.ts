/**
 * 진짜 App(src/app/app.ts)을 노드에서 만들기 위한 가짜 화면·명령행·엔진·글꼴. 시험 파일이 vi.mock으로 바꿔 끼운다:
 *   vi.mock('../../src/app/view', async (orig) => ({ ...(await orig()), CadView: (await import('./fakes')).FakeView }))
 * 이 모듈은 app.ts를 가져오지 않는다(바꿔 끼우는 동안 순환을 만들지 않는다).
 */
import type { EditOp } from '../../src/edit/session';

type Pt = { x: number; y: number };

export function overlayState() {
  return {
    cursor: null as Pt | null,
    crosshair: true,
    pickbox: 5,
    windowRect: null as unknown,
    selection: [] as unknown[],
    hover: null as unknown,
    grips: [] as Pt[],
    snap: null as unknown,
    rubber: [] as { pts: number[]; dashed?: boolean }[],
    ghost: [] as { segs: number[] }[],
    tracks: [] as unknown[],
    acquired: [] as Pt[],
    hotGrip: null as Pt | null,
    dynInput: null as string | null,
    marks: [] as unknown[],
    tip: null as string | null,
  };
}

/** CadView 대신: 화면 크기 800×600, 축척 1(1 도면 단위 = 1픽셀) */
export class FakeView {
  overlay = overlayState();
  events: Record<string, (...a: unknown[]) => void> = {};
  renderer = {};
  el = { title: '', addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  gridInfo: (() => unknown) | null = null;
  extraOverlay: unknown = null;
  onRestore: unknown = null;
  viewportModel: unknown = null;
  detail: unknown = null;
  overlayRequests = 0;
  width = 800;
  height = 600;
  constructor(_parent: unknown) {
    void _parent;
  }
  on(ev: Record<string, (...a: unknown[]) => void>): void {
    this.events = ev;
  }
  requestOverlay(): void {
    this.overlayRequests++;
  }
  requestRender(): void {}
  setState(): void {}
  pixelSize(): number {
    return 1;
  }
  camera() {
    return { cx: 0, cy: 0, scale: 1 };
  }
  visibleWorld(): [number, number, number, number] {
    return [-400, -300, 400, 300];
  }
  screenToWorld(x: number, y: number): Pt {
    return { x, y };
  }
  paperPoint(x: number, y: number): Pt {
    return { x, y };
  }
  zoomExtents(): void {}
  zoomRect(): void {}
}

/** CommandLine 대신: 출력·프롬프트를 모은다 */
export class FakeCommandLine {
  lines: { text: string; cls?: 'err' | 'res' }[] = [];
  prompt = '';
  acceptSpaces = false;
  onPrint: ((text: string, cls?: 'err' | 'res') => void) | null = null;
  onChange: ((t: string) => void) | null = null;
  input = { value: '' };
  el = { hidden: false };
  constructor(
    _parent: unknown,
    readonly host: { submit(t: string): void; cancel(): void },
  ) {
    void _parent;
  }
  print(text: string, cls?: 'err' | 'res'): void {
    this.onPrint?.(text, cls);
    this.lines.push({ text, cls });
  }
  setPrompt(text: string): void {
    this.prompt = text;
  }
  typeChar(): void {}
  toggleHistory(): void {}
}

/** EngineClient(워커) 대신: 편집을 모은다 */
export class FakeEngine {
  edits: { docId: number; ops: EditOp[] }[] = [];
  constructor(_fontBase: string) {
    void _fontBase;
  }
  edit(docId: number, ops: EditOp[]): void {
    this.edits.push({ docId, ops });
  }
  hide(): void {}
  closeDoc(): void {}
  async build(): Promise<never> {
    throw new Error('build');
  }
}

/** OutlineLibrary 대신 */
export class FakeFonts {
  constructor(_fontBase: string) {
    void _fontBase;
  }
  async require(): Promise<void> {}
  async requireLatin(): Promise<void> {}
}

/** 브라우저 전역(App 생성자가 쓰는 것만) */
export function browserGlobals(): { window: unknown; document: unknown } {
  return {
    window: {
      addEventListener() {},
      removeEventListener() {},
      setTimeout: (f: () => void, ms?: number) => setTimeout(f, ms),
      clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    },
    document: { baseURI: 'http://localhost/', title: '', querySelector: () => null },
  };
}
