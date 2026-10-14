/** 파일을 읽지 못했을 때의 오류. code는 화면 문구와 테스트가 함께 쓴다. */
export type CadErrorCode =
  | 'file.empty'
  | 'file.unrecognized'
  | 'file.too_large'
  | 'dxf.invalid'
  | 'dwg.unsupported_version'
  | 'dwg.corrupt'
  | 'dwg.encrypted';

const MESSAGES: Record<CadErrorCode, string> = {
  'file.empty': '빈 파일입니다.',
  'file.unrecognized': 'DXF나 DWG 파일이 아닙니다.',
  'file.too_large': '파일이 너무 커서 열 수 없습니다.',
  'dxf.invalid': 'DXF 구조를 읽을 수 없습니다. 파일이 손상되었을 수 있습니다.',
  'dwg.unsupported_version': '아직 지원하지 않는 DWG 버전입니다.',
  'dwg.corrupt': 'DWG 파일을 읽는 중 손상된 부분을 만났습니다.',
  'dwg.encrypted': '암호가 걸린 DWG 파일은 열 수 없습니다.',
};

export class CadReadError extends Error {
  readonly code: CadErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: CadErrorCode, detail?: Record<string, unknown>, message?: string) {
    super(message ?? MESSAGES[code]);
    this.name = 'CadReadError';
    this.code = code;
    this.detail = detail;
  }
}

export function errorMessage(code: CadErrorCode): string {
  return MESSAGES[code];
}
