/**
 * 도면층 도구 2·디자인센터·CAD 표준 명령 등록:
 * COPYTOLAYER, LAYWALK, LAYTRANS, STANDARDS(STA), CHECKSTANDARDS(CHK), ADCENTER(ADC·DC·DCENTER), ADCCLOSE, ADCADD(디자인센터 내부용)
 */
import type { App } from './app';
import { registerStandardsCommands } from './cadstandards';
import { registerCopyToLayerCommands } from './copytolayer';
import { registerDesignCenterCommands } from './designcenter';
import { registerLayTransCommands } from './laytrans';
import { registerLayWalkCommands } from './laywalk';

export function registerLayerTools2Commands(app: App): void {
  registerCopyToLayerCommands(app);
  registerLayWalkCommands(app);
  registerLayTransCommands(app);
  registerStandardsCommands(app);
  registerDesignCenterCommands(app);
}
