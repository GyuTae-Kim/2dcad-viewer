import { describe, expect, it } from 'vitest';
import { pureLisp } from './pure';

const ev = async (s: string) => pureLisp().ev(s);

describe('특수 형식', () => {
  it('setq·quote·progn·if·cond', async () => {
    expect(await ev('(setq a 1 b (+ a 2)) b')).toBe('3');
    expect(await ev("'(a b)")).toBe('(A B)');
    expect(await ev("(quote x)")).toBe('X');
    expect(await ev('(progn 1 2 3)')).toBe('3');
    expect(await ev('(if nil 1 2)')).toBe('2');
    expect(await ev('(if T 1)')).toBe('1');
    expect(await ev('(if nil 1)')).toBe('nil');
    expect(await ev('(cond ((= 1 2) "a") ((= 1 1) "b" "c") (T "d"))')).toBe('"c"');
    expect(await ev('(cond ((+ 1 2)))')).toBe('3');
    expect(await ev('(cond (nil 1))')).toBe('nil');
  });

  it('while·repeat·foreach(변수는 끝나면 되돌린다)', async () => {
    expect(await ev('(setq i 0 s 0) (while (< i 5) (setq s (+ s i) i (1+ i))) s')).toBe('10');
    expect(await ev('(setq n 0) (repeat 4 (setq n (+ n 2)))')).toBe('8');
    expect(await ev("(setq x 'old s 0) (foreach x '(1 2 3) (setq s (+ s x))) (list s x)")).toBe('(6 OLD)');
  });

  it('and·or·not', async () => {
    expect(await ev('(and 1 2 nil)')).toBe('nil');
    expect(await ev('(and 1 2)')).toBe('T');
    expect(await ev('(and)')).toBe('T');
    expect(await ev('(or nil 3)')).toBe('T');
    expect(await ev('(or)')).toBe('nil');
    expect(await ev('(not nil)')).toBe('T');
    expect(await ev('(null 0)')).toBe('nil');
  });

  it('defun: 인수·지역 변수(/)는 동적 범위로 묶고 되돌린다', async () => {
    const L = pureLisp();
    expect(await L.ev('(defun sq (x) (* x x))')).toBe('SQ');
    expect(await L.ev('(sq 7)')).toBe('49');
    expect(await L.ev('(setq v 1) (defun f (/ v) (setq v 99) (g)) (defun g () v) (list (f) v)')).toBe('(99 1)');
    expect(await L.ev('(defun h (a b / c) (setq c (+ a b)) c) (h 2 3)')).toBe('5');
    expect(await L.ev('c')).toBe('nil');
    expect(await L.ev('(h 1)')).toBe('ERR:인수가 너무 적음');
    expect(await L.ev('(h 1 2 3)')).toBe('ERR:인수가 너무 많음');
    expect(await L.ev('(type sq)')).toBe('USUBR');
    expect(await L.ev('(type car)')).toBe('SUBR');
  });

  it('lambda·function·apply·mapcar·eval', async () => {
    expect(await ev("(mapcar '1+ '(1 2 3))")).toBe('(2 3 4)');
    expect(await ev("(mapcar '+ '(1 2 3) '(10 20))")).toBe('(11 22)');
    expect(await ev("(mapcar '(lambda (x) (* x 10)) '(1 2))")).toBe('(10 20)');
    expect(await ev('(mapcar (function (lambda (x) (strcat x "!"))) \'("a" "b"))')).toBe('("a!" "b!")');
    expect(await ev("(apply '+ '(1 2 3))")).toBe('6');
    expect(await ev("(apply (lambda (a b) (- a b)) '(10 4))")).toBe('6');
    expect(await ev("((lambda (x) (+ x 1)) 5)")).toBe('6');
    expect(await ev("(eval '(+ 1 2))")).toBe('3');
    expect(await ev("(setq f '(lambda (x) (* 2 x))) (f 21)")).toBe('42');
  });

  it('깊은 재귀: 꼬리 재귀는 스택이 자라지 않고, 아닌 재귀도 JS 스택이 터지지 않는다', async () => {
    const L = pureLisp();
    expect(await L.ev('(defun loop (n acc) (if (= n 0) acc (loop (1- n) (+ acc 1)))) (loop 300000 0)')).toBe('300000');
    expect(await L.ev('(defun cnt (n) (if (= n 0) 0 (1+ (cnt (1- n))))) (cnt 20000)')).toBe('20000');
    L.it.maxStack = 1000;
    expect(await L.ev('(cnt 5000)')).toBe('ERR:하드 오류 발생 *** 내부 스택 한계 도달(시뮬레이션)');
  });

  it('끝없는 반복은 반복 한도에서 멈춘다', async () => {
    const L = pureLisp();
    L.it.maxSteps = 50_000;
    expect(await L.ev('(while T)')).toMatch(/^ERR:반복 한도/);
    // 한도 뒤에도 다시 평가할 수 있다
    expect(await L.ev('(+ 1 1)')).toBe('2');
  });

  it('Esc(cancel)로 멈추면 함수 취소됨', async () => {
    const L = pureLisp();
    L.it.sliceMs = 0;
    L.it.opts.pause = async () => {
      L.it.cancel();
    };
    expect(await L.ev('(while T (setq a 1))')).toBe('ERR:함수 취소됨');
  });
});

describe('산술·비교', () => {
  it('정수와 실수', async () => {
    expect(await ev('(+ 1 2)')).toBe('3');
    expect(await ev('(+ 1 2.0)')).toBe('3.0');
    expect(await ev('(- 10 1 2)')).toBe('7');
    expect(await ev('(- 5)')).toBe('-5');
    expect(await ev('(* 2 3.5)')).toBe('7.0');
    expect(await ev('(/ 7 2)')).toBe('3');
    expect(await ev('(/ -7 2)')).toBe('-3');
    expect(await ev('(/ 7 2.0)')).toBe('3.5');
    expect(await ev('(/ 1 0)')).toBe('ERR:0으로 나누기');
    expect(await ev('(+ 2147483647 1)')).toBe('-2147483648');
    expect(await ev('(rem 7 3)')).toBe('1');
    expect(await ev('(rem -7 3)')).toBe('-1');
    expect(await ev('(rem 7.5 2)')).toBe('1.5');
    expect(await ev('(1+ 1.5)')).toBe('2.5');
    expect(await ev('(abs -3)')).toBe('3');
    expect(await ev('(min 3 1 2)')).toBe('1');
    expect(await ev('(max 3 1.0 2)')).toBe('3.0');
    expect(await ev('(fix 3.7)')).toBe('3');
    expect(await ev('(fix -3.7)')).toBe('-3');
    expect(await ev('(float 3)')).toBe('3.0');
    expect(await ev('(sqrt 16)')).toBe('4.0');
    expect(await ev('(sqrt -1)')).toBe('ERR:인수에 대한 함수가 정의되지 않음: -1');
    expect(await ev('(expt 2 10)')).toBe('1024');
    expect(await ev('(expt 2.0 0.5)')).toBe('1.41421');
    expect(await ev('(exp 1)')).toBe('2.71828');
    expect(await ev('(log 1)')).toBe('0.0');
    expect(await ev('(sin 0)')).toBe('0.0');
    expect(await ev('(cos 0)')).toBe('1.0');
    expect(await ev('(atan 1)')).toBe('0.785398');
    expect(await ev('(atan 1 -1)')).toBe('2.35619');
    expect(await ev('(gcd 12 18)')).toBe('6');
    expect(await ev('pi')).toBe('3.14159');
    expect(await ev('(logand 7 3)')).toBe('3');
    expect(await ev('(logior 4 1)')).toBe('5');
    expect(await ev('(lsh 1 4)')).toBe('16');
    expect(await ev('(~ 0)')).toBe('-1');
  });

  it('잘못된 인수 유형', async () => {
    expect(await ev('(+ 1 "a")')).toBe('ERR:잘못된 인수 유형: numberp: "a"');
    expect(await ev('(gcd 1.5 2)')).toBe('ERR:잘못된 인수 유형: fixnump: 1.5');
    expect(await ev('(car 1)')).toBe('ERR:잘못된 인수 유형: consp: 1');
    expect(await ev('(strcat "a" 1)')).toBe('ERR:잘못된 인수 유형: stringp: 1');
    expect(await ev('(foo 1)')).toBe('ERR:함수 정의 없음: FOO');
    expect(await ev('(1 2)')).toBe('ERR:잘못된 함수: 1');
    expect(await ev('(vla-get-name x)')).toBe('ERR:VLA-GET-NAME: 이 웹 버전에서는 쓸 수 없습니다');
    expect(await ev('(startapp "notepad")')).toBe('ERR:STARTAPP: 이 웹 버전에서는 쓸 수 없습니다');
    expect(await ev('(open "a.txt" "w")')).toBe('ERR:OPEN: 파일 쓰기(w)는 이 웹 버전에서는 쓸 수 없습니다');
  });

  it('비교·같음·술어', async () => {
    expect(await ev('(= 1 1.0)')).toBe('T');
    expect(await ev('(= "a" "a")')).toBe('T');
    expect(await ev('(= 1 2)')).toBe('nil');
    expect(await ev('(/= 1 2)')).toBe('T');
    expect(await ev('(< 1 2 3)')).toBe('T');
    expect(await ev('(< 1 3 2)')).toBe('nil');
    expect(await ev('(>= 3 3 1)')).toBe('T');
    expect(await ev('(< "a" "b")')).toBe('T');
    expect(await ev("(eq 'a 'a)")).toBe('T');
    expect(await ev("(eq '(1) '(1))")).toBe('nil');
    expect(await ev("(equal '(1 (2 \"x\")) '(1 (2 \"x\")))")).toBe('T');
    expect(await ev("(equal 1.0 1.0001 0.001)")).toBe('T');
    expect(await ev("(equal '(1.0 2.0) '(1.0 2.1) 0.01)")).toBe('nil');
    expect(await ev('(minusp -1)')).toBe('T');
    expect(await ev('(zerop 0.0)')).toBe('T');
    expect(await ev('(numberp "1")')).toBe('nil');
    expect(await ev("(atom '(1))")).toBe('nil');
    expect(await ev('(atom nil)')).toBe('T');
    expect(await ev('(listp nil)')).toBe('T');
    expect(await ev("(boundp 'zz)")).toBe('nil');
    expect(await ev("(setq zz 1) (boundp 'zz)")).toBe('T');
    expect(await ev('(type 1)')).toBe('INT');
    expect(await ev('(type 1.0)')).toBe('REAL');
    expect(await ev('(type "s")')).toBe('STR');
    expect(await ev("(type 'a)")).toBe('SYM');
    expect(await ev("(type '(1))")).toBe('LIST');
    expect(await ev('(type nil)')).toBe('nil');
  });
});

describe('목록', () => {
  it('만들기·꺼내기', async () => {
    expect(await ev('(list 1 "a" (list 2))')).toBe('(1 "a" (2))');
    expect(await ev('(cons 1 2)')).toBe('(1 . 2)');
    expect(await ev("(cons 1 '(2))")).toBe('(1 2)');
    expect(await ev("(car '(1 2))")).toBe('1');
    expect(await ev("(cdr '(1 2))")).toBe('(2)');
    expect(await ev("(cadr '(1 2 3))")).toBe('2');
    expect(await ev("(caddr '(1 2 3))")).toBe('3');
    expect(await ev("(caar '((1) 2))")).toBe('1');
    expect(await ev("(cdar '((1 5) 2))")).toBe('(5)');
    expect(await ev("(cadddr '(1 2 3 4))")).toBe('4');
    expect(await ev('(car nil)')).toBe('nil');
    expect(await ev("(nth 1 '(a b c))")).toBe('B');
    expect(await ev("(nth 5 '(a b c))")).toBe('nil');
    expect(await ev("(last '(a b c))")).toBe('C');
    expect(await ev("(length '(a b c))")).toBe('3');
    expect(await ev("(reverse '(1 2 3))")).toBe('(3 2 1)');
    expect(await ev("(append '(1) '(2 3) nil '(4))")).toBe('(1 2 3 4)');
  });

  it('찾기·바꾸기·정렬', async () => {
    expect(await ev("(member 2 '(1 2 3))")).toBe('(2 3)');
    expect(await ev("(member \"x\" '(\"a\" \"x\"))")).toBe('("x")');
    expect(await ev("(assoc 8 '((0 . \"LINE\") (8 . \"벽\")))")).toBe('(8 . "벽")');
    expect(await ev("(assoc 9 '((0 . \"LINE\")))")).toBe('nil');
    expect(await ev("(subst 'qq 'b '(a b (c b) b))")).toBe('(A QQ (C B) QQ)');
    expect(await ev("(vl-remove 2 '(1 2 3 2))")).toBe('(1 3)');
    expect(await ev("(vl-sort '(3 1 2) '<)")).toBe('(1 2 3)');
    expect(await ev("(vl-sort '(\"b\" \"a\") (function (lambda (a b) (< a b))))")).toBe('("a" "b")');
    expect(await ev("(vl-sort-i '(30 10 20) '<)")).toBe('(1 2 0)');
    expect(await ev("(vl-position 'c '(a b c))")).toBe('2');
    expect(await ev("(vl-remove-if 'minusp '(1 -2 3))")).toBe('(1 3)');
    expect(await ev("(vl-remove-if-not 'minusp '(1 -2 3))")).toBe('(-2)');
    expect(await ev("(vl-member-if 'minusp '(1 -2 3))")).toBe('(-2 3)');
    expect(await ev("(vl-some 'minusp '(1 -2 3))")).toBe('T');
    expect(await ev("(vl-every 'numberp '(1 2))")).toBe('T');
    expect(await ev("(acad_strlsort '(\"c\" \"a\" \"b\"))")).toBe('("a" "b" "c")');
  });
});

describe('문자열', () => {
  it('기본', async () => {
    expect(await ev('(strcat "a" "b" "c")')).toBe('"abc"');
    expect(await ev('(strlen "도면층")')).toBe('3');
    expect(await ev('(substr "abcdef" 2 3)')).toBe('"bcd"');
    expect(await ev('(substr "abcdef" 4)')).toBe('"def"');
    expect(await ev('(strcase "abc")')).toBe('"ABC"');
    expect(await ev('(strcase "ABC" T)')).toBe('"abc"');
    expect(await ev('(atoi "42x")')).toBe('42');
    expect(await ev('(atoi "x")')).toBe('0');
    expect(await ev('(atof "2.5")')).toBe('2.5');
    expect(await ev('(itoa 15)')).toBe('"15"');
    expect(await ev('(ascii "A")')).toBe('65');
    expect(await ev('(chr 66)')).toBe('"B"');
    expect(await ev('(vl-string-subst "X" "b" "abcb")')).toBe('"aXcb"');
    expect(await ev('(vl-string-search "c" "abcb")')).toBe('2');
    expect(await ev('(vl-string-search "z" "abcb")')).toBe('nil');
    expect(await ev('(vl-string-trim " " "  a b  ")')).toBe('"a b"');
    expect(await ev('(vl-princ-to-string \'(1 "a"))')).toBe('"(1 a)"');
    expect(await ev('(vl-prin1-to-string "a")')).toBe('"\\"a\\""');
    expect(await ev('(read "(1 b)")')).toBe('(1 B)');
    expect(await ev('(vl-symbol-name \'abc)')).toBe('"ABC"');
    expect(await ev('(vl-string->list "AB")')).toBe('(65 66)');
    expect(await ev("(vl-list->string '(72 105))")).toBe('"Hi"');
  });

  it('wcmatch', async () => {
    expect(await ev('(wcmatch "Name" "N*")')).toBe('T');
    expect(await ev('(wcmatch "Name" "n*")')).toBe('nil');
    expect(await ev('(wcmatch "A12" "@##")')).toBe('T');
    expect(await ev('(wcmatch "Wall" "Door,W*")')).toBe('T');
    expect(await ev('(wcmatch "Wall" "~W*")')).toBe('nil');
    expect(await ev('(wcmatch "B" "[ABC]")')).toBe('T');
    expect(await ev('(wcmatch "D" "[~ABC]")')).toBe('T');
    expect(await ev('(wcmatch "a*b" "a`*b")')).toBe('T');
  });

  it('rtos·angtos·distof·angtof(도면 단위와 DIMZIN)', async () => {
    const L = pureLisp();
    expect(await L.ev('(rtos 17.5)')).toBe('"17.5000"');
    expect(await L.ev('(rtos 17.5 2 2)')).toBe('"17.50"');
    expect(await L.ev('(rtos 17.5 1 4)')).toBe('"1.7500E+01"');
    expect(await L.ev('(rtos 17.5 4 2)')).toBe('"1\'-5 1/2\\""');
    expect(await L.ev('(rtos 17.5 5 2)')).toBe('"17 1/2"');
    L.vars.set('DIMZIN', 8);
    expect(await L.ev('(rtos 17.5 2 4)')).toBe('"17.5"');
    expect(await L.ev('(rtos 3.0 2 4)')).toBe('"3"');
    L.vars.set('DIMZIN', 0);
    expect(await L.ev('(angtos (/ pi 4) 0 4)')).toBe('"45.0000"');
    expect(await L.ev('(angtos (/ pi -4) 0 0)')).toBe('"315"');
    expect(await L.ev('(angtos (/ pi 4) 1 4)')).toBe('"45d0\'0\\""');
    expect(await L.ev('(angtos (/ pi 2) 2 0)')).toBe('"100g"');
    expect(await L.ev('(angtos 1 3 2)')).toBe('"1.00r"');
    expect(await L.ev('(distof "12.5")')).toBe('12.5');
    expect(await L.ev('(distof "1\'-6\\"")')).toBe('18.0');
    expect(await L.ev('(distof "abc")')).toBe('nil');
    expect(await L.ev('(angtof "90")')).toBe('1.5708');
    expect(await L.ev('(angtof "100g" 2)')).toBe('1.5708');
    expect(await L.ev('(angtof "N 45d E" 4)')).toBe('0.785398');
  });
});

describe('기하', () => {
  it('polar·distance·angle·inters', async () => {
    expect(await ev("(polar '(1 1) 0 5)")).toBe('(6.0 1.0)');
    expect(await ev("(polar '(0 0 3) (/ pi 2) 2)")).toBe('(1.22465e-16 2.0 3.0)');
    expect(await ev("(distance '(0 0) '(3 4))")).toBe('5.0');
    expect(await ev("(angle '(0 0) '(0 -1))")).toBe('4.71239');
    expect(await ev("(inters '(0 0) '(10 10) '(0 10) '(10 0))")).toBe('(5.0 5.0)');
    expect(await ev("(inters '(0 0) '(1 1) '(0 10) '(10 0))")).toBe('nil');
    expect(await ev("(inters '(0 0) '(1 1) '(0 10) '(10 0) nil)")).toBe('(5.0 5.0)');
    expect(await ev("(inters '(0 0) '(1 0) '(0 1) '(1 1))")).toBe('nil');
    expect(await ev("(distance '(0 0) \"a\")")).toBe('ERR:잘못된 인수 유형: 2D/3D 점: "a"');
  });
});

describe('출력·오류 처리', () => {
  it('princ·prin1·print·prompt·terpri는 명령행에 줄 단위로', async () => {
    const L = pureLisp();
    await L.ev('(princ "가") (princ 1) (terpri) (prin1 "b") (print \'c) (prompt "\\n끝") (princ)');
    L.it.flush();
    expect(L.printed).toEqual(['가1', '"b"', 'C ', '끝']);
  });

  it('오류는 "; 오류: …"로 알리고 *error*가 있으면 대신 부른다(지역 변수가 살아 있을 때)', async () => {
    const L = pureLisp();
    const r = await L.it.evalText('(+ 1 "a")');
    expect(r.ok).toBe(false);
    expect(L.printed).toContain('err:; 오류: 잘못된 인수 유형: numberp: "a"');
    L.printed.length = 0;
    await L.it.evalText('(defun c:t1 (/ *error* old) (setq old 5) (defun *error* (msg) (princ (strcat "잡음:" msg " old=" (itoa old)))) (car 1)) (c:t1)');
    L.it.flush();
    expect(L.printed).toEqual(['잡음:잘못된 인수 유형: consp: 1 old=5']);
    // *error* 지역 변수는 되돌아갔다
    expect(await L.ev('*error*')).toBe('nil');
    expect(L.defined).toEqual(['T1']);
  });

  it('vl-catch-all-apply는 오류를 값으로 잡는다', async () => {
    const L = pureLisp();
    expect(await L.ev("(setq r (vl-catch-all-apply '/ '(1 0))) (vl-catch-all-error-p r)")).toBe('T');
    expect(await L.ev('(vl-catch-all-error-message r)')).toBe('"0으로 나누기"');
    expect(await L.ev("(vl-catch-all-apply '+ '(1 2))")).toBe('3');
    expect(await L.ev('(defun bad (/ q) (setq q 1) (car q)) (setq q 7) (vl-catch-all-apply \'bad nil) q')).toBe('7');
  });

  it('exit는 종료 / 나가기 중단', async () => {
    expect(await ev('(exit)')).toBe('ERR:종료 / 나가기 중단');
  });
});

describe('입력(가짜 연결)', () => {
  it('getpoint·getint·getreal·getstring·getkword·initget', async () => {
    const L = pureLisp();
    L.inputs.push({ point: { x: 10, y: 20 } });
    expect(await L.ev('(getpoint "\\n점 지정: ")')).toBe('(10.0 20.0 0.0)');
    expect(L.prompts.pop()).toBe('점 지정:');
    L.inputs.push({ text: 'x' }, { text: '7' });
    expect(await L.ev('(getint "수:")')).toBe('7');
    L.inputs.push({ text: '2.5' });
    expect(await L.ev('(getreal)')).toBe('2.5');
    L.inputs.push({ text: 'hello' });
    expect(await L.ev('(getstring "이름:")')).toBe('"hello"');
    L.inputs.push({ enter: true });
    expect(await L.ev('(getstring)')).toBe('""');
    L.inputs.push({ text: 'n' });
    expect(await L.ev('(initget "Yes No") (getkword "[Yes/No]:")')).toBe('"No"');
    L.inputs.push({ text: 'Q' }, { text: 'ye' });
    expect(await L.ev('(initget 1 "Yes No") (getkword)')).toBe('"Yes"');
    L.inputs.push({ enter: true }, { text: '0' }, { text: '-3' }, { text: '4' });
    expect(await L.ev('(initget 7) (getint)')).toBe('4');
    L.inputs.push({ text: '45' });
    expect(await L.ev('(getangle "각도:")')).toBe('0.785398');
    L.inputs.push({ point: { x: 3, y: 4 } });
    expect(await L.ev("(getdist '(0 0) \"거리:\")")).toBe('5.0');
    L.inputs.push({ text: 'L' });
    expect(await L.ev('(initget "Last _Last") (getpoint)')).toBe('"Last"');
    // prompt로 찍어 둔 줄이 다음 get*의 프롬프트가 된다
    L.inputs.push({ point: { x: 0, y: 0 } });
    await L.ev('(prompt "\\n기준점: ") (getpoint)');
    expect(L.prompts.pop()).toBe('기준점:');
  });

  it('입력 중 Esc는 함수 취소됨', async () => {
    const L = pureLisp();
    expect(await L.ev('(getpoint)')).toBe('ERR:함수 취소됨');
  });

  it('getvar·setvar', async () => {
    const L = pureLisp();
    expect(await L.ev('(getvar "luprec")')).toBe('4');
    expect(await L.ev('(setvar "LUPREC" 2)')).toBe('2');
    expect(await L.ev('(getvar "nosuch")')).toBe('nil');
    expect(await L.ev('(setvar "NOSUCH" 1)')).toBe('ERR:AutoCAD 변수 설정 거부: "NOSUCH" 1');
  });

  it('load: 이 세션에 연 파일을 이름으로', async () => {
    const L = pureLisp();
    L.files.set('util.lsp', { name: 'util.lsp', text: '(defun dbl (x) (* 2 x))\n(setq loaded "yes")' });
    expect(await L.ev('(load "util")')).toBe('"yes"');
    expect(await L.ev('(dbl 4)')).toBe('8');
    expect(await L.ev('(load "none")')).toBe('ERR:LOAD 실패: "none"');
    expect(await L.ev('(load "none" "없음")')).toBe('"없음"');
  });
});
