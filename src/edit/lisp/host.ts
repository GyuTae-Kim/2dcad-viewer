/**
 * AutoLISP과 앱 사이의 연결(화면·DOM 없음). 앱(src/app/lisp*.ts)과 시험의 가짜 앱이 만든다.
 * 점은 모두 현재 UCS 좌표다(AutoLISP 관례). 도면 편집은 LispDrawing으로 문서·편집 세션을 직접 다룬다.
 */
import type { CadDocument } from '../../core/model';
import type { EditOp, EditSession } from '../session';
import type { Value } from './types';

export interface Pt2 {
  x: number;
  y: number;
}

/** 입력 요청 종류: point(점·글), entity(객체 하나) */
export type AskKind = 'point' | 'entity';

export interface AskOptions {
  /** 고무줄 기준점(UCS) */
  base?: Pt2 | null;
  /** 고무줄 모양 */
  rubber?: 'line' | 'rect' | null;
  /** 공백을 글자로 받는다(getstring의 cr) */
  spaces?: boolean;
  /** 숫자를 직접 거리 입력이 아니라 글로 받는다 */
  preferNumber?: boolean;
  /** 프롬프트 옆에 보여 줄 키워드(눌러서 고를 수 있다) */
  keywords?: { key: string; label: string }[];
}

export type AskResult =
  | { point: Pt2 }
  | { text: string }
  | { keyword: string }
  | { enter: true }
  | { entity: string; point: Pt2 };

/** 도면 하나 */
export interface LispDrawing {
  readonly doc: CadDocument;
  readonly session: EditSession;
  /** 지금 공간(블록 키) */
  readonly space: string;
  /** 새 객체의 기본 도면층(CLAYER) */
  currentLayer(): string;
  /** 편집 확정(명령 취소 한 번에 하나) */
  commit(ops: EditOp[], label: string): void;
}

/** 앱이 AutoLISP에 주는 기능 */
export interface LispHost {
  /** 경고 상자(alert) */
  alert(text: string): void;
  /** 사용자 입력. Esc는 CancelError 등으로 거절한다 */
  ask(kind: AskKind, prompt: string, opt: AskOptions): Promise<AskResult>;
  /** command·command-s·vl-cmdf: 인수를 명령행에 차례로 넣는다 */
  command(args: Value[], mode: 'command' | 'command-s' | 'vl-cmdf'): Promise<Value>;
  /** 시스템 변수 값(모르는 변수면 undefined) */
  getvar(name: string): Value | undefined;
  /** 시스템 변수 바꾸기. 거부하면 오류 글 */
  setvar(name: string, v: Value): string | null;
  /** 지금 도면(없으면 null) */
  drawing(): LispDrawing | null;
  /** 대화형 선택(객체 선택: 프롬프트). 하나만 고르기(single)면 첫 선택에서 끝 */
  select(prompt: string, single: boolean): Promise<string[]>;
  /** 창(crossing이면 걸침) 선택(UCS 두 점) */
  selectWindow(a: Pt2, b: Pt2, crossing: boolean): string[];
  /** 그 점(UCS)의 객체 */
  pickAt(p: Pt2): string | null;
  /** 지금 고른 객체(pickfirst) */
  implied(): string[];
  /** 고른 객체를 바꾼다(sssetfirst) */
  setImplied(handles: string[]): void;
  /** 직전 선택(P) */
  previous(): string[];
  setPrevious(handles: string[]): void;
  /** 마지막으로 만든 객체 */
  lastCreated(): string | null;
  /** 현재 UCS(2D: 원점과 X축 각도) */
  ucs(): { ox: number; oy: number; angle: number };
  /** (defun c:이름 …): 명령 등록 */
  defineCommand(name: string): void;
  /** (load "이름"): 이 세션에 연 .lsp 파일. 없으면 null */
  findFile(name: string): Promise<{ name: string; text: string } | null>;
}
