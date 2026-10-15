/**
 * 큰 도면 단계별 측정(개발 전용). 워커가 하는 일(읽기 → 글꼴 → 장면 만들기 → 메인으로 보내기)을 Node에서 따라 한다.
 *
 * 사용법(단계마다 깨끗한 최대 메모리를 보려면 파일마다 새 프로세스로):
 *   NODE_OPTIONS="--expose-gc --max-old-space-size=8192" npx vite-node scripts/perf/measure.ts <도면> [--no-scene] [--no-clone] [--no-old] [--partial] [--each] [--hash] [--save dxf|dwg]
 *
 * 출력: 한 줄 JSON
 * - readMs·sceneMs·cloneSceneMs: 단계 시간
 * - partials: --partial이면 점진 빌드 조각 수·첫 조각까지 ms·조각 바이트(MB, 1280×800 첫 화면에서 보이지 않을 것을 뺀 양)
 * - drawsFullBefore·drawsFullAfter: 전체 보기 선·채우기 그리기 호출 수(묶음마다 → 묶음 무리)
 * - cloneDocCpu: 예전 방식(문서 통째 구조화 복제, --no-old면 생략), docSendCpu·docRecvCpu: 지금 방식(껍데기 + codec 묶음)의 워커 쪽·메인 쪽, docRecvWorstMs: 메인이 메시지 하나에 멈추는 가장 긴 시간
 * - heapAfterRead·heapAfterScene: GC 뒤 남은 JS 힙(MB) — 문서·장면이 실제로 차지하는 양
 * - peakRss: 프로세스 최대 상주 메모리(MB, 단계 누적 최대)
 * - sceneBuffers: 장면 표시 목록의 ArrayBuffer 합(MB, 힙 밖)
 * - hash: --hash면 문서 다시 쓰기(DXF) 결과와 장면 버퍼의 지문(고치기 전후 결과가 같은지 비교)
 */
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { PerformanceObserver, constants as perfConstants } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readCadFile } from '../../src/io/index';
import { buildSpace } from '../../src/render/build';
import { OutlineLibrary } from '../../src/text/fonts';
import { TextEngine } from '../../src/text/layout';
import { collectTextUsage } from '../../src/text/collect';
import type { DisplayList } from '../../src/render/displaylist';

const MB = 1048576;
const gc = (globalThis as { gc?: () => void }).gc;

function heapMB(): number {
  gc?.();
  gc?.();
  return Math.round(process.memoryUsage().heapUsed / MB);
}

/** GC 뒤 힙 밖 ArrayBuffer(MB) */
function buffersMB(): number {
  gc?.();
  return Math.round(process.memoryUsage().arrayBuffers / MB);
}

/** GC 기록: 주 GC(mark-compact) 횟수와 GC 시간 합(ms). 단계마다 차이로 본다 */
const gcStat = { major: 0, minor: 0, ms: 0 };
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const kind = (e as unknown as { detail?: { kind?: number } }).detail?.kind;
    if (kind === perfConstants.NODE_PERFORMANCE_GC_MAJOR) gcStat.major++;
    else gcStat.minor++;
    gcStat.ms += e.duration;
  }
}).observe({ entryTypes: ['gc'] });
const gcMark = () => ({ ...gcStat });
const gcSince = (m: typeof gcStat) => ({ major: gcStat.major - m.major, minor: gcStat.minor - m.minor, ms: Math.round(gcStat.ms - m.ms) });

/** 지금까지 쓴 CPU 시간(ms, 사용자 + 시스템) — 다른 일로 기계가 바쁠 때 벽시계 시간보다 덜 흔들린다 */
function cpuMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

function peakRssMB(): number {
  return Math.round(process.resourceUsage().maxRSS / 1024);
}

function sceneBytes(dl: DisplayList): number {
  let n = 0;
  for (const c of dl.chunks) n += c.segs.byteLength + c.tris.byteLength + c.tsegs.byteLength + c.ttris.byteLength;
  n += dl.glyphs.instances.byteLength + dl.glyphs.fillVerts.byteLength + dl.glyphs.strokeSegs.byteLength;
  return n;
}

function sceneHash(dl: DisplayList): string {
  const h = createHash('sha1');
  for (const c of dl.chunks) {
    h.update(`${c.key}|${c.ox}|${c.oy}|${c.minX}|${c.minY}|${c.maxX}|${c.maxY}|${c.segCount}|${c.triCount}|${c.tsegCount}|${c.ttriCount}`);
    h.update(new Uint8Array(c.segs));
    h.update(new Uint8Array(c.tris));
    h.update(new Uint8Array(c.tsegs));
    h.update(new Uint8Array(c.ttris));
  }
  h.update(new Uint8Array(dl.glyphs.instances));
  h.update(new Uint8Array(dl.glyphs.fillVerts.buffer, dl.glyphs.fillVerts.byteOffset, dl.glyphs.fillVerts.byteLength));
  h.update(new Uint8Array(dl.glyphs.strokeSegs.buffer, dl.glyphs.strokeSegs.byteOffset, dl.glyphs.strokeSegs.byteLength));
  h.update(JSON.stringify(dl.glyphs.runs));
  h.update(JSON.stringify(dl.glyphs.glyphs));
  // 빈 범위([시작, 0])는 없는 것과 같게 본다
  for (const b of dl.entities) h.update(`${b.handle},${b.minX},${b.minY},${b.maxX},${b.maxY},${b.chunk},${normalizedRange(b.seg)},${normalizedRange(b.tseg)},${normalizedRange(b.tri)},${normalizedRange(b.ttri)},${b.glyphs ?? ''};`);
  h.update(JSON.stringify([dl.minX, dl.minY, dl.maxX, dl.maxY, dl.xlines, dl.xlineHandles, dl.dashed ?? false]));
  return h.digest('hex').slice(0, 16);
}

function normalizedRange(r: [number, number] | undefined): string {
  return r && r[1] ? `${r[0]}+${r[1]}` : '';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--') && !['dxf', 'dwg'].includes(a));
  if (!file) throw new Error('도면 경로가 필요합니다');
  const noScene = argv.includes('--no-scene');
  // --legacy: 예전 문자열 토큰화기로 읽는다(DXF만, 결과 비교용)
  const legacy = argv.includes('--legacy');
  const noClone = argv.includes('--no-clone');
  const wantHash = argv.includes('--hash');
  const si = argv.indexOf('--save');
  const save = si >= 0 ? argv[si + 1] : undefined;
  const out: Record<string, unknown> = { file: file.split('/').pop(), load: +loadavg()[0]!.toFixed(1) };
  out.heapStart = heapMB();

  let data: Uint8Array | null = new Uint8Array(readFileSync(file));
  out.fileMB = +(data.byteLength / MB).toFixed(1);

  // 1. 읽기
  let t = performance.now();
  let c = cpuMs();
  let g = gcMark();
  let doc;
  if (legacy) {
    const { readDxf } = await import('../../src/io/dxf/reader');
    const { restoreArcTexts } = await import('../../src/io/arctext');
    const { restoreAnnoDimScales } = await import('../../src/io/annoscale');
    doc = readDxf(data, { legacyText: true });
    restoreArcTexts(doc);
    restoreAnnoDimScales(doc);
  } else doc = readCadFile(data, file);
  out.readMs = Math.round(performance.now() - t);
  out.readCpu = Math.round(cpuMs() - c);
  await new Promise((r) => setTimeout(r, 50));
  out.readGc = gcSince(g);
  out.peakRssRead = peakRssMB();
  data = null;
  out.entities = doc.entityIndex.size;
  out.heapAfterRead = heapMB();
  out.buffersAfterRead = buffersMB();
  out.warnings = doc.warnings.map((w) => `${w.code}${w.count ? ':' + w.count : ''}`);

  if (wantHash) {
    const { writeDxf } = await import('../../src/io/dxf/writer');
    t = performance.now();
    const w = writeDxf(doc, {});
    out.writeDxfMs = Math.round(performance.now() - t);
    out.dxfHash = createHash('sha1').update(w.data).digest('hex').slice(0, 16);
  }
  if (save === 'dwg') {
    const { writeDwg } = await import('../../src/io/dwg/index');
    t = performance.now();
    const w = writeDwg(doc, { version: 'AC1032' });
    out.writeDwgMs = Math.round(performance.now() - t);
    out.dwgMB = +(w.data.byteLength / MB).toFixed(1);
    if (wantHash) out.dwgHash = createHash('sha1').update(w.data).digest('hex').slice(0, 16);
  } else if (save === 'dxf' && !wantHash) {
    const { writeDxf } = await import('../../src/io/dxf/writer');
    t = performance.now();
    const w = writeDxf(doc, {});
    out.writeDxfMs = Math.round(performance.now() - t);
  }

  // 2. 메인으로 문서 보내기
  if (!noClone) {
    // 예전 방식: 문서 통째 구조화 복제(비교용, --no-old면 건너뜀)
    if (!argv.includes('--no-old')) {
      t = performance.now();
      c = cpuMs();
      let copy: unknown = structuredClone(doc);
      out.cloneDocMs = Math.round(performance.now() - t);
      out.cloneDocCpu = Math.round(cpuMs() - c);
      out.heapWithDocCopy = heapMB();
      copy = null;
      void copy;
    }
    // 지금: 껍데기 + 큰 블록 객체 묶음(codec). 워커 쪽(부호화 + 직렬화)과 메인 쪽(역직렬화 + 풀기)을 나눠 잰다
    const { serialize, deserialize } = await import('node:v8');
    const { sendDocument, DocAssembler } = await import('../../src/worker/doctransfer');
    // postMessage 흉내: 형식 배열은 옮기므로(transfer) 직렬화하지 않고 그대로 넘기고, 나머지(문자열 표·모양·껍데기)만 직렬화
    const msgs: { bytes: Buffer; enc?: import('../../src/worker/codec').Encoded }[] = [];
    c = cpuMs();
    t = performance.now();
    sendDocument(
      doc,
      (d, streamed) => msgs.push({ bytes: serialize({ doc: d, streamed }) }),
      (part) => msgs.push({ bytes: serialize({ ...part, enc: part.enc && { strs: part.enc.strs, shapes: part.enc.shapes } }), enc: part.enc }),
    );
    out.docSendMs = Math.round(performance.now() - t);
    out.docSendCpu = Math.round(cpuMs() - c);
    out.docParts = msgs.length - 1;
    c = cpuMs();
    t = performance.now();
    let worst = 0;
    const each: number[] = [];
    let asm: InstanceType<typeof DocAssembler> | null = null;
    let main: unknown = null;
    for (const m of msgs) {
      const t1 = performance.now();
      const v = deserialize(m.bytes);
      if (m.enc) v.enc = { ...m.enc, strs: v.enc.strs, shapes: v.enc.shapes };
      if (!asm && !main) {
        if (v.streamed.length) asm = new DocAssembler(v.doc, v.streamed);
        else main = v.doc;
      } else asm!.add(v);
      worst = Math.max(worst, performance.now() - t1);
      each.push(Math.round(performance.now() - t1));
    }
    if (argv.includes('--each')) out.docRecvEach = each;
    msgs.length = 0;
    out.docRecvMs = Math.round(performance.now() - t);
    out.docRecvCpu = Math.round(cpuMs() - c);
    // 메인이 한 번에 멈추는 가장 긴 시간(메시지 하나 처리)
    out.docRecvWorstMs = Math.round(worst);
    if (!argv.includes('--no-old')) out.heapWithDocParts = heapMB();
    asm = null;
    main = null;
    void main;
    out.peakRssClone = peakRssMB();
  }

  if (!noScene) {
    // 3. 글꼴(워커처럼 필요한 글자만)
    const fontDir = resolve('public/fonts/noto-sans-kr') + '/';
    const lib = new OutlineLibrary(fontDir, async (url) => {
      const b = readFileSync(url);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    });
    t = performance.now();
    const usage = collectTextUsage(doc);
    if (usage.needsOutline) await Promise.all([lib.require(usage.codes), lib.requireLatin(usage.latin)]);
    out.fontMs = Math.round(performance.now() - t);
    const text = new TextEngine(lib);

    // 4. 장면 만들기
    t = performance.now();
    c = cpuMs();
    g = gcMark();
    // 워커처럼 상자를 형식 배열로 만든다(있으면). 지문·전송 흉내는 아래에서 푼다
    // --partial: 워커처럼 점진 빌드 조각을 만든다(1280×800 화면의 첫 화면 기준, 조각 수·첫 조각까지 시간·조각 바이트)
    const parts = { n: 0, firstMs: 0, MB: 0 };
    const tb = performance.now();
    let partialView: { origin: [number, number]; rect?: [number, number, number, number]; pxPerUnit?: number } | undefined;
    if (argv.includes('--partial')) {
      const { planPreview } = await import('../../src/render/preview');
      const plan = planPreview(doc, '*Model_Space', 1280 / 800);
      partialView = { origin: [0, 0] };
      if (plan) {
        const [x0, y0, x1, y1] = plan.visible;
        const w = x1 - x0;
        const h = y1 - y0;
        partialView = { origin: [(x0 + x1) / 2, (y0 + y1) / 2], rect: [x0 - w / 2, y0 - h / 2, x1 + w / 2, y1 + h / 2], pxPerUnit: 1280 / w };
      }
    }
    const onPartial = partialView
      ? (p: { list: DisplayList }) => {
          if (!parts.n++) parts.firstMs = Math.round(performance.now() - tb);
          parts.MB += sceneBytes(p.list) / MB;
        }
      : undefined;
    const s = buildSpace(doc, '*Model_Space', { text, packBoxes: true, onPartial, partialView } as Parameters<typeof buildSpace>[2]);
    if (onPartial) out.partials = { ...parts, MB: Math.round(parts.MB) };
    out.sceneMs = Math.round(performance.now() - t);
    out.sceneCpu = Math.round(cpuMs() - c);
    // GC 기록은 비동기로 오므로 한 번 쉬었다가 센다
    await new Promise((r) => setTimeout(r, 50));
    out.sceneGc = gcSince(g);
    out.peakRssScene = peakRssMB();
    const dl = s.list;
    const packedList = (dl as { packed?: unknown }).packed;
    out.chunks = dl.chunks.length;
    // 전체 보기 그리기 호출(선·채우기): 묶음마다 vs 묶음 무리(chunkgroups)
    {
      const { planChunkGroups } = await import('../../src/render/chunkgroups');
      const kinds = (c: { segCount: number; triCount: number; tsegCount: number; ttriCount: number }) => +!!c.segCount + +!!c.triCount + +!!c.tsegCount + +!!c.ttriCount;
      out.drawsFullBefore = dl.chunks.reduce((a, c) => a + kinds(c), 0);
      const plan = planChunkGroups(dl.chunks);
      if (plan) {
        let d = 0;
        for (const g of plan.groups) {
          const sum = { segCount: 0, triCount: 0, tsegCount: 0, ttriCount: 0 };
          for (const m of g.members) {
            const c = dl.chunks[m]!;
            sum.segCount += c.segCount;
            sum.triCount += c.triCount;
            sum.tsegCount += c.tsegCount;
            sum.ttriCount += c.ttriCount;
          }
          d += kinds(sum);
        }
        dl.chunks.forEach((c, i) => {
          if (plan.groupOf[i]! < 0) d += kinds(c);
        });
        out.groups = plan.groups.length;
        out.groupSize = plan.size;
        out.drawsFullAfter = d;
      }
    }
    out.segs = dl.chunks.reduce((a, c) => a + c.segCount + c.tsegCount, 0);
    out.tris = dl.chunks.reduce((a, c) => a + c.triCount + c.ttriCount, 0);
    out.glyphInstances = dl.glyphs.instanceCount;
    out.boxes = packedList ? (packedList as { count: number }).count : dl.entities.length;
    out.sceneBuffersMB = +(sceneBytes(dl) / MB).toFixed(1);
    out.heapAfterScene = heapMB();
    out.sceneWarnings = s.warnings;
    if (wantHash) {
      const { unpackBoxes } = await import('../../src/render/displaylist');
      out.sceneHash = sceneHash(packedList ? { ...dl, entities: unpackBoxes(packedList as Parameters<typeof unpackBoxes>[0]) } : dl);
    }

    // 5. 장면 보내기: 워커처럼(packBoxes가 있으면 상자를 묶어) 옮기고, 메인처럼 푼다
    if (!noClone) {
      const mod = (await import('../../src/render/displaylist')) as typeof import('../../src/render/displaylist') & { packBoxes?: (b: unknown) => { bounds: Float64Array; ranges: Int32Array; glyphs: Int32Array }; unpackBoxes?: (p: unknown) => unknown[] };
      t = performance.now();
      c = cpuMs();
      const transfer: Transferable[] = mod.transferables(dl);
      let boxes: ReturnType<NonNullable<typeof mod.packBoxes>> | undefined;
      if (packedList) boxes = packedList as typeof boxes;
      else if (mod.packBoxes) boxes = mod.packBoxes(dl.entities);
      if (boxes) {
        (dl as { packed?: unknown }).packed = undefined;
        dl.entities = [];
        transfer.push(boxes.bounds.buffer as ArrayBuffer, boxes.ranges.buffer as ArrayBuffer, boxes.glyphs.buffer as ArrayBuffer);
      }
      const msg = { list: dl, boxes, styles: s.styles.specs, layers: s.layers, layerIndex: [...s.layerIndex.entries()], warnings: s.warnings };
      const copy = structuredClone(msg, { transfer });
      if (copy.boxes && mod.unpackBoxes) copy.list.entities = mod.unpackBoxes(copy.boxes) as typeof dl.entities;
      out.cloneSceneMs = Math.round(performance.now() - t);
      out.cloneSceneCpu = Math.round(cpuMs() - c);
      out.boxesAfter = copy.list.entities.length;
    }
  }
  out.peakRss = peakRssMB();
  out.loadEnd = +loadavg()[0]!.toFixed(1);
  console.log(JSON.stringify(out));
}

main().catch((e) => {
  console.log(JSON.stringify({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), peakRss: peakRssMB() }));
  process.exit(1);
});
