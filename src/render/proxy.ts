/**
 * 프록시 그림(ODA 공개 명세 29장 "Proxy Entity Graphics") 해석.
 * 구조: RL 전체 크기, RL 묶음 수, 묶음 = [RL 크기(크기·종류 포함), RL 종류, 자료…]. 자료는 4바이트 경계로 채운다.
 * 결과는 그리기 단위(primitive)와 하위 속성 변경의 목록이다. 좌표는 WCS(변환 행렬 묶음이 있으면 그 안).
 */

export type ProxyPrim =
  | { k: 'poly'; pts: number[]; closed: boolean; fill: boolean }
  | { k: 'circle'; c: [number, number, number]; r: number; n: [number, number, number] }
  | { k: 'arc'; c: [number, number, number]; r: number; n: [number, number, number]; start: [number, number, number]; sweep: number; closed: number }
  | { k: 'arc3'; p: [number, number, number][]; closed: number }
  | { k: 'circle3'; p: [number, number, number][] }
  | { k: 'text'; at: [number, number, number]; n: [number, number, number]; dir: [number, number, number]; text: string; height: number; width: number; oblique: number }
  | { k: 'xline'; a: [number, number, number]; b: [number, number, number]; ray: boolean }
  | { k: 'color'; aci: number }
  | { k: 'rgb'; rgb: number }
  | { k: 'lineweight'; lw: number }
  | { k: 'fill'; on: boolean }
  | { k: 'push'; m: number[] }
  | { k: 'pop' };

export interface ProxyParse {
  prims: ProxyPrim[];
  /** 해석하지 못한 묶음 종류 → 수 */
  skipped: Map<number, number>;
}

/** 프록시 그림 바이트를 해석한다. 잘못된 자료면 읽은 데까지 */
export function parseProxyGraphics(data: Uint8Array, decode: (b: Uint8Array) => string = latin1): ProxyParse {
  const out: ProxyParse = { prims: [], skipped: new Map() };
  if (data.length < 8) return out;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const total = Math.min(dv.getUint32(0, true), data.length);
  const count = dv.getUint32(4, true);
  let p = 8;
  const fill = { on: false };
  for (let n = 0; n < count && p + 8 <= total; n++) {
    const size = dv.getUint32(p, true);
    const type = dv.getUint32(p + 4, true);
    if (size < 8 || p + size > total) break;
    const end = p + size;
    let q = p + 8;
    const rl = () => {
      const v = dv.getInt32(q, true);
      q += 4;
      return v;
    };
    const rd = () => {
      const v = dv.getFloat64(q, true);
      q += 8;
      return v;
    };
    const p3 = (): [number, number, number] => [rd(), rd(), rd()];
    /** 0으로 끝나는 문자열, 4바이트 경계 */
    const ps = (wide: boolean): string => {
      const start = q;
      let e = q;
      if (wide) {
        while (e + 1 < end && (data[e] !== 0 || data[e + 1] !== 0)) e += 2;
        const s = new TextDecoder('utf-16le').decode(data.subarray(start, e));
        q = e + 2;
        q = start + Math.ceil((q - start) / 4) * 4;
        return s;
      }
      while (e < end && data[e] !== 0) e++;
      const s = decode(data.subarray(start, e));
      q = e + 1;
      q = start + Math.ceil((q - start) / 4) * 4;
      return s;
    };
    try {
      switch (type) {
        case 1: // 범위
          break;
        case 2: {
          const c = p3();
          const r = rd();
          out.prims.push({ k: 'circle', c, r, n: p3() });
          break;
        }
        case 3:
          out.prims.push({ k: 'circle3', p: [p3(), p3(), p3()] });
          break;
        case 4: {
          const c = p3();
          const r = rd();
          const nrm = p3();
          const start = p3();
          const sweep = rd();
          out.prims.push({ k: 'arc', c, r, n: nrm, start, sweep, closed: rl() });
          break;
        }
        case 5:
          out.prims.push({ k: 'arc3', p: [p3(), p3(), p3()], closed: rl() });
          break;
        case 6:
        case 7:
        case 32: {
          const np = rl();
          if (np < 0 || np > 1e6) break;
          const pts: number[] = [];
          for (let i = 0; i < np; i++) pts.push(rd(), rd(), rd());
          out.prims.push({ k: 'poly', pts, closed: type === 7, fill: type === 7 && fill.on });
          break;
        }
        case 8: {
          // 메시: 격자 모서리
          const rows = rl();
          const cols = rl();
          if (rows <= 0 || cols <= 0 || rows * cols > 1e6) break;
          const v: number[][] = [];
          for (let i = 0; i < rows * cols; i++) v.push([rd(), rd(), rd()]);
          for (let r = 0; r < rows; r++) {
            const line: number[] = [];
            for (let c = 0; c < cols; c++) line.push(...v[r * cols + c]!);
            out.prims.push({ k: 'poly', pts: line, closed: false, fill: false });
          }
          for (let c = 0; c < cols; c++) {
            const line: number[] = [];
            for (let r = 0; r < rows; r++) line.push(...v[r * cols + c]!);
            out.prims.push({ k: 'poly', pts: line, closed: false, fill: false });
          }
          break;
        }
        case 9: {
          // 셸: 면 목록(음수 = 뒤따르는 꼭짓점 수)
          const nv = rl();
          if (nv < 0 || nv > 1e6) break;
          const v: number[][] = [];
          for (let i = 0; i < nv; i++) v.push([rd(), rd(), rd()]);
          const nf = rl();
          let i = 0;
          while (i < nf && q + 4 <= end) {
            const cnt = Math.abs(rl());
            i++;
            const pts: number[] = [];
            for (let k = 0; k < cnt && i < nf; k++, i++) {
              const idx = rl();
              const pt = v[idx];
              if (pt) pts.push(...pt);
            }
            if (pts.length >= 6) out.prims.push({ k: 'poly', pts, closed: true, fill: fill.on });
          }
          break;
        }
        case 10:
        case 36: {
          const at = p3();
          const n3 = p3();
          const dir = p3();
          const height = rd();
          const width = rd();
          const oblique = rd();
          const text = ps(type === 36);
          out.prims.push({ k: 'text', at, n: n3, dir, text, height, width, oblique });
          break;
        }
        case 11:
        case 38: {
          const at = p3();
          const n3 = p3();
          const dir = p3();
          const text = ps(type === 38);
          rl(); // 길이
          rl(); // raw
          const height = rd();
          const width = rd();
          const oblique = rd();
          out.prims.push({ k: 'text', at, n: n3, dir, text, height, width, oblique });
          break;
        }
        case 12:
        case 13:
          out.prims.push({ k: 'xline', a: p3(), b: p3(), ray: type === 13 });
          break;
        case 14: {
          // 색: 하위 바이트가 ACI(0 블록별, 256 도면층별)
          const c = rl();
          out.prims.push({ k: 'color', aci: c & 0xffff });
          break;
        }
        case 20:
          fill.on = rl() !== 0;
          out.prims.push({ k: 'fill', on: fill.on });
          break;
        case 22: {
          const r = data[q]!;
          const g = data[q + 1]!;
          const b = data[q + 2]!;
          out.prims.push({ k: 'rgb', rgb: (r << 16) | (g << 8) | b });
          break;
        }
        case 23:
          out.prims.push({ k: 'lineweight', lw: rl() });
          break;
        case 29:
        case 30: {
          const m: number[] = [];
          for (let i = 0; i < 16; i++) m.push(rd());
          out.prims.push({ k: 'push', m });
          break;
        }
        case 31:
          out.prims.push({ k: 'pop' });
          break;
        case 16: // 도면층 번호
        case 18: // 선종류 번호
        case 19: // 표지
        case 24: // 선종류 축척
        case 25: // 두께
        case 26: // 플롯 스타일
        case 27: // 자르기 시작
        case 28: // 자르기 끝
          break;
        default:
          out.skipped.set(type, (out.skipped.get(type) ?? 0) + 1);
      }
    } catch {
      out.skipped.set(type, (out.skipped.get(type) ?? 0) + 1);
    }
    p = end;
  }
  return out;
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  return s;
}
