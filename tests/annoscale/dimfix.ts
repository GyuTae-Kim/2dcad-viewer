/** 시험용 선형 치수(그림 블록을 먼저 넣는다) */
import type { CadDocument, DimensionEntity } from '../../src/core/model';
import { createLinearDimension } from '../../src/edit/dim/create';
import { regenerateDimension } from '../../src/edit/annoscale/edit';
import type { EditOp, EditSession } from '../../src/edit/session';
import { envOf } from './helpers';

export function createDimension(doc: CadDocument, session: EditSession): DimensionEntity {
  const d = createLinearDimension(doc, { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 50, y: 20, z: 0 });
  const ops: EditOp[] = [];
  const out = regenerateDimension(envOf(doc, session), d, null, ops);
  session.commit({ label: 'DIM', ops });
  return out;
}
