// Hershey Roman Simplex(공개 도메인, hersheytext 패키지의 JSON)를 뷰어의 단선 글꼴 데이터로 바꾼다.
// 사용법: node build_strokefont.mjs hersheytext.json src/text/strokefont-data.ts
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, out] = process.argv;
const json = JSON.parse(readFileSync(src, 'utf8'));
const font = json.futural;
const BASE = 22; // Hershey 좌표의 기준선 y
const glyphs = {};

function parsePath(d) {
  // "M9,1 L1,22 M9,1 L17,22" → [[[9,1],[1,22]], ...]
  const strokes = [];
  let cur = null;
  for (const tok of d.trim().split(/\s+/)) {
    let t = tok;
    if (t[0] === 'M') {
      cur = [];
      strokes.push(cur);
      t = t.slice(1);
    } else if (t[0] === 'L') {
      t = t.slice(1);
    }
    if (!t) continue;
    const [x, y] = t.split(',').map(Number);
    cur.push([x, BASE - y]);
  }
  return strokes.filter((s) => s.length > 1);
}

font.chars.forEach((c, i) => {
  const code = 33 + i;
  if (code > 126) return;
  glyphs[code] = { w: c.o * 2, s: parsePath(c.d) };
});
glyphs[32] = { w: 16, s: [] };

// Hershey에 없는 CAD 기호: °(%%d), ±(%%p), Ø(%%c)
const circle = (cx, cy, r, n = 16, a0 = 0, a1 = Math.PI * 2) => {
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    pts.push([Math.round((cx + r * Math.cos(a)) * 10) / 10, Math.round((cy + r * Math.sin(a)) * 10) / 10]);
  }
  return pts;
};
glyphs[0xb0] = { w: 10, s: [circle(5, 17, 3.5)] };
glyphs[0xb1] = { w: 18, s: [[[9, 17], [9, 3]], [[2, 10], [16, 10]], [[2, 0], [16, 0]]] };
glyphs[0xd8] = { w: 20, s: [circle(10, 10.5, 8, 24), [[2, -1], [18, 22]]] };
glyphs[0x2205] = glyphs[0xd8];
glyphs[0x2300] = glyphs[0xd8];
glyphs[0xb2] = { w: 10, s: [[[2, 18], [3, 20], [5, 21], [7, 20], [8, 18], [8, 17], [2, 12], [8, 12]]] };
glyphs[0xb3] = { w: 10, s: [[[2, 21], [8, 21], [5, 18], [7, 17.5], [8, 15.5], [7, 13], [5, 12], [3, 12.5], [2, 13.5]]] };
glyphs[0xb5] = { w: 19, s: [[[4, 14], [4, -7]], [[4, 10], [5, 3], [7, 1], [10, 0], [12, 1], [15, 4]], [[15, 14], [15, 0]]] };

const enc = (g) => g.s.map((st) => st.map(([x, y]) => `${x},${y}`).join(' ')).join(';');
const lines = Object.keys(glyphs)
  .map(Number)
  .sort((a, b) => a - b)
  .map((code) => `  [${code}, ${glyphs[code].w}, '${enc(glyphs[code])}'],`);

writeFileSync(
  out,
  `// 자동 생성 파일(scripts/fonts/build_strokefont.mjs). 직접 고치지 않는다.
// 원본: Hershey Roman Simplex. The Hershey Fonts were originally created by Dr. A. V. Hershey
// while working at the U. S. National Bureau of Standards. JSON 데이터는 hersheytext(MIT)에서 왔다.
// 좌표: 기준선 y = 0, 대문자 높이 21, 선은 ';'로, 점은 ' '로 나눈다.

export const STROKE_CAP_HEIGHT = 21;

/** [문자 코드, 전진 폭, 선 목록] */
export const STROKE_GLYPHS: [number, number, string][] = [
${lines.join('\n')}
];
`,
);
console.log('glyphs', Object.keys(glyphs).length);
