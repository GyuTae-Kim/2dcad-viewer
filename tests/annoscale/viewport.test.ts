/** 배치 뷰포트의 주석 축척: 저장된 레코드, 없으면 뷰포트 축척과 같은 축척, 쓰기(ASDK_XREC_ANNOTATION_SCALE_INFO), 그리기 */
import { describe, expect, it } from 'vitest';
import type { Entity, ViewportEntity, XRecordObject } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { DocState } from '../../src/app/docstate';
import { setViewportAnnoScale, syncViewportScale } from '../../src/app/annoscale-core';
import { addScales, dictOf, entryOf, makeAnnotative, storedViewportScale, viewportAnnoScale, viewportSynced } from '../../src/edit/annoscale';
import { EditSession } from '../../src/edit/session';
import { buildSpace } from '../../src/render/build';
import { TextEngine } from '../../src/text/layout';
import { addModel, commit, envOf, newDoc, text } from './helpers';

function vpOf(owner: string | undefined, k: number): ViewportEntity {
  return {
    ...entityDefaults(),
    type: 'VIEWPORT',
    handle: '',
    owner,
    paperSpace: true,
    center: { x: 100, y: 100, z: 0 },
    width: 100,
    height: 80,
    status: 2,
    id: 2,
    viewCenter: { x: 0, y: 0 },
    snapBase: { x: 0, y: 0 },
    snapSpacing: { x: 10, y: 10 },
    gridSpacing: { x: 10, y: 10 },
    viewDirection: { x: 0, y: 0, z: 1 },
    viewTarget: { x: 0, y: 0, z: 0 },
    lensLength: 50,
    frontClip: 0,
    backClip: 0,
    viewHeight: 80 / k,
    snapAngle: 0,
    twistAngle: 0,
    circleSides: 1000,
    flags: 32864,
    frozenLayers: [],
    renderMode: 0,
    ucsPerViewport: true,
  };
}

describe('뷰포트 주석 축척', () => {
  it('레코드가 없으면 뷰포트 축척과 같은 리스트의 축척, 쓰면 XRECORD(90 1, 340)', () => {
    const { doc } = newDoc('metric');
    const st = new DocState(1, doc, 'v.dxf', 0, 0);
    st.session = new EditSession(doc, () => {});
    const paper = doc.layouts.find((l) => l.name === 'Layout1')!;
    const ps = paper.blockName.toUpperCase();
    const vp = vpOf(paper.blockRecord, 1 / 20);
    vp.handle = st.session.newHandle();
    st.session.commit({ label: 'MVIEW', ops: [{ kind: 'add', block: ps, entity: vp }] });
    expect(storedViewportScale(doc, vp)).toBeNull();
    expect(viewportAnnoScale(doc, vp)?.name).toBe('1:20');
    // 주석 축척만(뷰포트 축척은 그대로) → 동기화 안 됨 → 동기화
    setViewportAnnoScale(st, vp, '1:50', false, 1);
    const v2 = doc.entityIndex.get(vp.handle) as ViewportEntity;
    expect(storedViewportScale(doc, v2)?.name).toBe('1:50');
    const x = doc.objects.get(entryOf(dictOf(doc, v2.xdict), 'ASDK_XREC_ANNOTATION_SCALE_INFO')!) as XRecordObject;
    expect(x.data.map((t) => t.code)).toEqual([90, 340]);
    expect(x.cloning).toBe(1);
    expect(viewportSynced(v2, viewportAnnoScale(doc, v2)!)).toBe(false);
    syncViewportScale(st, v2, 2);
    const v3 = doc.entityIndex.get(vp.handle) as ViewportEntity;
    expect(v3.height / v3.viewHeight).toBeCloseTo(1 / 50);
    // 고르면 둘 다(레코드는 340만 바뀐다)
    setViewportAnnoScale(st, v3, '1:10', true, 3);
    const v4 = doc.entityIndex.get(vp.handle) as ViewportEntity;
    expect(storedViewportScale(doc, v4)?.name).toBe('1:10');
    expect(v4.height / v4.viewHeight).toBeCloseTo(1 / 10);
    expect([...doc.objects.values()].filter((o) => o.type === 'XRECORD' && (o as XRecordObject).data.some((t) => t.code === 90))).toHaveLength(1);
    st.session.undo();
    expect(storedViewportScale(doc, doc.entityIndex.get(vp.handle) as ViewportEntity)?.name).toBe('1:50');
  });

  it('모형 장면을 뷰포트의 축척으로 다시 그리면 그 축척의 표현', () => {
    const { doc, session } = newDoc('metric');
    let t: Entity = addModel(doc, session, text(0, 0, 2));
    const r = makeAnnotative(envOf(doc, session), t, '1:1');
    commit(session, [...r.ops, { kind: 'modify', block: MODEL_SPACE, before: t, after: r.entity }]);
    t = doc.entityIndex.get(t.handle)!;
    const a = addScales(envOf(doc, session), t, ['1:50']);
    commit(session, a.ops);
    const eng = new TextEngine(null);
    const box = (scale?: string) => buildSpace(doc, MODEL_SPACE, { text: eng, annoScale: scale }).list.entities.find((b) => b.handle === t.handle)!;
    const b1 = box();
    const b50 = box('1:50');
    expect((b50.maxY - b50.minY) / (b1.maxY - b1.minY)).toBeCloseTo(50, 0);
  });
});
