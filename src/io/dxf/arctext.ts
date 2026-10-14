/**
 * DXF ARCALIGNEDTEXT(AcDbArcAlignedText, Express Tools 원호 정렬 문자) 읽기.
 *
 * 그룹 코드는 AutoCAD DXF 참조(R15)의 ARCALIGNEDTEXT 절 목록을 따른다: 1 문자, 2 글꼴, 3 큰 글꼴, 7 문자 스타일,
 * 10 원호 중심, 40 반지름, 41 폭 비율, 42 문자 높이, 43 문자 간격, 44 호에서의 간격띄우기, 45 오른쪽 간격띄우기,
 * 46 왼쪽 간격띄우기, 50·51 시작·끝 각도, 70 문자 순서(1 반전), 71 방향(1 바깥쪽, 2 안쪽), 72 정렬(1 맞춤, 2 왼쪽,
 * 3 오른쪽, 4 중심), 73 위치(1 볼록, 2 오목), 74 굵게, 75 기울임꼴, 76 밑줄, 210 돌출 방향, 330 원호 핸들.
 * 이 저장소의 표본 도면에는 이 객체가 없고 ezdxf도 이 객체를 모르므로 실물 파일로 확인되지 않았다.
 * 그래서 읽기에만 쓰고(그림은 프록시 그림이 있으면 그것), 다시 쓸 때는 읽은 원본 태그를 그대로 쓴다(src/io/arctext.ts).
 * 50·51은 둘 다 한 바퀴(2π) 안이면 라디안, 아니면 도로 읽는다(단위 미확인).
 * 1·42·10·40·50·51 중 하나라도 없으면 null(호출한 쪽이 예전처럼 모르는 객체로 둔다).
 */
import type { ArcTextEntity, EntityBase, RawTag } from '../../core/model';
import { decodeCadEscapes } from '../../core/codepage';
import { arcTextSig } from '../../text/arctext';
import { DEG, type Tags, handle } from './tagutil';

const TAU = Math.PI * 2;

export function parseArcAlignedText(base: EntityBase, t: Tags, raw: RawTag[] | undefined, graphics: Uint8Array | undefined, version: string): ArcTextEntity | null {
  for (const c of [1, 42, 10, 40, 50, 51]) if (!t.has(c)) return null;
  let a0 = t.num(50);
  let a1 = t.num(51);
  if (!(Math.abs(a0) <= TAU + 1e-9 && Math.abs(a1) <= TAU + 1e-9)) {
    a0 *= DEG;
    a1 *= DEG;
  }
  const flag = (code: number) => t.int(code) !== 0;
  const e: ArcTextEntity = {
    ...base,
    type: 'ARCALIGNEDTEXT',
    text: decodeCadEscapes(t.str(1)),
    center: t.point(10),
    radius: t.num(40),
    startAngle: a0,
    endAngle: a1,
    style: t.str(7).trim() || 'Standard',
    font: t.str(2).trim(),
    bigFont: t.str(3).trim(),
    height: t.num(42),
    widthFactor: t.num(41, 1) || 1,
    charSpacing: t.num(43),
    offset: t.num(44),
    leftOffset: Math.max(0, t.num(46)),
    rightOffset: Math.max(0, t.num(45)),
    alignment: [1, 2, 3, 4].includes(t.int(72)) ? t.int(72) : 1,
    position: t.int(73) === 2 ? 2 : 1,
    direction: t.int(71) === 2 ? 2 : 1,
    reversed: t.int(70) === 1,
    bold: flag(74),
    italic: flag(75),
    underline: flag(76),
  };
  if (!(e.radius > 0) || !(e.height > 0)) return null;
  const arc = t.str(330).trim();
  if (arc && arc !== '0') e.arc = handle(arc);
  if (t.has(210)) {
    const x = t.point(210);
    if (Math.abs(x.x) > 1e-12 || Math.abs(x.y) > 1e-12 || x.z < 0) e.extrusion = x;
  }
  if (graphics?.length) e.graphics = graphics;
  if (raw) {
    e.raw = raw;
    e.rawVersion = version;
  }
  e.rawSig = arcTextSig(e);
  return e;
}
