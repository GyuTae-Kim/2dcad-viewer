/**
 * 연관 망 클래스 정의(DXF CLASSES·DWG AcDb:Classes). 값은 AutoCAD가 저장한 공개 짝 도면의 클래스 목록에서 본 것:
 * 모두 앱 "ObjectDBX Classes", 프록시 플래그 1025, 객체(도형 아님). 만든 버전·유지보수: 망·동작·구속 그룹·변수 27/45,
 * 배열 몸체·배열 매개변수 클래스 29/55, 종속·동작 매개변수는 저장한 제품마다 달라(27/8 … 27/125) 27/73을 쓴다.
 */
/** [DXF 이름, C++ 클래스, 만든 버전, 유지보수 버전] */
export const ASSOC_CLASS_DEFS: readonly (readonly [string, string, number, number])[] = [
  ['ACDBASSOCNETWORK', 'AcDbAssocNetwork', 27, 45],
  ['ACDBASSOCACTION', 'AcDbAssocAction', 27, 45],
  ['ACDBASSOC2DCONSTRAINTGROUP', 'AcDbAssoc2dConstraintGroup', 27, 45],
  ['ACDBASSOCVARIABLE', 'AcDbAssocVariable', 27, 45],
  ['ACDBASSOCDEPENDENCY', 'AcDbAssocDependency', 27, 73],
  ['ACDBASSOCGEOMDEPENDENCY', 'AcDbAssocGeomDependency', 27, 73],
  ['ACDBASSOCVALUEDEPENDENCY', 'AcDbAssocValueDependency', 27, 73],
  ['ASSOCDIMDEPENDENCYBODY', 'AcDbAssocDimDependencyBody', 27, 73],
  ['ACDBASSOCVERTEXACTIONPARAM', 'AcDbAssocVertexActionParam', 27, 73],
  ['ACDBASSOCEDGEACTIONPARAM', 'AcDbAssocEdgeActionParam', 27, 73],
  ['ACDBASSOCARRAYACTIONBODY', 'AcDbAssocArrayActionBody', 29, 55],
  ['ACDBASSOCARRAYRECTANGULARPARAMETERS', 'AcDbAssocArrayRectangularParameters', 29, 55],
  ['ACDBASSOCARRAYPOLARPARAMETERS', 'AcDbAssocArrayPolarParameters', 29, 55],
  ['ACDBASSOCARRAYPATHPARAMETERS', 'AcDbAssocArrayPathParameters', 29, 55],
];

export const ASSOC_APP = 'ObjectDBX Classes';
export const ASSOC_PROXY_FLAGS = 1025;
