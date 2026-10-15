import { describe, expect, it } from 'vitest';
import type { BlockDef, CadDocument, Entity, XRecordObject } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { registerDrawCommands } from '../../src/app/draw';
import { grVectors } from '../../src/app/lisp-gr';
import { TextEngine } from '../../src/text/layout';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg/writer/index';
import { readCadFile } from '../../src/io';
import { makeLispApp, type LispApp } from './app';

function setup(extra?: (doc: CadDocument) => void): LispApp {
  const h = makeLispApp(extra);
  registerDrawCommands(h.app);
  return h;
}

const line = (x0: number, y0: number, x1: number, y1: number, layer = '0') => ({ ...entityDefaults(), layer, type: 'LINE', handle: '', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } }) as Entity;
const last = (h: LispApp) => h.printed[h.printed.length - 1]?.text;

describe('ssget·명령의 WP·CP·F', () => {
  it('(ssget "WP"/"CP"/"F" 점 목록 [필터])', async () => {
    const h = setup();
    h.add(line(10, 10, 20, 10));
    h.add(line(10, 30, 60, 30, '벽'));
    h.add(line(100, 100, 110, 100));
    await h.lisp('(setq sq \'((0 0) (50 0) (50 50) (0 50)))');
    await h.lisp('(sslength (ssget "WP" sq))');
    expect(last(h)).toBe('1');
    await h.lisp('(sslength (ssget "_CP" sq))');
    expect(last(h)).toBe('2');
    await h.lisp('(sslength (ssget "CP" sq \'((8 . "벽"))))');
    expect(last(h)).toBe('1');
    await h.lisp('(sslength (ssget "F" \'((105 90) (105 120) (15 120) (15 0))))');
    expect(last(h)).toBe('3');
    await h.lisp('(ssget "WP" \'((0 0) (1 1)))');
    expect(h.errors().pop()).toContain('폴리곤 점은 3개 이상');
  });

  it('(command "ERASE" "WP" …): 객체 선택 프롬프트의 키워드로 점을 차례로 넣는다', async () => {
    const h = setup();
    h.add(line(10, 10, 20, 10));
    h.add(line(10, 30, 60, 30));
    await h.lisp('(command "ERASE" "WP" \'(0 0) \'(50 0) \'(50 50) \'(0 50) "" "")');
    expect(h.errors()).toEqual([]);
    expect(h.model('LINE').map((l) => l.start.y)).toEqual([30]);
    expect(h.prompts).toContain('첫 번째 폴리곤 점:');
  });
});

describe('확장 데이터(regapp·entget 앱 목록·entmod·entmake -3·xdsize·xdroom)', () => {
  it('왕복: 등록한 앱만 쓰고, 빈 앱 목록은 지운다', async () => {
    const h = setup();
    h.add(line(0, 0, 10, 0));
    await h.lisp('(regapp "MYAPP")');
    expect(last(h)).toBe('"MYAPP"');
    await h.lisp('(regapp "MYAPP")');
    expect(last(h)).toBe('nil');
    await h.lisp('(setq e (entlast))');
    await h.lisp('(entmod (append (entget e) \'((-3 ("MYAPP" (1000 . "문") (1002 . "{") (1040 . 2.5) (1070 . 3) (1002 . "}") (1010 1.0 2.0 0.0) (1005 . "1F") (1071 . 70000) (1004 . "0A0B"))))))');
    expect(h.errors()).toEqual([]);
    await h.lisp('(assoc -3 (entget e \'("MYAPP")))');
    expect(last(h)).toBe('(-3 ("MYAPP" (1000 . "문") (1002 . "{") (1040 . 2.5) (1070 . 3) (1002 . "}") (1010 1.0 2.0 0.0) (1005 . "1F") (1071 . 70000) (1004 . "0A0B")))');
    // 앱 목록이 없으면 -3이 없다, 와일드카드
    await h.lisp('(assoc -3 (entget e))');
    expect(last(h)).toBe('nil');
    await h.lisp('(car (cadr (assoc -3 (entget e \'("MY*")))))');
    expect(last(h)).toBe('"MYAPP"');
    expect(h.model('LINE')[0]!.xdata?.[0]?.items).toHaveLength(9);
    // 등록하지 않은 앱은 실패
    await h.lisp('(entmod (append (entget e) \'((-3 ("NOAPP" (1000 . "x"))))))');
    expect(last(h)).toBe('nil');
    // { } 짝이 틀리면 잘못된 DXF 그룹
    await h.lisp('(entmod (append (entget e) \'((-3 ("MYAPP" (1002 . "{"))))))');
    expect(h.errors().pop()).toContain('잘못된 DXF 그룹');
    // ssget -3 필터
    await h.lisp('(sslength (ssget "X" \'((-3 ("MYAPP")))))');
    expect(last(h)).toBe('1');
    // 크기와 남은 자리
    await h.lisp('(xdsize \'((-3 ("MYAPP" (1000 . "ab") (1040 . 1.0)))))');
    expect(last(h)).toBe(String(4 + 1 + 3 + 2 + 1 + 8));
    await h.lisp('(xdroom e)');
    expect(Number(last(h))).toBeLessThan(16383);
    // 지우기
    await h.lisp('(entmod (append (entget e) \'((-3 ("MYAPP")))))');
    expect(h.model('LINE')[0]!.xdata).toBeUndefined();
    await h.lisp('(xdroom e)');
    expect(last(h)).toBe('16383');
  });

  it('entmake의 -3과 도면층 기록의 확장 데이터, 명령 취소 한 단계', async () => {
    const h = setup();
    await h.lisp('(regapp "TAG")');
    await h.lisp('(entmake \'((0 . "CIRCLE") (10 0 0 0) (40 . 1.0) (-3 ("TAG" (1000 . "원")))))');
    expect(h.model('CIRCLE')[0]!.xdata).toEqual([{ app: 'TAG', items: [{ code: 1000, value: '원' }] }]);
    const depth = h.st.session.depth;
    await h.lisp('(setq la (tblobjname "LAYER" "0")) (entmod (append (entget la) \'((62 . 3) (-3 ("TAG" (1070 . 7))))))');
    expect(h.errors()).toEqual([]);
    expect(h.doc.layers.get('0')!.color.aci).toBe(3);
    await h.lisp('(list (cdr (assoc 0 (entget la))) (cdr (assoc 2 (entget la))) (assoc -3 (entget la \'("TAG"))))');
    expect(last(h)).toBe('("LAYER" "0" (-3 ("TAG" (1070 . 7))))');
    expect(h.st.session.depth).toBe(depth + 1);
    h.st.session.undo();
    expect(h.doc.layers.get('0')!.color.aci).toBe(7);
    expect(h.doc.layers.get('0')!.xdata).toBeUndefined();
  });
});

describe('사전·XRECORD(namedobjdict·dictadd·dictsearch·dictnext·dictrename·dictremove)', () => {
  it('왕복과 명령 취소', async () => {
    const h = setup();
    await h.lisp('(setq nod (namedobjdict))');
    await h.lisp('(cdr (assoc 0 (entget nod)))');
    expect(last(h)).toBe('"DICTIONARY"');
    await h.lisp('(setq xr (entmakex \'((0 . "XRECORD") (100 . "AcDbXrecord") (1 . "값") (10 1.0 2.0 3.0) (40 . 2.5) (70 . 7))))');
    expect(String(last(h))).toMatch(/^<엔티티 이름: [0-9a-f]+>$/);
    // 사전에 넣기 전에는 도면 밖
    expect([...h.doc.objects.values()].some((o) => o.type === 'XRECORD')).toBe(false);
    const depth = h.st.session.depth;
    await h.lisp('(dictadd nod "MY_DATA" xr)');
    expect(h.errors()).toEqual([]);
    expect(h.st.session.depth).toBe(depth + 1);
    const x = [...h.doc.objects.values()].find((o) => o.type === 'XRECORD') as XRecordObject;
    expect(x.data.map((t) => t.code)).toEqual([1, 10, 20, 30, 40, 70]);
    await h.lisp('(setq d (dictsearch nod "my_data")) (list (cdr (assoc 1 d)) (cdr (assoc 10 d)) (cdr (assoc 40 d)) (cdr (assoc 70 d)) (eq (cdr (assoc 330 d)) nod))');
    expect(last(h)).toBe('("값" (1.0 2.0 3.0) 2.5 7 T)');
    // 같은 이름은 넣지 못한다
    await h.lisp('(dictadd nod "MY_DATA" (entmakex \'((0 . "XRECORD") (1 . "b"))))');
    expect(last(h)).toBe('nil');
    // entmod로 자료 바꾸기
    await h.lisp('(entmod (subst \'(1 . "새 값") (assoc 1 d) d)) (cdr (assoc 1 (dictsearch nod "MY_DATA")))');
    expect(last(h)).toBe('"새 값"');
    // dictnext는 이름 순으로 돈다
    await h.lisp('(setq n 0 hit nil) (setq it (dictnext nod T)) (while it (setq n (1+ n)) (if (= (cdr (assoc 1 it)) "새 값") (setq hit T)) (setq it (dictnext nod))) (list (> n 1) hit)');
    expect(last(h)).toBe('(T T)');
    await h.lisp('(dictrename nod "MY_DATA" "OUR_DATA")');
    expect(last(h)).toBe('"OUR_DATA"');
    await h.lisp('(list (dictsearch nod "MY_DATA") (cdr (assoc 1 (dictsearch nod "OUR_DATA"))))');
    expect(last(h)).toBe('(nil "새 값")');
    // 빼면 도면 밖으로(이름은 그대로, entget은 된다), 다시 넣을 수 있다
    await h.lisp('(setq gone (dictremove nod "OUR_DATA")) (list (eq gone xr) (dictsearch nod "OUR_DATA") (cdr (assoc 1 (entget gone))))');
    expect(last(h)).toBe('(T nil "새 값")');
    expect([...h.doc.objects.values()].some((o) => o.type === 'XRECORD')).toBe(false);
    await h.lisp('(dictadd nod "BACK" gone) (cdr (assoc 1 (dictsearch nod "BACK")))');
    expect(last(h)).toBe('"새 값"');
    // 명령 취소로 되돌린다(넣기 → 빼기 → 넣기를 하나씩)
    h.st.session.undo();
    expect([...h.doc.objects.values()].some((o) => o.type === 'XRECORD')).toBe(false);
  });

  it('확장 데이터·사전·XRECORD는 DXF·DWG로 저장하고 다시 읽어도 남는다', async () => {
    const h = setup();
    h.add(line(0, 0, 10, 0));
    await h.lisp('(regapp "KEEP") (entmod (append (entget (entlast)) \'((-3 ("KEEP" (1000 . "선") (1040 . 1.5) (1010 1 2 3))))))');
    await h.lisp('(dictadd (namedobjdict) "KEEP_DICT" (entmakex \'((0 . "XRECORD") (100 . "AcDbXrecord") (1 . "글") (10 1.0 2.0 3.0) (40 . 2.5) (90 . 7))))');
    expect(h.errors()).toEqual([]);
    for (const [name, data] of [
      ['a.dxf', writeDxf(h.doc).data],
      ['a.dwg', writeDwg(h.doc).data],
    ] as const) {
      const back = readCadFile(data, name);
      const ln = [...back.blocks.get('*MODEL_SPACE')!.entities].find((e) => e.type === 'LINE')!;
      const xd = ln.xdata?.find((x) => x.app === 'KEEP');
      expect(xd?.items.map((i) => i.code), name).toEqual([1000, 1040, 1010]);
      expect(back.appIds.has('KEEP'), name).toBe(true);
      const root = back.objects.get(back.rootDictionary!) as { entries: Map<string, string> };
      const xh = root.entries.get('KEEP_DICT');
      expect(xh, name).toBeTruthy();
      const xr = back.objects.get(xh!) as XRecordObject;
      expect(xr.type, name).toBe('XRECORD');
      expect(xr.data.find((t) => t.code === 1)?.value, name).toBe('글');
      expect(Number(xr.data.find((t) => t.code === 90)?.value), name).toBe(7);
    }
  });

  it('하위 사전 만들기와 표 기록 tblobjname·handent', async () => {
    const h = setup();
    await h.lisp('(setq sub (entmakex \'((0 . "DICTIONARY") (100 . "AcDbDictionary")))) (dictadd (namedobjdict) "회사" sub)');
    await h.lisp('(dictadd sub "설정" (entmakex \'((0 . "XRECORD") (100 . "AcDbXrecord") (300 . "A3") (90 . 120000))))');
    await h.lisp('(cdr (assoc 90 (dictsearch (cdr (assoc -1 (dictsearch (namedobjdict) "회사"))) "설정")))');
    expect(last(h)).toBe('120000');
    await h.lisp('(list (cdr (assoc 0 (entget (tblobjname "STYLE" "Standard")))) (cdr (assoc 100 (cdr (member (assoc 100 (entget (tblobjname "LTYPE" "Continuous"))) (entget (tblobjname "LTYPE" "Continuous")))))))');
    expect(last(h)).toBe('("STYLE" "AcDbLinetypeTableRecord")');
    await h.lisp('(eq (handent (cdr (assoc 5 (entget (tblobjname "LAYER" "0"))))) (tblobjname "LAYER" "0"))');
    expect(last(h)).toBe('T');
    await h.lisp('(tblobjname "APPID" "ACAD")');
    expect(last(h)).not.toBe('nil');
  });
});

/** 블록 BOX(사각형 4선)와 그 안의 블록 IN(가로선) */
function blocks(doc: CadDocument): void {
  let n = 0xc000;
  const H = () => (n++).toString(16).toUpperCase();
  const mk = (name: string, ents: Entity[], base = { x: 0, y: 0, z: 0 }) => {
    const rec = H();
    for (const e of ents) {
      e.handle = H();
      e.owner = rec;
    }
    doc.blockRecords.set(name, { name, handle: rec, flags: 0, insertUnits: 0, explodable: true, scalable: true });
    const def: BlockDef = { name, handle: H(), recordHandle: rec, basePoint: base, flags: 0, entities: ents };
    doc.blocks.set(name, def);
    for (const e of ents) doc.entityIndex.set(e.handle, e);
  };
  mk('IN', [line(0, 0, 4, 0)]);
  const inner = { ...entityDefaults(), type: 'INSERT', handle: '', block: 'IN', insert: { x: 2, y: 5, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] } as unknown as Entity;
  mk('BOX', [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0), inner]);
}

describe('nentsel·nentselp', () => {
  it('블록 안 객체와 변환 행렬, 중첩 블록 참조 목록', async () => {
    const h = setup(blocks);
    // BOX를 (100, 0)에 2배, 90° 돌려 넣는다
    h.add({ ...entityDefaults(), type: 'INSERT', handle: '', block: 'BOX', insert: { x: 100, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 1 }, rotation: Math.PI / 2, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] } as unknown as Entity);
    // 블록의 아래 선(0,0)-(10,0)은 도면에서 (100,0)-(100,20)
    expect(await h.script('(setq r (nentsel)) 100,7\n')).toBe('idle');
    expect(h.errors()).toEqual([]);
    await h.lisp('(list (length r) (cdr (assoc 10 (entget (car r)))) (cdr (assoc 11 (entget (car r)))) (cdr (assoc 0 (entget (car (last r))))))');
    expect(last(h)).toBe('(4 (0.0 0.0 0.0) (10.0 0.0 0.0) "INSERT")');
    // 행렬: X축 → (0 2 0), Y축 → (-2 0 0), 원점 (100 0 0)
    await h.lisp('(mapcar \'(lambda (r) (mapcar \'(lambda (x) (atof (rtos x 2 6))) r)) (caddr r))');
    expect(last(h)).toBe('((0.0 2.0 0.0) (-2.0 0.0 0.0) (0.0 0.0 1.0) (100.0 0.0 0.0))');
    // 중첩: IN의 선(블록 BOX 좌표 (2,5)-(6,5)) → 도면 (90,4)-(90,12)
    await h.lisp('(setq q (nentselp (list 90.0 8.0))) (list (length (last q)) (cdr (assoc 0 (entget (car (last q))))) (cdr (assoc 2 (entget (car (last q))))))');
    expect(last(h)).toBe('(2 "INSERT" "IN")');
    // nentselp 행렬은 4×4, 마지막 줄 (0 0 0 1)
    await h.lisp('(list (length (caddr q)) (last (caddr q)) (mapcar \'(lambda (x) (atof (rtos x 2 6))) (car (caddr q))))');
    expect(last(h)).toBe('(4 (0.0 0.0 0.0 1.0) (0.0 -2.0 0.0 90.0))');
    // 맨 위 객체는 (이름 점)
    h.add(line(0, 50, 10, 50));
    await h.lisp('(length (nentselp \'(5 50)))');
    expect(last(h)).toBe('2');
  });
});

describe('textbox·grdraw', () => {
  it('textbox: 문자 자기 좌표의 상자(높이·폭 비율 반영)', async () => {
    const h = setup();
    (h.app as unknown as { text: TextEngine }).text = new TextEngine(null);
    await h.lisp('(setq b (textbox \'((1 . "ABC") (40 . 2.0))))');
    await h.lisp('(list (car (car b)) (cadr (car b)) (> (car (cadr b)) 3.0) (atof (rtos (cadr (cadr b)) 2 3)))');
    expect(last(h)).toMatch(/^\(0\.0 0\.0 T 2\.\d+\)$/);
    await h.lisp('(setq w1 (car (cadr (textbox \'((1 . "ABC") (40 . 2.0) (41 . 1.0))))) w2 (car (cadr (textbox \'((1 . "ABC") (40 . 2.0) (41 . 2.0)))))) (equal (* 2 w1) w2 1e-6)');
    expect(last(h)).toBe('T');
    await h.lisp('(textbox \'((0 . "MTEXT") (1 . "x")))');
    expect(last(h)).toBe('nil');
  });

  it('grdraw·grvecs는 임시 벡터를 그리고 (redraw)로 지운다', async () => {
    const h = setup();
    await h.lisp('(grdraw \'(0 0) \'(10 0) 1) (grvecs \'(2 (0 0) (0 5) -3 (0 5) (5 5)))');
    expect(grVectors(h.app).map((v) => [v.a.x, v.a.y, v.b.x, v.b.y, v.color, v.highlight])).toEqual([
      [0, 0, 10, 0, 1, false],
      [0, 0, 0, 5, 2, false],
      [0, 5, 5, 5, 3, true],
    ]);
    await h.lisp('(redraw)');
    expect(grVectors(h.app)).toHaveLength(0);
  });
});
