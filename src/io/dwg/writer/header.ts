/** AcDb:Header 쓰기(사양 9장, header.ts의 짝) */
import type { HeaderValue, Vec2, Vec3 } from '../../../core/model';
import { crc8 } from '../crc';
import { R2000, R2004, R2007, R2010, R2013, R2018 } from '../version';
import { BitWriter, type WColor } from './bitwriter';
import type { TextEncoderCp } from './codepage';
import { HARD_OWNER, HARD_PTR } from './objwriter';
import { lwIndex } from './util';

export const HEADER_SENTINEL = [0xcf, 0x7b, 0x1f, 0x23, 0xfd, 0xde, 0x38, 0xa9, 0x5f, 0x7c, 0x68, 0xb8, 0x4e, 0x6d, 0x33, 0x5f];
export const HEADER_END_SENTINEL = [0x30, 0x84, 0xe0, 0xdc, 0x02, 0x21, 0xc7, 0x56, 0xa0, 0x83, 0x97, 0x47, 0xb1, 0x92, 0xcc, 0xa0];

export interface HeaderRefs {
  blockControl: number;
  layerControl: number;
  styleControl: number;
  ltypeControl: number;
  viewControl: number;
  ucsControl: number;
  vportControl: number;
  appidControl: number;
  dimstyleControl: number;
  vpentControl: number;
  groupDict: number;
  mlineStyleDict: number;
  namedObjDict: number;
  layoutDict: number;
  plotSettingsDict: number;
  plotStyleDict: number;
  materialDict: number;
  colorDict: number;
  visualStyleDict: number;
  paperSpace: number;
  modelSpace: number;
  ltByLayer: number;
  ltByBlock: number;
  ltContinuous: number;
}

export interface HeaderInput {
  vars: Map<string, HeaderValue>;
  refs: HeaderRefs;
  handseed: number;
  /** 이름 핸들 변수($CLAYER 등) → 핸들(없으면 0) */
  handleVar(name: string): number;
  /** $CECOLOR(색상표 색이면 이름까지) */
  cecolor: WColor;
}

/** 헤더 기본값(AutoCAD acad.dwt 값, 사양의 기본값) */
const D: Record<string, HeaderValue> = {
  $DIMASO: 1,
  $DIMSHO: 1,
  $REGENMODE: 1,
  $FILLMODE: 1,
  $PSLTSCALE: 1,
  $USRTIMER: 1,
  $WORLDVIEW: 1,
  $TILEMODE: 1,
  $VISRETAIN: 1,
  $PROXYGRAPHICS: 1,
  $TREEDEPTH: 3020,
  $LUNITS: 2,
  $LUPREC: 4,
  $ATTMODE: 1,
  $SPLINESEGS: 8,
  $SURFU: 6,
  $SURFV: 6,
  $SURFTYPE: 6,
  $SURFTAB1: 6,
  $SURFTAB2: 6,
  $SPLINETYPE: 6,
  $SHADEDGE: 3,
  $SHADEDIF: 70,
  $MAXACTVP: 64,
  $ISOLINES: 4,
  $TEXTQLTY: 50,
  $LTSCALE: 1,
  $TEXTSIZE: 0.2,
  $TRACEWID: 0.05,
  $SKETCHINC: 0.1,
  $FACETRES: 0.5,
  $CMLSCALE: 1,
  $CELTSCALE: 1,
  $MENU: 'acad',
  $PEXTMIN: { x: 1e20, y: 1e20, z: 1e20 },
  $PEXTMAX: { x: -1e20, y: -1e20, z: -1e20 },
  $PLIMMAX: { x: 12, y: 9 },
  $PUCSXDIR: { x: 1, y: 0, z: 0 },
  $PUCSYDIR: { x: 0, y: 1, z: 0 },
  $EXTMIN: { x: 1e20, y: 1e20, z: 1e20 },
  $EXTMAX: { x: -1e20, y: -1e20, z: -1e20 },
  $LIMMAX: { x: 12, y: 9 },
  $UCSXDIR: { x: 1, y: 0, z: 0 },
  $UCSYDIR: { x: 0, y: 1, z: 0 },
  $DIMSCALE: 1,
  $DIMASZ: 0.18,
  $DIMEXO: 0.0625,
  $DIMDLI: 0.38,
  $DIMEXE: 0.18,
  $DIMFXL: 1,
  $DIMJOGANG: Math.PI / 4,
  $DIMTIH: 1,
  $DIMTOH: 1,
  $DIMTXT: 0.18,
  $DIMCEN: 0.09,
  $DIMALTF: 25.4,
  $DIMLFAC: 1,
  $DIMTFAC: 1,
  $DIMGAP: 0.09,
  $DIMALTD: 2,
  $DIMDEC: 4,
  $DIMTDEC: 4,
  $DIMALTU: 2,
  $DIMALTTD: 2,
  $DIMLUNIT: 2,
  $DIMDSEP: 46,
  $DIMTOLJ: 1,
  $DIMATFIT: 3,
  $DIMALTMZF: 100,
  $DIMMZF: 100,
  $DIMLWD: -2,
  $DIMLWE: -2,
  $TSTACKALIGN: 1,
  $TSTACKSIZE: 70,
  $CELWEIGHT: -1,
  $LWDISPLAY: 0,
  $XEDIT: 1,
  $EXTNAMES: 1,
  $INSUNITS: 0,
  $SORTENTS: 127,
  $HIDETEXT: 1,
  $XCLIPFRAME: 2,
  $DIMASSOC: 2,
  $OBSCOLOR: 257,
  $INTERSECTIONCOLOR: 257,
  $STEPSPERSEC: 2,
  $STEPSIZE: 6,
  $3DDWFPREC: 2,
  $LENSLENGTH: 50,
  $SHOWHIST: 1,
  $PSOLWIDTH: 0.25,
  $PSOLHEIGHT: 4,
  $LOFTANG1: Math.PI / 2,
  $LOFTANG2: Math.PI / 2,
  $LOFTPARAM: 7,
  $LOFTNORMALS: 1,
  $LATITUDE: 37.795,
  $LONGITUDE: -122.394,
  $TIMEZONE: -8000,
  $LIGHTGLYPHDISPLAY: 1,
  $TILEMODELIGHTSYNCH: 1,
  $DWFFRAME: 2,
  $REALWORLDSCALE: 1,
  $INTERFERECOLOR: 1,
};

/** 오늘 날짜(율리우스일) */
function julianNow(): number {
  return Date.now() / 86400000 + 2440587.5;
}

function guid(): string {
  const b = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(b);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
}

/** 헤더 섹션 바이트(시작·끝 표지, 크기, CRC 포함) */
export function writeHeader(ver: number, maintVer: number, enc: TextEncoderCp, inp: HeaderInput): Uint8Array {
  const vars = inp.vars;
  const dat = new BitWriter(ver, enc, 4096);
  const str = new BitWriter(ver, enc, 512);
  const hdl = ver >= R2007 ? new BitWriter(ver, enc, 512) : dat;
  if (ver >= R2007) dat.strWriter = str;

  const num = (name: string, def = 0): number => {
    const v = vars.get(name) ?? D[name];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    const d = D[name];
    return typeof d === 'number' ? d : def;
  };
  const text = (name: string): string => {
    const v = vars.get(name) ?? D[name];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    return '';
  };
  const pt = (name: string): Vec3 => {
    const v = (vars.get(name) ?? D[name]) as Partial<Vec3> | undefined;
    if (v && typeof v === 'object') return { x: Number(v.x) || 0, y: Number(v.y) || 0, z: Number(v.z) || 0 };
    return { x: 0, y: 0, z: 0 };
  };
  const pt2 = (name: string): Vec2 => {
    const p = pt(name);
    return { x: p.x, y: p.y };
  };
  const B = (n: string) => dat.B(num(n) ? 1 : 0);
  const BS = (n: string) => dat.BS(num(n));
  const BD = (n: string) => dat.BD(num(n));
  const BL = (n: string) => dat.BL(num(n));
  const RC = (n: string) => dat.RC(num(n));
  const P3 = (n: string) => dat.BD3(pt(n));
  const P2 = (n: string) => dat.RD2(pt2(n));
  const TV = (n: string) => dat.TV(text(n));
  const H = (n: string, code = HARD_PTR) => hdl.H(code, inp.handleVar(n));
  const HX = (n: string) => {
    const v = text(n);
    const h = /^[0-9A-Fa-f]+$/.test(v) ? parseInt(v, 16) : 0;
    hdl.H(HARD_PTR, h);
  };
  const CMC = (n: string) => dat.CMC({ index: num(n) });
  const JD = (n: string) => {
    let v = vars.get(n);
    if (typeof v !== 'number' || !Number.isFinite(v)) v = n === '$TDCREATE' || n === '$TDUPDATE' ? julianNow() : 0;
    const day = Math.floor(v);
    const ms = Math.round((v - day) * 86400000);
    dat.BL(day);
    dat.BL(Math.min(ms, 86399999));
  };

  let rlPos = -1;
  if (ver >= R2007) {
    rlPos = dat.pos;
    dat.RL(0);
  }
  if (ver >= R2013) dat.BLL(num('$REQUIREDVERSIONS'));
  dat.BD(412148564080.0);
  dat.BD(1);
  dat.BD(1);
  dat.BD(1);
  dat.TV('m');
  dat.TV('');
  dat.TV('');
  dat.TV('');
  dat.BL(24);
  dat.BL(0);
  if (ver < R2004) hdl.H(HARD_PTR, 0); // 현재 뷰포트 도형 헤더
  B('$DIMASO');
  B('$DIMSHO');
  B('$PLINEGEN');
  B('$ORTHOMODE');
  B('$REGENMODE');
  B('$FILLMODE');
  B('$QTEXTMODE');
  B('$PSLTSCALE');
  B('$LIMCHECK');
  if (ver >= R2004) dat.B(0);
  B('$USRTIMER');
  B('$SKPOLY');
  B('$ANGDIR');
  B('$SPLFRAME');
  B('$MIRRTEXT');
  B('$WORLDVIEW');
  B('$TILEMODE');
  B('$PLIMCHECK');
  B('$VISRETAIN');
  B('$DISPSILH');
  B('$PELLIPSE');
  BS('$PROXYGRAPHICS');
  BS('$TREEDEPTH');
  BS('$LUNITS');
  BS('$LUPREC');
  BS('$AUNITS');
  BS('$AUPREC');
  BS('$ATTMODE');
  BS('$PDMODE');
  if (ver >= R2004) {
    // 알 수 없는 값(AutoCAD 표본과 같은 값)
    dat.BL(808464432);
    dat.BL(486869248);
    dat.BL(1295333680);
  }
  for (const n of ['$USERI1', '$USERI2', '$USERI3', '$USERI4', '$USERI5', '$SPLINESEGS', '$SURFU', '$SURFV', '$SURFTYPE', '$SURFTAB1', '$SURFTAB2', '$SPLINETYPE', '$SHADEDGE', '$SHADEDIF', '$UNITMODE', '$MAXACTVP', '$ISOLINES', '$CMLJUST', '$TEXTQLTY']) BS(n);
  for (const n of ['$LTSCALE', '$TEXTSIZE', '$TRACEWID', '$SKETCHINC', '$FILLETRAD', '$THICKNESS', '$ANGBASE', '$PDSIZE', '$PLINEWID', '$USERR1', '$USERR2', '$USERR3', '$USERR4', '$USERR5', '$CHAMFERA', '$CHAMFERB', '$CHAMFERC', '$CHAMFERD', '$FACETRES', '$CMLSCALE', '$CELTSCALE']) BD(n);
  TV('$MENU');
  JD('$TDCREATE');
  JD('$TDUPDATE');
  if (ver >= R2004) {
    dat.BL(1295003696);
    dat.BL(486539264);
    dat.BL(808464432);
  }
  JD('$TDINDWG');
  JD('$TDUSRTIMER');
  dat.CMC(inp.cecolor);
  dat.H(0, inp.handseed);
  H('$CLAYER');
  H('$TEXTSTYLE');
  H('$CELTYPE');
  if (ver >= R2007) HX('$CMATERIAL');
  H('$DIMSTYLE');
  H('$CMLSTYLE');
  BD('$PSVPSCALE');
  P3('$PINSBASE');
  P3('$PEXTMIN');
  P3('$PEXTMAX');
  P2('$PLIMMIN');
  P2('$PLIMMAX');
  BD('$PELEVATION');
  P3('$PUCSORG');
  P3('$PUCSXDIR');
  P3('$PUCSYDIR');
  H('$PUCSNAME');
  H('$PUCSORTHOREF');
  BS('$PUCSORTHOVIEW');
  H('$PUCSBASE');
  P3('$PUCSORGTOP');
  P3('$PUCSORGBOTTOM');
  P3('$PUCSORGLEFT');
  P3('$PUCSORGRIGHT');
  P3('$PUCSORGFRONT');
  P3('$PUCSORGBACK');
  P3('$INSBASE');
  P3('$EXTMIN');
  P3('$EXTMAX');
  P2('$LIMMIN');
  P2('$LIMMAX');
  BD('$ELEVATION');
  P3('$UCSORG');
  P3('$UCSXDIR');
  P3('$UCSYDIR');
  H('$UCSNAME');
  H('$UCSORTHOREF');
  BS('$UCSORTHOVIEW');
  H('$UCSBASE');
  P3('$UCSORGTOP');
  P3('$UCSORGBOTTOM');
  P3('$UCSORGLEFT');
  P3('$UCSORGRIGHT');
  P3('$UCSORGFRONT');
  P3('$UCSORGBACK');
  TV('$DIMPOST');
  TV('$DIMAPOST');
  for (const n of ['$DIMSCALE', '$DIMASZ', '$DIMEXO', '$DIMDLI', '$DIMEXE', '$DIMRND', '$DIMDLE', '$DIMTP', '$DIMTM']) BD(n);
  if (ver >= R2007) {
    BD('$DIMFXL');
    BD('$DIMJOGANG');
    BS('$DIMTFILL');
    CMC('$DIMTFILLCLR');
  }
  B('$DIMTOL');
  B('$DIMLIM');
  B('$DIMTIH');
  B('$DIMTOH');
  B('$DIMSE1');
  B('$DIMSE2');
  BS('$DIMTAD');
  BS('$DIMZIN');
  BS('$DIMAZIN');
  if (ver >= R2007) BS('$DIMARCSYM');
  for (const n of ['$DIMTXT', '$DIMCEN', '$DIMTSZ', '$DIMALTF', '$DIMLFAC', '$DIMTVP', '$DIMTFAC', '$DIMGAP']) BD(n);
  BD('$DIMALTRND');
  B('$DIMALT');
  BS('$DIMALTD');
  B('$DIMTOFL');
  B('$DIMSAH');
  B('$DIMTIX');
  B('$DIMSOXD');
  CMC('$DIMCLRD');
  CMC('$DIMCLRE');
  CMC('$DIMCLRT');
  for (const n of ['$DIMADEC', '$DIMDEC', '$DIMTDEC', '$DIMALTU', '$DIMALTTD', '$DIMAUNIT', '$DIMFRAC', '$DIMLUNIT', '$DIMDSEP', '$DIMTMOVE', '$DIMJUST']) BS(n);
  B('$DIMSD1');
  B('$DIMSD2');
  BS('$DIMTOLJ');
  BS('$DIMTZIN');
  BS('$DIMALTZ');
  BS('$DIMALTTZ');
  B('$DIMUPT');
  BS('$DIMATFIT');
  if (ver >= R2007) B('$DIMFXLON');
  if (ver >= R2010) {
    B('$DIMTXTDIRECTION');
    BD('$DIMALTMZF');
    TV('$DIMALTMZS');
    BD('$DIMMZF');
    TV('$DIMMZS');
  }
  H('$DIMTXSTY');
  H('$DIMLDRBLK');
  H('$DIMBLK');
  H('$DIMBLK1');
  H('$DIMBLK2');
  if (ver >= R2007) {
    H('$DIMLTYPE');
    H('$DIMLTEX1');
    H('$DIMLTEX2');
  }
  // DWG도 DXF처럼 -1·-2·-3을 그대로 둔다
  dat.BS(num('$DIMLWD', -2));
  dat.BS(num('$DIMLWE', -2));
  const r = inp.refs;
  hdl.H(HARD_OWNER, r.blockControl);
  hdl.H(HARD_OWNER, r.layerControl);
  hdl.H(HARD_OWNER, r.styleControl);
  hdl.H(HARD_OWNER, r.ltypeControl);
  hdl.H(HARD_OWNER, r.viewControl);
  hdl.H(HARD_OWNER, r.ucsControl);
  hdl.H(HARD_OWNER, r.vportControl);
  hdl.H(HARD_OWNER, r.appidControl);
  hdl.H(HARD_OWNER, r.dimstyleControl);
  if (ver <= R2000) hdl.H(HARD_OWNER, r.vpentControl);
  hdl.H(HARD_PTR, r.groupDict);
  hdl.H(HARD_PTR, r.mlineStyleDict);
  hdl.H(HARD_OWNER, r.namedObjDict);
  BS('$TSTACKALIGN');
  BS('$TSTACKSIZE');
  TV('$HYPERLINKBASE');
  TV('$STYLESHEET');
  hdl.H(HARD_PTR, r.layoutDict);
  hdl.H(HARD_PTR, r.plotSettingsDict);
  hdl.H(HARD_PTR, r.plotStyleDict);
  if (ver >= R2004) {
    hdl.H(HARD_PTR, r.materialDict);
    hdl.H(HARD_PTR, r.colorDict);
  }
  if (ver >= R2007) hdl.H(HARD_PTR, r.visualStyleDict);
  if (ver >= R2013) hdl.H(HARD_PTR, 0);
  {
    let flags = lwIndex(num('$CELWEIGHT', -1)) & 0x1f;
    flags |= (num('$ENDCAPS') & 3) << 5;
    flags |= (num('$JOINSTYLE') & 3) << 7;
    if (!num('$LWDISPLAY')) flags |= 0x200;
    if (!num('$XEDIT', 1)) flags |= 0x400;
    if (num('$EXTNAMES', 1)) flags |= 0x800;
    if (num('$PSTYLEMODE', 1)) flags |= 0x2000;
    if (num('$OLESTARTUP')) flags |= 0x4000;
    dat.BL(flags);
  }
  BS('$INSUNITS');
  const cepsn = num('$CEPSNTYPE');
  const cpsnid = inp.handleVar('$CPSNID');
  if (cepsn === 3 && cpsnid) {
    dat.BS(3);
    hdl.H(HARD_PTR, cpsnid);
  } else dat.BS(cepsn === 3 ? 0 : cepsn);
  dat.TV(text('$FINGERPRINTGUID') || guid());
  dat.TV(text('$VERSIONGUID') || guid());
  if (ver >= R2004) {
    RC('$SORTENTS');
    RC('$INDEXCTL');
    RC('$HIDETEXT');
    RC('$XCLIPFRAME');
    RC('$DIMASSOC');
    RC('$HALOGAP');
    BS('$OBSCOLOR');
    BS('$INTERSECTIONCOLOR');
    RC('$OBSLTYPE');
    RC('$INTERSECTIONDISPLAY');
    TV('$PROJECTNAME');
  }
  hdl.H(HARD_PTR, r.paperSpace);
  hdl.H(HARD_PTR, r.modelSpace);
  hdl.H(HARD_PTR, r.ltByLayer);
  hdl.H(HARD_PTR, r.ltByBlock);
  hdl.H(HARD_PTR, r.ltContinuous);
  if (ver >= R2007) {
    B('$CAMERADISPLAY');
    dat.BL(0);
    dat.BL(10);
    dat.BD(1);
    BD('$STEPSPERSEC');
    BD('$STEPSIZE');
    BD('$3DDWFPREC');
    BD('$LENSLENGTH');
    BD('$CAMERAHEIGHT');
    RC('$SOLIDHIST');
    RC('$SHOWHIST');
    BD('$PSOLWIDTH');
    BD('$PSOLHEIGHT');
    BD('$LOFTANG1');
    BD('$LOFTANG2');
    BD('$LOFTMAG1');
    BD('$LOFTMAG2');
    BS('$LOFTPARAM');
    RC('$LOFTNORMALS');
    BD('$LATITUDE');
    BD('$LONGITUDE');
    BD('$NORTHDIRECTION');
    BL('$TIMEZONE');
    RC('$LIGHTGLYPHDISPLAY');
    RC('$TILEMODELIGHTSYNCH');
    RC('$DWFFRAME');
    RC('$DGNFRAME');
    B('$REALWORLDSCALE');
    CMC('$INTERFERECOLOR');
    HX('$INTERFEREOBJVS');
    HX('$INTERFEREVPVS');
    HX('$DRAGVS');
    RC('$CSHADOW');
    BD('$SHADOWPLANELOCATION');
  }

  // R2007+: 문자열 흐름 + 표지, 비트 크기, 핸들 흐름
  if (ver >= R2007) {
    const sb = str.pos;
    if (sb > 0) {
      dat.appendBits(str, sb);
      if (sb < 0x8000) dat.RS(sb);
      else {
        dat.RS(sb >>> 15);
        dat.RS((sb & 0x7fff) | 0x8000);
      }
      dat.B(1);
    } else dat.B(0);
    dat.patchRL(rlPos, dat.pos);
    dat.appendBits(hdl, hdl.pos);
  }
  const body = dat.bytes();
  return wrapSection(ver, maintVer, body, HEADER_SENTINEL, HEADER_END_SENTINEL);
}

/** 표지 + RL 크기(+R2010+ 높은 자리) + 자료 + CRC + 끝 표지 */
export function wrapSection(ver: number, maintVer: number, body: Uint8Array, start: number[], end: number[]): Uint8Array {
  const extra = (ver >= R2010 && maintVer > 3) || ver >= R2018 ? 4 : 0;
  const out = new Uint8Array(16 + 4 + extra + body.length + 2 + 16);
  out.set(start, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(16, body.length, true);
  out.set(body, 20 + extra);
  const crc = crc8(0xc0c1, out, 16, 20 + extra + body.length);
  dv.setUint16(20 + extra + body.length, crc, true);
  out.set(end, 20 + extra + body.length + 2);
  return out;
}

