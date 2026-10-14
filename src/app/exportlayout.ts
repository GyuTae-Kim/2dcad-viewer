/**
 * EXPORTLAYOUT: 지금 배치에 보이는 모든 것을 새 도면의 모형 공간으로 내보낸다(새 탭으로 열고, 저장은 QSAVE·SAVEAS).
 */
import { tableKey } from '../core/model';
import { exportLayoutDocument } from '../edit/exportlayout';
import type { App } from './app';
import { baseName } from './export';
import { layoutViewports, viewportXf } from './scene';

export function registerExportLayoutCommands(app: App): void {
  app.register({
    name: 'EXPORTLAYOUT',
    title: '배치를 모형으로 내보내기',
    async run(ctx) {
      const st = app.active!;
      if (!st.onLayout || st.msVp || st.blockEdit) {
        ctx.print('배치 탭(종이 공간)에서 실행하십시오.', 'err');
        return;
      }
      const lay = st.layoutFor(st.space);
      if (!lay) return;
      await app.edits.flush(st);
      const vps = layoutViewports(st.doc, lay).map((vp) => {
        const x = viewportXf(st.doc, vp);
        return { vp, k: x.k, twist: x.twist, refX: x.refX, refY: x.refY, clip: x.clip, frozen: x.frozen };
      });
      let doc;
      try {
        doc = exportLayoutDocument(st.doc, tableKey(lay.blockName), vps);
      } catch (e) {
        ctx.print(`내보내지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
        return;
      }
      const ext = st.doc.format === 'dxf' ? 'dxf' : 'dwg';
      let name = `${baseName(st.saveName)}_${lay.name}.${ext}`;
      for (let i = 2; app.docs.some((d) => d.saveName === name); i++) name = `${baseName(st.saveName)}_${lay.name}(${i}).${ext}`;
      const res = await app.engine.adopt(name, doc);
      app.addDocument(res, name, 0);
      ctx.print(`배치 ${lay.name}을(를) 새 도면 ${name}의 모형 공간으로 내보냈습니다(뷰포트 ${vps.length}개는 잘린 블록 참조). 저장하려면 QSAVE를 실행하십시오.`);
    },
  });
}
