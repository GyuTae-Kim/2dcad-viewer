/**
 * 다른 도면에서 붙여 넣기(PASTECLIP·PASTEORIG·PASTEBLOCK)의 의존 정의 가져오기.
 *
 * 디자인센터와 같은 정의 복사기(src/edit/layertools/clone.ts DefinitionCopier)로 도면층·선종류·문자/치수 스타일·블록·
 * 다중 지시선 스타일·테이블 스타일을 가져오고, 여러 줄 스타일(MLINESTYLE)은 여기서 가져온다.
 * - 이 도면에 같은 이름의 정의가 있으면 이 도면의 것을 쓴다(AutoCAD와 같다).
 * - 익명 블록(*D·*U·*T …)은 이름이 겹치면 이 도면의 다른 블록으로 그려지므로 늘 새 번호로 옮기고 참조를 다시 잇는다.
 * 붙여 넣을 객체(list)는 그 자리에서 이 도면의 이름·핸들을 가리키게 바꾼다. 객체 핸들과 서로 가리키는 연결(연관 해치 경계 등)은
 * 붙여넣기 명령이 새로 붙이므로 원래대로 둔다.
 */
import type { CadDocument, DictionaryObject, Entity, MLineEntity, MLineStyleObject } from '../core/model';
import { normalizeHandle, tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { DefinitionCopier } from '../edit/layertools/clone';
import { listMLineStyles, mlineStyleDictionary } from '../edit/mline/style';
import type { DocState } from './docstate';

/** 의존 정의를 가져오는 작업. list의 객체는 이 도면의 정의를 가리키게 바뀐다(같은 배열 자리에 바꿔 넣는다) */
export function pasteDependencies(st: DocState, src: CadDocument, list: Entity[]): EditOp[] {
  const dst = st.doc;
  if (src === dst) return [];
  const copier = new DefinitionCopier(src, dst, () => st.session.newHandle());
  const owner = dst.blocks.get(st.space)?.recordHandle ?? '';
  const mline = new MLineStyleCopier(src, dst, copier, () => st.session.newHandle());
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    const c = copier.entity(e, owner);
    // 옮길 수 없는 객체(파일을 가리키는 이미지·언더레이, 외부 참조 블록 참조)는 원래대로 둔다
    if (!c) continue;
    // 핸들·소유자·속성 핸들은 붙여넣기 명령이 새로 붙인다
    c.handle = e.handle;
    if (e.owner) c.owner = e.owner;
    else delete c.owner;
    if (c.type === 'INSERT' && e.type === 'INSERT') c.attribs.forEach((a, j) => (a.handle = e.attribs[j]?.handle ?? a.handle));
    if (c.type === 'MLINE' && e.type === 'MLINE') mline.relink(c, e);
    if (e.paperSpace) c.paperSpace = true;
    else delete c.paperSpace;
    list[i] = c;
  }
  return [...copier.finish(), ...mline.finish()];
}

/** 여러 줄 스타일 복사(이 도면에 같은 이름이 있으면 그것, 없으면 ACAD_MLINESTYLE 사전에 새로) */
class MLineStyleCopier {
  private readonly ops: EditOp[] = [];
  private readonly done = new Map<string, { name: string; handle: string }>();
  private dict: { before: DictionaryObject; after: DictionaryObject } | null = null;

  constructor(
    private readonly src: CadDocument,
    private readonly dst: CadDocument,
    private readonly copier: DefinitionCopier,
    private readonly newHandle: () => string,
  ) {}

  /** 원본 객체 e가 쓰던 스타일을 이 도면의 것으로 c에 잇는다 */
  relink(c: MLineEntity, e: MLineEntity): void {
    const srcStyle = listMLineStyles(this.src).find((s) => (e.styleHandle && normalizeHandle(s.style.handle) === normalizeHandle(e.styleHandle)) || tableKey(s.name) === tableKey(e.styleName));
    if (!srcStyle) return;
    const r = this.style(srcStyle.name, srcStyle.style);
    if (!r) return;
    c.styleName = r.name;
    c.styleHandle = r.handle;
  }

  private style(name: string, s: MLineStyleObject): { name: string; handle: string } | null {
    const k = tableKey(name);
    const memo = this.done.get(k);
    if (memo) return memo;
    const have = listMLineStyles(this.dst).find((x) => tableKey(x.name) === k);
    if (have) {
      const r = { name: have.name, handle: have.style.handle };
      this.done.set(k, r);
      return r;
    }
    const dict = mlineStyleDictionary(this.dst);
    if (!dict) return null;
    const h = this.newHandle();
    const copy: MLineStyleObject = {
      ...structuredClone(s),
      handle: h,
      owner: dict.handle,
      reactors: [dict.handle],
      elements: s.elements.map((el) => ({ ...el, color: { ...el.color }, linetype: this.copier.linetype(el.linetype) ?? 'BYLAYER' })),
    };
    delete copy.xdict;
    delete copy.dwgRaw;
    delete copy.xdata;
    this.ops.push({ kind: 'object', key: h, before: null, after: copy });
    if (!this.dict) this.dict = { before: dict, after: { ...dict, entries: new Map(dict.entries) } };
    this.dict.after.entries.set(name, h);
    const r = { name, handle: h };
    this.done.set(k, r);
    return r;
  }

  finish(): EditOp[] {
    const out = [...this.ops];
    if (this.dict) out.push({ kind: 'object', key: this.dict.before.handle, before: this.dict.before, after: this.dict.after });
    return out;
  }
}
