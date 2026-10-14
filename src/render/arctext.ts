/**
 * 원호 정렬 문자(ARCALIGNEDTEXT) 그리기 도우미(src/render/build.ts가 부른다).
 *
 * 글자마다 가운데 맞춤 한 줄 문자(TEXT)와 밑줄 호(ARC)로 나눠 장면 만들기의 TEXT·ARC 그리기를 그대로 쓴다.
 * 그래서 화면·PDF·SVG·고르기가 같은 그림이고, 조각들은 원래 객체의 특성(도면층·색·선종류·투명도)을 지니며
 * 최상위에서는 원래 객체의 핸들로 묶인다(build()가 endEntity(e.handle)).
 * AutoCAD가 저장한 프록시 그림이 있고 읽은 뒤 정의가 바뀌지 않았으면 그 그림을 그린다(그룹 코드를 실물로 확인하지 못했으므로).
 *
 * build.ts SceneBuilder.entity()의 switch에 넣을 연결:
 *   case 'ARCALIGNEDTEXT':
 *     if (arcTextUseProxy(e) && this.proxy(e as unknown as UnknownEntity, ctx)) return;
 *     for (const p of arcTextDrawParts(e)) this.entity(p, ctx);
 *     return;
 */
import type { ArcTextEntity, Entity } from '../core/model';
import { arcTextParts, arcTextSig } from '../text/arctext';

/** 그릴 조각(글자 TEXT·밑줄 ARC). 배치할 수 없으면 빈 배열 */
export function arcTextDrawParts(e: ArcTextEntity): Entity[] {
  try {
    return arcTextParts(e);
  } catch {
    return [];
  }
}

/** AutoCAD가 저장한 프록시 그림을 그릴지: 그림이 있고 읽은 뒤 정의가 바뀌지 않았으면 */
export function arcTextUseProxy(e: ArcTextEntity): boolean {
  return !!e.graphics?.length && !!e.rawSig && e.rawSig === arcTextSig(e);
}
