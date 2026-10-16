import { describe, expect, it } from 'vitest';
import type { CadDocument, Entity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { registerDrawCommands } from '../../src/app/draw';
import { registerDashCommands } from '../../src/app/dashcmds';
import { registerTableCommands } from '../../src/app/tables';
import { lispSession } from '../../src/app/lisp';
import { makeLispApp, type LispApp } from './app';
import { lwVertices } from '../../src/core/lwpoly';

function setup(extra?: (doc: CadDocument) => void): LispApp {
  const h = makeLispApp(extra);
  registerDrawCommands(h.app);
  registerTableCommands(h.app);
  registerDashCommands(h.app);
  return h;
}

const line = (x0: number, y0: number, x1: number, y1: number, layer = '0') => ({ ...entityDefaults(), layer, type: 'LINE', handle: '', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } }) as Entity;
const last = (h: LispApp) => h.printed[h.printed.length - 1]?.text;

describe('명령행 AutoLISP', () => {
  it('식을 평가해 결과를 찍고, !변수는 값을 찍는다', async () => {
    const h = setup();
    await h.lisp('(setq a (* 6 7))');
    expect(h.out()).toContain('명령: (setq a (* 6 7))');
    expect(last(h)).toBe('42');
    await h.lisp('!a');
    expect(last(h)).toBe('42');
    await h.lisp('(princ "안녕")');
    expect(last(h)).toBe('안녕"안녕"');
    await h.lisp('(princ)');
    expect(last(h)).toBe('명령: (princ)');
  });

  it('닫히지 않은 식은 (_> 프롬프트로 이어 받는다', async () => {
    const h = setup();
    h.type('(setq b (+ 1');
    expect(h.app.cmd.lispContinue).toBe(true);
    expect((h.app.cmd as unknown as { prompt: string }).prompt).toBe('(_>');
    await h.lisp('2))');
    expect(h.app.cmd.lispContinue).toBe(false);
    expect(last(h)).toBe('3');
  });

  it('오류는 "; 오류: …"(err)로 알리고 그 식만 멈춘다', async () => {
    const h = setup();
    await h.lisp('(+ 1 "a")');
    expect(h.errors()).toEqual(['; 오류: 잘못된 인수 유형: numberp: "a"']);
    await h.lisp('(+ 1 2)');
    expect(last(h)).toBe('3');
  });

  it('command로 선·원을 만들고, 최상위 평가 하나는 명령 취소 한 번', async () => {
    const h = setup();
    const depth0 = h.st.session.depth;
    await h.lisp('(progn (command "LINE" \'(0 0) \'(100 0) "") (command "_.CIRCLE" (list 50 50) 10))');
    expect(h.errors()).toEqual([]);
    const ln = h.model('LINE');
    expect(ln).toHaveLength(1);
    expect(ln[0]).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 100, y: 0 } });
    expect(h.model('CIRCLE')[0]).toMatchObject({ radius: 10, center: { x: 50, y: 50 } });
    expect(h.st.session.depth).toBe(depth0 + 1);
    h.st.session.undo();
    expect(h.model('LINE')).toHaveLength(0);
    expect(h.model('CIRCLE')).toHaveLength(0);
  });

  it('명령이 기다리는 프롬프트에서 (…)의 값이 입력이 된다', async () => {
    const h = setup();
    h.type('LINE');
    expect(h.pending()?.kind).toBe('point');
    await h.lisp('(list 5 5)');
    await h.lisp('(polar (list 5 5) 0 10)');
    h.type('');
    await h.idle();
    expect(h.model('LINE')[0]).toMatchObject({ start: { x: 5, y: 5 }, end: { x: 15, y: 5 } });
  });

  it('명령 프롬프트에서 평가한 get*은 그 명령의 프롬프트를 잠시 비켰다가 되돌린다', async () => {
    const h = setup();
    h.type('LINE');
    h.type('(getpoint "기준:")');
    await h.idle();
    expect(h.pending()?.prompt).toBe('기준:');
    h.type('1,2');
    await h.idle();
    expect(h.pending()?.prompt).toBe('다음 점 지정 또는 [명령 취소(U)]:');
    h.type('(command "CIRCLE")');
    await h.idle();
    expect(h.errors()).toEqual(['; 오류: 다른 명령의 프롬프트에서 평가한 AutoLISP 식에서는 command를 쓸 수 없습니다']);
    h.type('4,2');
    h.type('');
    await h.idle();
    expect(h.model('LINE')[0]).toMatchObject({ start: { x: 1, y: 2 }, end: { x: 4, y: 2 } });
  });

  it('getpoint는 명령행 프롬프트로 입력을 받고, Esc는 함수 취소됨', async () => {
    const h = setup();
    h.type('(setq p (getpoint "\\n점 지정: "))');
    await h.idle();
    expect(h.pending()).toMatchObject({ kind: 'point', prompt: '점 지정:' });
    h.type('3,4');
    await h.idle();
    expect(last(h)).toBe('(3.0 4.0 0.0)');
    h.type('(getdist (list 0 0) "거리: ")');
    await h.idle();
    h.app.cancel();
    await h.idle();
    expect(h.errors()).toEqual(['; 오류: 함수 취소됨']);
    expect(h.pending()).toBeNull();
  });

  it('(defun c:이름)은 명령이 되고, 같은 이름의 명령이 있으면 알린다', async () => {
    const h = setup();
    await h.lisp('(defun c:sq () (command "LINE" \'(0 0) \'(10 0) \'(10 10) \'(0 10) "C") (princ))');
    expect(last(h)).toBe('C:SQ');
    const depth0 = h.st.session.depth;
    h.type('SQ');
    await h.idle();
    expect(h.errors()).toEqual([]);
    expect(h.model('LINE')).toHaveLength(4);
    expect(h.st.session.depth).toBe(depth0 + 1);
    await h.lisp('(defun c:circle () (princ "내 원"))');
    expect(h.out()).toContain('참고: AutoLISP 명령 CIRCLE이(가) 같은 이름의 기존 명령(CIRCLE)보다 먼저 실행됩니다.');
    h.type('CIRCLE');
    await h.idle();
    expect(last(h)).toBe('내 원"내 원"');
    // command와 ".이름"은 원래 명령을 부른다
    await h.lisp('(command "CIRCLE" \'(0 0) 4)');
    expect(h.model('CIRCLE')[0]).toMatchObject({ radius: 4 });
    for (const t of ['.CIRCLE', '9,9', '1']) {
      h.type(t);
      await h.idle();
    }
    expect(h.model('CIRCLE')).toHaveLength(2);
  });

  it('*error*는 c: 명령의 지역 변수와 함께 불린다', async () => {
    const h = setup();
    await h.lisp('(defun c:boom (/ *error* old) (setq old "복원") (defun *error* (m) (princ (strcat "\\n" old ": " m)) (princ)) (/ 1 0))');
    h.type('BOOM');
    await h.idle();
    lispSession(h.app).it.flush();
    expect(h.out()).toContain('복원: 0으로 나누기');
    expect(h.errors()).toEqual([]);
  });
});

describe('객체 함수', () => {
  it('entget·entmod 왕복(도면층을 만들고, 좌표·색을 바꾼다)', async () => {
    const h = setup();
    const e = h.add(line(0, 0, 10, 0));
    await h.lisp('(setq e (entlast) d (entget e))');
    expect(last(h)).toMatch(/^\(\(-1 \. <엔티티 이름: [0-9a-f]+>\) \(0 \. "LINE"\) \(330 \. <엔티티 이름: [0-9a-f]+>\) \(5 \. "[0-9A-F]+"\) \(100 \. "AcDbEntity"\) \(67 \. 0\) \(410 \. "Model"\) \(8 \. "0"\) \(100 \. "AcDbLine"\) \(10 0\.0 0\.0 0\.0\) \(11 10\.0 0\.0 0\.0\) \(210 0\.0 0\.0 1\.0\)\)$/);
    await h.lisp('(cdr (assoc 5 d))');
    expect(last(h)).toBe(`"${e.handle}"`);
    await h.lisp('(setq d (subst (cons 8 "새층") (assoc 8 d) d) d (subst \'(10 1.0 2.0 0.0) (assoc 10 d) d) d (append d \'((62 . 1)))) (entmod d)');
    expect(h.errors()).toEqual([]);
    const after = h.doc.entityIndex.get(e.handle) as Entity & { start: { x: number; y: number } };
    expect(after.layer).toBe('새층');
    expect(h.doc.layers.has('새층')).toBe(true);
    expect(after.start).toMatchObject({ x: 1, y: 2 });
    expect(after.color.aci).toBe(1);
    await h.lisp('(cdr (assoc 62 (entget e)))');
    expect(last(h)).toBe('1');
    // 원래 목록과 entget이 다시 같다(왕복)
    await h.lisp('(equal (entget e) (entget e))');
    expect(last(h)).toBe('T');
  });

  it('entmake·entdel·entnext·handent·ssget X 필터', async () => {
    const h = setup();
    h.add(line(0, 0, 1, 0, '벽'));
    h.add(line(0, 1, 1, 1, '문'));
    await h.lisp("(entmake '((0 . \"CIRCLE\") (8 . \"원층\") (10 5.0 5.0 0.0) (40 . 2.5)))");
    expect(h.model('CIRCLE')[0]).toMatchObject({ radius: 2.5, layer: '원층', center: { x: 5, y: 5 } });
    await h.lisp("(entmake '((0 . \"LWPOLYLINE\") (90 . 3) (70 . 1) (10 0 0) (10 4 0) (42 . 0.5) (10 4 3)))");
    const pl = h.model('LWPOLYLINE')[0]!;
    expect(pl.closed).toBe(true);
    expect(lwVertices(pl).map((v: { x: number; y: number; bulge: number }) => [v.x, v.y, v.bulge])).toEqual([
      [0, 0, 0],
      [4, 0, 0.5],
      [4, 3, 0],
    ]);
    await h.lisp("(entmake '((0 . \"TEXT\") (10 0 0 0) (40 . 3.5) (1 . \"글자\")))");
    expect(h.model('TEXT')[0]).toMatchObject({ text: '글자', height: 3.5 });
    await h.lisp("(entmake '((0 . \"LINE\") (10 0 0 0)))");
    expect(last(h)).toBe('nil');
    await h.lisp('(sslength (ssget "X" \'((0 . "LINE"))))');
    expect(last(h)).toBe('2');
    await h.lisp('(sslength (ssget "_X" \'((-4 . "<OR") (8 . "벽") (0 . "CIRCLE") (-4 . "OR>"))))');
    expect(last(h)).toBe('2');
    await h.lisp('(ssget "X" \'((8 . "없음")))');
    expect(last(h)).toBe('nil');
    // 원(반지름 2.5)과 문자(높이 3.5)
    await h.lisp('(sslength (ssget "X" \'((-4 . ">=") (40 . 2.0))))');
    expect(last(h)).toBe('2');
    await h.lisp('(setq n 0 e (entnext)) (while e (setq n (1+ n) e (entnext e))) n');
    expect(last(h)).toBe('5');
    await h.lisp('(entdel (ssname (ssget "X" \'((0 . "CIRCLE"))) 0))');
    expect(h.model('CIRCLE')).toHaveLength(0);
    await h.lisp('(handent "ZZZZ")');
    expect(last(h)).toBe('nil');
    await h.lisp('(tblsearch "LAYER" "원층")');
    expect(last(h)).toBe('((0 . "LAYER") (2 . "원층") (70 . 0) (62 . 7) (6 . "Continuous") (290 . 1) (370 . -3))');
    await h.lisp('(entmake \'((0 . "LAYER") (2 . "새도면층") (70 . 0) (62 . 3)))');
    expect(h.doc.layers.get('새도면층')?.color.aci).toBe(3);
  });

  it('블록 참조의 속성: entnext로 ATTRIB·SEQEND를 따라가고 entmod로 값을 바꾼다', async () => {
    const h = setup();
    const att = { ...entityDefaults(), type: 'ATTRIB', handle: '', insert: { x: 0, y: 2, z: 0 }, height: 1, text: 'D1', rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0, tag: 'NUM', attFlags: 0 } as unknown as Entity;
    att.handle = h.st.session.newHandle();
    const ins = { ...entityDefaults(), type: 'INSERT', handle: '', block: 'DOOR', insert: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [att] } as unknown as Entity;
    ins.handle = h.st.session.newHandle();
    (att as { owner?: string }).owner = ins.handle;
    h.add(ins);
    await h.lisp('(setq b (entlast) a (entnext b) ad (entget a)) (list (cdr (assoc 0 ad)) (cdr (assoc 2 ad)) (cdr (assoc 1 ad)) (cdr (assoc 66 (entget b))))');
    expect(last(h)).toBe('("ATTRIB" "NUM" "D1" 1)');
    await h.lisp('(entmod (subst (cons 1 "A-12") (assoc 1 ad) ad)) (cdr (assoc 0 (entget (entnext a))))');
    expect(last(h)).toBe('"SEQEND"');
    expect((h.model('INSERT')[0]!.attribs[0] as { text: string }).text).toBe('A-12');
  });

  it('trans: UCS ↔ WCS(2D)', async () => {
    const h = setup();
    h.doc.header.set('$UCSORG', { x: 10, y: 0, z: 0 });
    h.doc.header.set('$UCSXDIR', { x: 0, y: 1, z: 0 });
    await h.lisp("(trans '(1 0 0) 1 0)");
    expect(last(h)).toBe('(10.0 1.0 0.0)');
    await h.lisp("(trans '(10 1) 0 1)");
    expect(last(h)).toMatch(/^\(1\.0 [-0-9.e]+\)$/);
    await h.lisp("(trans '(1 0 0) 1 0 T)");
    expect(last(h)).toBe('(6.12323e-17 1.0 0.0)');
  });

  it('getvar·setvar는 도면 변수와 세션 변수(OSMODE·FILEDIA)를 잇는다', async () => {
    const h = setup();
    await h.lisp('(getvar "LTSCALE")');
    expect(last(h)).toBe('1.0');
    await h.lisp('(setvar "ltscale" 2.5)');
    expect(h.doc.header.get('$LTSCALE')).toBe(2.5);
    await h.lisp('(getvar "CLAYER")');
    expect(last(h)).toBe('"0"');
    await h.lisp('(setvar "CLAYER" "없는층")');
    expect(h.errors()[0]).toContain('; 오류: AutoCAD 변수 설정 거부: "CLAYER" "없는층"');
    await h.lisp('(setvar "OSMODE" 33)');
    expect([...(h.app.snapModes as Set<string>)].sort()).toEqual(['end', 'int']);
    await h.lisp('(getvar "osmode")');
    expect(last(h)).toBe('33');
    await h.lisp('(getvar "DWGNAME")');
    expect(last(h)).toBe('"test.dwg"');
  });
});

describe('스크립트 안의 AutoLISP', () => {
  it('식·!변수·command·defun c:가 스크립트에서 돌고, get*은 스크립트의 다음 입력을 받는다', async () => {
    const h = setup();
    const scr = [
      '(setq r 7)',
      'CIRCLE 0,0 !r',
      '(command "LINE" "0,0" "10,0" "")',
      '(defun c:tri ()',
      '  (command "LINE" \'(0 0) \'(5 0) \'(0 5) "C")',
      '  (princ))',
      'TRI',
      '(setq p (getpoint "점:")) 30,40',
      '(command "CIRCLE" p 2)',
      '',
    ].join('\n');
    expect(await h.script(scr)).toBe('idle');
    expect(h.errors()).toEqual([]);
    const circles = h.model('CIRCLE');
    expect(circles.map((c) => c.radius).sort()).toEqual([2, 7]);
    expect(circles.find((c) => c.radius === 2)!.center).toMatchObject({ x: 30, y: 40 });
    expect(h.model('LINE')).toHaveLength(4);
  });

  it('스크립트 안의 entsel·ssget·PAUSE는 스크립트 입력을 받는다', async () => {
    const h = setup();
    h.add(line(0, 0, 10, 0));
    h.add(line(0, 5, 10, 5));
    h.add(line(100, 100, 110, 100));
    const scr = ['(setq es (entsel "고르기:")) 5,0', '(setq ss (ssget)) W -1,-1 20,20 ', '(command "CIRCLE" pause 3) 50,50', '(setq n (sslength ss))', ''].join('\n');
    expect(await h.script(scr)).toBe('idle');
    expect(h.errors()).toEqual([]);
    await h.lisp('(list n (cdr (assoc 10 (entget (car es)))))');
    expect(last(h)).toBe('(2 (0.0 0.0 0.0))');
    expect(h.model('CIRCLE')[0]).toMatchObject({ radius: 3, center: { x: 50, y: 50 } });
  });

  it('AutoLISP 오류에서 스크립트가 멈춘다', async () => {
    const h = setup();
    expect(await h.script('(car 1)\nCIRCLE 0,0 5\n')).toBe('paused');
    expect(h.model('CIRCLE')).toHaveLength(0);
  });

  it('load는 이 세션에 연 파일을 이름으로 찾는다', async () => {
    const h = setup();
    lispSession(h.app).remember('tools.lsp', '(defun c:ll () (command "LINE" \'(0 0) \'(1 1) "") (princ))\n(princ "\\ntools 로드")\n(princ)');
    await h.lisp('(load "tools")');
    expect(h.out()).toContain('tools 로드');
    h.type('LL');
    await h.idle();
    expect(h.model('LINE')).toHaveLength(1);
  });
});
