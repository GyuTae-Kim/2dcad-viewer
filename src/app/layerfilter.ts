/**
 * 도면층 필터 명령 등록: FILTERS(도면층 필터 삭제 대화상자 — AutoCAD 지원 문서의 명령).
 * -LAYER에는 필터 옵션이 없어 고치지 않는다. 필터 만들기·편집은 도면층 팔레트의 필터 트리에서 한다(layerfilter-ui).
 * FILTER(객체 선택 필터, 별칭 FI)와는 다른 명령이다.
 * 확정 고리 'layerfilter-migrate': 예전 이 앱 기록으로 저장된 필터를 도면을 고칠 때 AutoCAD 형식으로 옮긴다(layerfilter-core).
 */
import type { App } from './app';
import { addHook } from './hooks';
import { migrateFiltersOnCommit } from './layerfilter-core';
import { deleteFiltersDialog } from './layerfilter-ui';

export function registerLayerFilterCommands(app: App): void {
  // 예전 이 앱 기록(OPENCAD_LAYERFILTERS)은 도면을 고칠 때 AutoCAD 형식(ACLYDICTIONARY)으로 옮긴다
  addHook(app.commitHooks, { name: 'layerfilter-migrate', before: migrateFiltersOnCommit });
  app.register({
    name: 'FILTERS',
    title: '도면층 필터 삭제',
    run: async () => {
      await deleteFiltersDialog(app);
    },
  });
}

export { layerFilterPanel, newFilter, editFilter } from './layerfilter-ui';
export { currentFilterResult, filterStatusText } from './layerfilter-core';
