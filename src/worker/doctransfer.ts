/**
 * 워커 → 메인 문서 보내기.
 *
 * 문서를 통째로 구조화 복제하면 수백만 객체에서 메인 스레드가 수 초~수십 초 멈춘다.
 * 그래서 객체가 많은 블록(대개 모형 공간)의 객체 목록은 빼고 나머지(표·블록·배치·사전 — "껍데기")만 구조화 복제로 보내고,
 * 뺀 객체는 묶음마다 codec으로 부호화해 따로 보낸다. 메인은 묶음을 받는 대로 풀어 붙이고, 끝에 핸들 색인을 다시 만든다.
 *
 * 핸들 색인(entityIndex)은 finalizeDocument처럼 블록 순서·객체 순서(블록 참조의 속성 포함)로 다시 만든다.
 * 워커 문서의 색인이 그 순서·그 객체와 꼭 같을 때만 이렇게 하고, 아니면 예전처럼 문서 전체를 구조화 복제한다.
 */
import type { CadDocument, Entity } from '../core/model';
import { Decoder, Encoder, type Encoded, encodedTransfer, encoderScratch } from './codec';

/** 이보다 객체가 많은 블록만 따로 보낸다 */
const STREAM_MIN = 2000;
/** 한 묶음의 객체 수(메인에서 한 번에 푸는 시간이 수십 ms가 되게) */
const BATCH = 50000;

/** 따로 보내는 객체 묶음 하나 */
export interface DocPart {
  /** 블록 열쇠(doc.blocks의 키) */
  block: string;
  /** codec으로 부호화한 객체들 */
  enc?: Encoded;
  /** 부호화하지 못한 묶음은 그대로(구조화 복제) */
  entities?: Entity[];
}

/** 색인이 블록에서 다시 만든 것과 같은지(순서·객체 모두) */
function indexDerivable(doc: CadDocument): boolean {
  const it = doc.entityIndex.entries();
  const same = (e: Entity): boolean => {
    const n = it.next();
    return !n.done && n.value[0] === e.handle && n.value[1] === e;
  };
  for (const b of doc.blocks.values())
    for (const e of b.entities) {
      if (e.handle && !same(e)) return false;
      if (e.type === 'INSERT') for (const a of e.attribs) if (a.handle && !same(a)) return false;
    }
  return !!it.next().done;
}

/**
 * 문서를 메인으로 보낸다: post(껍데기 또는 문서 전체, 따로 보내는 블록과 객체 수)를 먼저 부르고, 이어서 묶음마다 part를 부른다.
 * minEntities·batch는 시험용.
 */
export function sendDocument(
  doc: CadDocument,
  post: (doc: CadDocument, streamed: [string, number][]) => void,
  part: (p: DocPart, transfer: Transferable[]) => void,
  onProgress?: (fraction: number) => void,
  opt: { minEntities?: number; batch?: number } = {},
): void {
  const min = opt.minEntities ?? STREAM_MIN;
  const size = opt.batch ?? BATCH;
  const big = [...doc.blocks].filter(([, b]) => b.entities.length >= min);
  if (!big.length || !indexDerivable(doc)) {
    post(doc, []);
    return;
  }
  const shell: CadDocument = {
    ...doc,
    blocks: new Map([...doc.blocks].map(([k, b]) => [k, b.entities.length >= min ? { ...b, entities: [] } : b])),
    entityIndex: new Map(),
  };
  const total = big.reduce((a, [, b]) => a + b.entities.length, 0);
  post(
    shell,
    big.map(([k, b]) => [k, b.entities.length]),
  );
  let done = 0;
  const scratch = encoderScratch();
  for (const [key, b] of big) {
    const list = b.entities;
    for (let i = 0; i < list.length; i += size) {
      const end = Math.min(list.length, i + size);
      const enc = new Encoder(scratch);
      let ok = true;
      for (let j = i; j < end && ok; j++) ok = enc.add(list[j]);
      if (ok) {
        const e = enc.finish();
        part({ block: key, enc: e }, encodedTransfer(e));
      } else part({ block: key, entities: list.slice(i, end) }, []);
      done += end - i;
      onProgress?.(done / total);
    }
  }
}

/**
 * 메인: 껍데기와 묶음을 모아 문서를 되살린다. 핸들 색인은 finalizeDocument와 같은 순서(블록 순서 → 객체 순서, 블록 참조 뒤에 그 속성)로
 * 묶음이 오는 대로 조금씩 채운다(끝에 한꺼번에 수백만 개를 넣지 않게).
 */
export class DocAssembler {
  /** 따로 오는 블록 → 남은 객체 수 */
  private readonly waiting = new Map<string, number>();
  private readonly blocks: [string, { entities: Entity[] }][];
  /** 색인을 다 채운 블록 수(doc.blocks 순서)와 그다음 블록에서 색인에 넣은 객체 수 */
  private indexed = 0;
  private cursor = 0;

  constructor(
    readonly doc: CadDocument,
    streamed: readonly [string, number][],
  ) {
    for (const [k, n] of streamed) if (n > 0) this.waiting.set(k, n);
    this.blocks = [...doc.blocks];
    doc.entityIndex.clear();
    this.advance();
  }

  get complete(): boolean {
    return this.waiting.size === 0;
  }

  /** 묶음 하나를 붙인다. 문서가 다 모였으면 true */
  add(p: DocPart): boolean {
    const b = this.doc.blocks.get(p.block);
    const left = this.waiting.get(p.block);
    if (!b || left === undefined) throw new Error(`기다리지 않는 블록 묶음입니다: ${p.block}`);
    const out = b.entities;
    const from = out.length;
    if (p.enc) {
      const d = new Decoder(p.enc);
      while (d.more()) out.push(d.next() as Entity);
    } else if (p.entities) for (const e of p.entities) out.push(e);
    const rest = left - (out.length - from);
    if (rest > 0) this.waiting.set(p.block, rest);
    else this.waiting.delete(p.block);
    this.advance();
    return this.complete;
  }

  /** 받은 데까지 앞 블록부터 색인을 채운다(아직 받는 블록에서 멈춘다 — 묶음은 블록 순서대로 온다) */
  private advance(): void {
    const index = this.doc.entityIndex;
    while (this.indexed < this.blocks.length) {
      const [k, b] = this.blocks[this.indexed]!;
      const list = b.entities;
      for (let i = this.cursor; i < list.length; i++) {
        const e = list[i]!;
        if (e.handle) index.set(e.handle, e);
        if (e.type === 'INSERT') for (const a of e.attribs) if (a.handle) index.set(a.handle, a);
      }
      this.cursor = list.length;
      if (this.waiting.has(k)) return;
      this.indexed++;
      this.cursor = 0;
    }
  }
}
