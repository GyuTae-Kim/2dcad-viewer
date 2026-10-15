import { describe, expect, it } from 'vitest';
import { pureLisp } from './pure';

describe('파일 정보(이번 세션에 연 파일만)', () => {
  it('findfile·vl-file-size·vl-file-systime·vl-file-directory-p', async () => {
    const L = pureLisp();
    L.files.set('data.csv', { name: 'data.csv', text: 'a,b\n1,2\n' });
    L.files.set('tools.lsp', { name: 'tools.lsp', text: '(princ)' });
    expect(await L.ev('(findfile "data.csv")')).toBe('"data.csv"');
    expect(await L.ev('(findfile "C:\\\\work\\\\없음.csv")')).toBe('nil');
    // .lsp는 확장자 없이도(load와 같다)
    expect(await L.ev('(findfile "tools")')).toBe('"tools.lsp"');
    expect(await L.ev('(vl-file-size "data.csv")')).toBe('8');
    expect(await L.ev('(vl-file-size "없음")')).toBe('nil');
    const t = new Date(Date.UTC(2026, 9, 15, 3, 4, 5));
    expect(await L.ev('(vl-file-systime "data.csv")')).toBe(`(${t.getFullYear()} ${t.getMonth() + 1} ${t.getDay()} ${t.getDate()} ${t.getHours()} ${t.getMinutes()} ${t.getSeconds()} 0)`);
    expect(await L.ev('(vl-file-directory-p "data.csv")')).toBe('nil');
  });

  it('open "r"·read-line·read-char·close(쓰기 모드는 웹 안내)', async () => {
    const L = pureLisp();
    L.files.set('data.csv', { name: 'data.csv', text: 'a,b\r\n1,2\n' });
    expect(await L.ev('(setq f (open "data.csv" "r"))')).toBe('#<file "data.csv">');
    expect(await L.ev('(type f)')).toBe('FILE');
    expect(await L.ev('(list (read-char f) (read-line f) (read-line f) (read-line f))')).toBe('(97 ",b" "1,2" nil)');
    expect(await L.ev('(close f)')).toBe('nil');
    expect(await L.ev('(read-line f)')).toBe('ERR:잘못된 인수 유형: streamp: #<file "data.csv">');
    expect(await L.ev('(open "없음.txt" "r")')).toBe('nil');
    expect(await L.ev('(open "out.txt" "w")')).toBe('ERR:OPEN: 파일 쓰기(w)는 이 웹 버전에서는 쓸 수 없습니다');
    expect(await L.ev('(princ "x" (open "data.csv" "r"))')).toBe('ERR:파일 쓰기: 이 웹 버전에서는 쓸 수 없습니다');
  });

  it('쓰기·복사는 웹 안내, acet-str-*는 함수 정의 없음', async () => {
    const L = pureLisp();
    expect(await L.ev('(vl-file-copy "a" "b")')).toBe('ERR:VL-FILE-COPY: 이 웹 버전에서는 쓸 수 없습니다');
    expect(await L.ev('(vl-file-delete "a")')).toBe('ERR:VL-FILE-DELETE: 이 웹 버전에서는 쓸 수 없습니다');
    expect(await L.ev('(acet-str-replace "a" "b" "abc")')).toBe('ERR:함수 정의 없음: ACET-STR-REPLACE');
  });
});

describe('osnap·grvecs', () => {
  it('osnap: 모드 글(국제 접두어·여럿), none은 그 점, 모르는 모드는 nil', async () => {
    const L = pureLisp();
    expect(await L.ev("(osnap '(1.2 3.7) \"_end,_mid\")")).toBe('(1.0 4.0 0.0)');
    expect(await L.ev("(osnap '(1.2 3.7 5.0) \"endp\")")).toBe('(1.0 4.0 5.0)');
    expect(await L.ev("(osnap '(1.2 3.7) \"mid\")")).toBe('nil');
    expect(await L.ev("(osnap '(1.2 3.7) \"none\")")).toBe('(1.2 3.7 0.0)');
    expect(await L.ev("(osnap '(1.2 3.7) \"xyz\")")).toBe('nil');
  });

  it('grvecs: 색이 다음 벡터에 적용되고, 변환 행렬을 곱한다', async () => {
    const L = pureLisp();
    await L.ev("(grvecs '(1 (0 0) (1 0) 256 (0 0) (0 1)) '((2 0 0 10) (0 2 0 20) (0 0 1 0) (0 0 0 1)))");
    expect(L.grdrawn.map((v) => [v.a.x, v.a.y, v.b.x, v.b.y, v.color])).toEqual([
      [10, 20, 12, 20, 1],
      [10, 20, 10, 22, -1],
    ]);
    await L.ev("(grdraw '(0 0) '(1 1) -1 1)");
    expect(L.grdrawn[2]).toMatchObject({ color: -1, highlight: true });
    await L.ev('(redraw)');
    expect(L.grdrawn).toHaveLength(0);
  });
});

describe('textbox(배치 엔진 없음: 어림)', () => {
  it('글자 수·높이·폭 비율로 어림한다', async () => {
    const L = pureLisp();
    expect(await L.ev("(textbox '((1 . \"AB\") (40 . 1.0)))")).toBe('((0.0 0.0 0.0) (1.7 1.0 0.0))');
  });
});
