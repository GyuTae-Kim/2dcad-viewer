/** DWG 버전 번호(파일 첫 6바이트 "AC10xx"의 숫자 부분) */
export const R13 = 1012;
export const R14 = 1014;
export const R2000 = 1015;
export const R2004 = 1018;
export const R2007 = 1021;
export const R2010 = 1024;
export const R2013 = 1027;
export const R2018 = 1032;

export const SUPPORTED_VERSIONS = [R13, R14, R2000, R2004, R2007, R2010, R2013, R2018];

/** "AC1015" → 1015. DWG가 아니면 0 */
export function versionNumber(magic: string): number {
  const m = /^AC(\d{4})$/.exec(magic);
  return m ? Number(m[1]) : 0;
}
