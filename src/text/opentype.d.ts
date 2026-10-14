// opentype.js 2.0에서 쓰는 부분만 선언한다.
declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'Q' | 'C' | 'Z';
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export interface Path {
    commands: PathCommand[];
  }
  export interface Glyph {
    index: number;
    unicode?: number;
    advanceWidth?: number;
    path: Path | (() => Path);
    getPath(x?: number, y?: number, fontSize?: number): Path;
  }
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    tables: { os2?: { sCapHeight?: number; sxHeight?: number } };
    charToGlyph(ch: string): Glyph;
    charToGlyphIndex(ch: string): number;
    hasChar(ch: string): boolean;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
