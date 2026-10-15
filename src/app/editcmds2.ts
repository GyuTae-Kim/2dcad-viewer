/**
 * 편집 명령 묶음 2(editcmds2): 해치 경계·원점, 이미지·PDF 조정, 치수·표, 조회·특성·변수·그룹·도면층 창.
 * - 해치: HATCHGENERATEBOUNDARY, HATCHSETBOUNDARY, HATCHSETORIGIN (editcmds2-hatch.ts)
 * - 이미지·PDF: IMAGEADJUST(IAD)·-IMAGEADJUST, IMAGEQUALITY, TRANSPARENCY(이미지 바탕 투명), PDFADJUST, PDFLAYERS (editcmds2-image.ts)
 * - 치수·표: DIMCENTER(DCE), DIMHORIZONTAL, DIMVERTICAL, TABLEEXPORT, MATCHCELL (editcmds2-dim.ts)
 * - 조회·특성: QUICKPROPERTIES·QPMODE, DBLIST, TRANSPARENCYDISPLAY, VIEWRES, ELEV, PLAN, GROUPEDIT, LAYERCLOSE, CLASSICLAYER (editcmds2-query.ts)
 * - STRETCH의 걸침 폴리곤(CP) 선택은 modify.ts의 STRETCH가 editcmds2-stretch.ts를 부른다.
 * 이미 같은 이름·별칭으로 등록된 명령은 건너뛴다(먼저 등록한 쪽이 이긴다).
 */
import type { App, Command } from './app';
import { registerEditCmds2Dim } from './editcmds2-dim';
import { registerEditCmds2Hatch } from './editcmds2-hatch';
import { registerEditCmds2Image } from './editcmds2-image';
import { registerEditCmds2Query } from './editcmds2-query';

export function registerEditCmds2(app: App): void {
  const aliasMap = (app as unknown as { aliases?: Map<string, string> }).aliases;
  const taken = (n: string) => app.commands.has(n.toUpperCase()) || !!aliasMap?.has(n.toUpperCase());
  // 등록 함수들이 app.register를 부르는 동안만 겹침 검사를 끼운다
  const own = Object.prototype.hasOwnProperty.call(app, 'register');
  const prev = app.register;
  app.register = (c: Command) => {
    if (taken(c.name)) return;
    prev.call(app, { ...c, aliases: (c.aliases ?? []).filter((a) => !taken(a)) });
  };
  try {
    registerEditCmds2Hatch(app);
    registerEditCmds2Image(app);
    registerEditCmds2Dim(app);
    registerEditCmds2Query(app);
  } finally {
    if (own) app.register = prev;
    else Reflect.deleteProperty(app, 'register');
  }
}
