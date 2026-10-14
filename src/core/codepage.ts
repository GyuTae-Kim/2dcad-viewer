/**
 * 도면 코드 페이지 이름($DWGCODEPAGE)과 TextDecoder 인코딩 이름.
 * R2007 이전 DXF·DWG의 문자열은 이 코드 페이지로 저장된다.
 */

/** DWG 헤더의 코드 페이지 번호 → DXF 이름 */
const DWG_CODEPAGES: string[] = [
  'UTF8', // 0
  'US_ASCII',
  'ISO_8859_1',
  'ISO_8859_2',
  'ISO_8859_3',
  'ISO_8859_4',
  'ISO_8859_5',
  'ISO_8859_6',
  'ISO_8859_7',
  'ISO_8859_8',
  'ISO_8859_9', // 10
  'DOS437',
  'DOS850',
  'DOS852',
  'DOS855',
  'DOS857',
  'DOS860',
  'DOS861',
  'DOS863',
  'DOS864',
  'DOS865', // 20
  'DOS869',
  'DOS932',
  'MACINTOSH',
  'BIG5',
  'KSC5601',
  'JOHAB',
  'DOS866',
  'ANSI_1250',
  'ANSI_1251',
  'ANSI_1252', // 30
  'GB2312',
  'ANSI_1253',
  'ANSI_1254',
  'ANSI_1255',
  'ANSI_1256',
  'ANSI_1257',
  'ANSI_874',
  'ANSI_932',
  'ANSI_936',
  'ANSI_949', // 40
  'ANSI_950',
  'ANSI_1361',
  'ANSI_1200',
  'ANSI_1258',
];

export function dwgCodepageName(n: number): string {
  return DWG_CODEPAGES[n] ?? 'ANSI_1252';
}

/** 코드 페이지 이름 → WHATWG 인코딩 이름(TextDecoder가 받는 이름). 모르는 이름은 windows-1252. */
export function codepageToEncoding(name: string): string {
  const n = name.trim().toUpperCase().replace(/-/g, '_');
  const ansi = /^ANSI_(\d+)$/.exec(n);
  if (ansi) {
    const cp = Number(ansi[1]);
    if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
    switch (cp) {
      case 874:
        return 'windows-874';
      case 932:
        return 'shift_jis';
      case 936:
        return 'gbk';
      case 949:
        return 'euc-kr';
      case 950:
        return 'big5';
      case 1361:
        return 'euc-kr';
      case 1200:
        return 'utf-16le';
      default:
        return 'windows-1252';
    }
  }
  const iso = /^ISO_?8859_?(\d+)$/.exec(n);
  if (iso) return `iso-8859-${iso[1]}`;
  switch (n) {
    case 'UTF8':
    case 'UTF_8':
      return 'utf-8';
    case 'DOS932':
      return 'shift_jis';
    case 'KSC5601':
    case 'JOHAB':
      return 'euc-kr';
    case 'BIG5':
      return 'big5';
    case 'GB2312':
      return 'gbk';
    case 'DOS866':
      return 'ibm866';
    case 'MACINTOSH':
      return 'macintosh';
    default:
      return 'windows-1252';
  }
}

const decoders = new Map<string, TextDecoder>();

export function decoderFor(encoding: string): TextDecoder {
  let d = decoders.get(encoding);
  if (!d) {
    try {
      d = new TextDecoder(encoding);
    } catch {
      d = new TextDecoder('windows-1252');
    }
    decoders.set(encoding, d);
  }
  return d;
}

/** 큰 글꼴 문자 \M+Nxxxx의 N(1..5) → 인코딩 */
export function mifEncoding(n: number): string {
  switch (n) {
    case 1:
      return 'shift_jis';
    case 2:
      return 'big5';
    case 3:
      return 'euc-kr';
    case 4:
      return 'euc-kr';
    case 5:
      return 'gbk';
    default:
      return 'windows-1252';
  }
}

/** "\U+XXXX"와 "\M+Nxxxx" 이스케이프를 문자로 바꾼다. MTEXT 서식 코드는 그대로 둔다. */
export function decodeCadEscapes(s: string): string {
  if (s.indexOf('\\') < 0) return s;
  return s.replace(/\\U\+([0-9A-Fa-f]{4})|\\M\+([1-5])([0-9A-Fa-f]{4})/g, (m, u: string, n: string, mb: string) => {
    if (u) return String.fromCharCode(parseInt(u, 16));
    const code = parseInt(mb, 16);
    const bytes = new Uint8Array([code >> 8, code & 0xff]);
    try {
      return decoderFor(mifEncoding(Number(n))).decode(bytes);
    } catch {
      return m;
    }
  });
}
