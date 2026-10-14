/** AcDb:Header — 헤더 변수(사양 9장) */
import type { HeaderValue, Vec2, Vec3 } from '../../core/model';
import { BitReader, type DwgColor } from './bitstream';
import { warn, type DwgSections } from './container/types';
import { crc8 } from './crc';
import { lineweightFromIndex } from './lineweight';
import { cmcToCad } from './color';
import { attachStringStream } from './streams';
import { R14, R2000, R2004, R2007, R2010, R2013, R2018 } from './version';

const HEADER_SENTINEL = [0xcf, 0x7b, 0x1f, 0x23, 0xfd, 0xde, 0x38, 0xa9, 0x5f, 0x7c, 0x68, 0xb8, 0x4e, 0x6d, 0x33, 0x5f];

/** 헤더에서 읽은 값. 핸들 변수는 나중에 이름으로 푼다. */
export interface DwgHeader {
  vars: Map<string, HeaderValue>;
  /** 이름으로 풀어야 하는 핸들 변수($CLAYER 등) → 핸들 */
  handleVars: Map<string, number>;
  /** 표 제어 객체·사전 핸들 */
  refs: {
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
  };
  handseed: number;
  cecolor?: DwgColor;
}

function emptyRefs(): DwgHeader['refs'] {
  return {
    blockControl: 0,
    layerControl: 0,
    styleControl: 0,
    ltypeControl: 0,
    viewControl: 0,
    ucsControl: 0,
    vportControl: 0,
    appidControl: 0,
    dimstyleControl: 0,
    vpentControl: 0,
    groupDict: 0,
    mlineStyleDict: 0,
    namedObjDict: 0,
    layoutDict: 0,
    plotSettingsDict: 0,
    plotStyleDict: 0,
    materialDict: 0,
    colorDict: 0,
    visualStyleDict: 0,
    paperSpace: 0,
    modelSpace: 0,
    ltByLayer: 0,
    ltByBlock: 0,
    ltContinuous: 0,
  };
}

export function readHeader(sec: DwgSections, decoder: TextDecoder): DwgHeader {
  const ver = sec.ver;
  const data = sec.header;
  const vars = new Map<string, HeaderValue>();
  const handleVars = new Map<string, number>();
  const refs = emptyRefs();
  const out: DwgHeader = { vars, handleVars, refs, handseed: 0 };

  for (let k = 0; k < 16; k++) {
    if (data[k] !== HEADER_SENTINEL[k]) {
      warn(sec.warnings, 'dwg.sentinel_mismatch', '헤더 시작 표지가 맞지 않습니다.');
      break;
    }
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const size = dv.getUint32(16, true);
  let start = 20;
  if ((ver >= R2010 && sec.maintVer > 3) || ver >= R2018) start = 24;
  // CRC: 크기 필드부터 자료 끝까지(0xC0C1 시작)
  if (20 + size + 2 <= data.length) {
    const stored = dv.getUint16(start + size, true);
    const calc = crc8(0xc0c1, data, 16, start + size);
    if (stored !== calc) warn(sec.warnings, 'dwg.crc_mismatch', '헤더 CRC가 맞지 않습니다.');
  }

  const dat = new BitReader(data, ver, decoder);
  dat.pos = start * 8;
  dat.end = (start + size) * 8;
  let hdl = dat;
  if (ver >= R2007) {
    // 자료 비트 크기(첫 RL)로 문자열·핸들 흐름 위치를 정한다.
    const bitSize = dat.RLu();
    const endBit = start * 8 + bitSize;
    const str = dat.fork();
    attachStringStream(dat, str, start * 8, endBit);
    hdl = dat.fork();
    hdl.pos = endBit;
    hdl.end = (start + size) * 8;
  }

  const B = (name: string) => vars.set(name, dat.B());
  const BS = (name: string) => vars.set(name, dat.BS());
  const BD = (name: string) => vars.set(name, dat.BD());
  const BL = (name: string) => vars.set(name, dat.BL());
  const P3 = (name: string) => vars.set(name, dat.BD3() as Vec3);
  const P2 = (name: string) => vars.set(name, dat.RD2() as Vec2);
  const TV = (name: string) => vars.set(name, dat.TV());
  const H = (name: string) => {
    const h = hdl.H();
    handleVars.set(name, h);
    return h;
  };
  const RC = (name: string) => vars.set(name, dat.RC());
  const CMC = (name: string) => {
    const c = dat.CMC();
    vars.set(name, cmcToCad(c).aci);
    return c;
  };
  /** 이름으로 풀지 않는 핸들 변수(16진 문자열) */
  const HX = (name: string) => {
    const h = hdl.H();
    vars.set(name, h ? h.toString(16).toUpperCase() : '');
  };
  const JD = (name: string) => {
    const day = dat.BL();
    const ms = dat.BL();
    vars.set(name, day + ms / 86400000);
  };

  if (ver >= R2013) vars.set('$REQUIREDVERSIONS', dat.BLL());
  dat.BD();
  dat.BD();
  dat.BD();
  dat.BD();
  dat.TV();
  dat.TV();
  dat.TV();
  dat.TV();
  dat.BL();
  dat.BL();
  if (ver <= R14) dat.BS();
  if (ver < R2004) H('$_CVPORT_ENT');
  B('$DIMASO');
  B('$DIMSHO');
  if (ver <= R14) B('$DIMSAV');
  B('$PLINEGEN');
  B('$ORTHOMODE');
  B('$REGENMODE');
  B('$FILLMODE');
  B('$QTEXTMODE');
  B('$PSLTSCALE');
  B('$LIMCHECK');
  if (ver <= R14) B('$BLIPMODE');
  if (ver >= R2004) dat.B();
  B('$USRTIMER');
  B('$SKPOLY');
  B('$ANGDIR');
  B('$SPLFRAME');
  if (ver <= R14) {
    B('$ATTREQ');
    B('$ATTDIA');
  }
  B('$MIRRTEXT');
  B('$WORLDVIEW');
  if (ver <= R14) dat.B(); // WIREFRAME
  B('$TILEMODE');
  B('$PLIMCHECK');
  B('$VISRETAIN');
  if (ver <= R14) B('$DELOBJ');
  B('$DISPSILH');
  B('$PELLIPSE');
  BS('$PROXYGRAPHICS');
  if (ver <= R14) BS('$DRAGMODE');
  BS('$TREEDEPTH');
  BS('$LUNITS');
  BS('$LUPREC');
  BS('$AUNITS');
  BS('$AUPREC');
  if (ver <= R14) BS('$OSMODE');
  BS('$ATTMODE');
  if (ver <= R14) BS('$COORDS');
  BS('$PDMODE');
  if (ver <= R14) BS('$PICKSTYLE');
  if (ver >= R2004) {
    dat.BL();
    dat.BL();
    dat.BL();
  }
  for (const n of ['$USERI1', '$USERI2', '$USERI3', '$USERI4', '$USERI5', '$SPLINESEGS', '$SURFU', '$SURFV', '$SURFTYPE', '$SURFTAB1', '$SURFTAB2', '$SPLINETYPE', '$SHADEDGE', '$SHADEDIF', '$UNITMODE', '$MAXACTVP', '$ISOLINES', '$CMLJUST', '$TEXTQLTY']) BS(n);
  for (const n of ['$LTSCALE', '$TEXTSIZE', '$TRACEWID', '$SKETCHINC', '$FILLETRAD', '$THICKNESS', '$ANGBASE', '$PDSIZE', '$PLINEWID', '$USERR1', '$USERR2', '$USERR3', '$USERR4', '$USERR5', '$CHAMFERA', '$CHAMFERB', '$CHAMFERC', '$CHAMFERD', '$FACETRES', '$CMLSCALE', '$CELTSCALE']) BD(n);
  TV('$MENU'); // 사양은 R2004까지라 하지만 실제 파일에는 계속 있다
  JD('$TDCREATE');
  JD('$TDUPDATE');
  if (ver >= R2004) {
    dat.BL();
    dat.BL();
    dat.BL();
  }
  JD('$TDINDWG');
  JD('$TDUSRTIMER');
  out.cecolor = CMC('$CECOLOR');
  out.handseed = dat.H();
  vars.set('$HANDSEED', out.handseed.toString(16).toUpperCase());
  H('$CLAYER');
  H('$TEXTSTYLE');
  H('$CELTYPE');
  if (ver >= R2007) HX('$CMATERIAL');
  H('$DIMSTYLE');
  H('$CMLSTYLE');
  if (ver >= R2000) BD('$PSVPSCALE');
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
  if (ver >= R2000) {
    H('$PUCSORTHOREF');
    BS('$PUCSORTHOVIEW');
    H('$PUCSBASE');
    P3('$PUCSORGTOP');
    P3('$PUCSORGBOTTOM');
    P3('$PUCSORGLEFT');
    P3('$PUCSORGRIGHT');
    P3('$PUCSORGFRONT');
    P3('$PUCSORGBACK');
  }
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
  if (ver >= R2000) {
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
  }
  if (ver <= R14) {
    B('$DIMTOL');
    B('$DIMLIM');
    B('$DIMTIH');
    B('$DIMTOH');
    B('$DIMSE1');
    B('$DIMSE2');
    B('$DIMALT');
    B('$DIMTOFL');
    B('$DIMSAH');
    B('$DIMTIX');
    B('$DIMSOXD');
    RC('$DIMALTD');
    RC('$DIMZIN');
    B('$DIMSD1');
    B('$DIMSD2');
    RC('$DIMTOLJ');
    RC('$DIMJUST');
    RC('$DIMFIT');
    B('$DIMUPT');
    RC('$DIMTZIN');
    RC('$DIMALTZ');
    RC('$DIMALTTZ');
    RC('$DIMTAD');
    BS('$DIMUNIT');
    BS('$DIMAUNIT');
    BS('$DIMDEC');
    BS('$DIMTDEC');
    BS('$DIMALTU');
    BS('$DIMALTTD');
    H('$DIMTXSTY');
  }
  for (const n of ['$DIMSCALE', '$DIMASZ', '$DIMEXO', '$DIMDLI', '$DIMEXE', '$DIMRND', '$DIMDLE', '$DIMTP', '$DIMTM']) BD(n);
  if (ver >= R2007) {
    BD('$DIMFXL');
    BD('$DIMJOGANG');
    BS('$DIMTFILL');
    CMC('$DIMTFILLCLR');
  }
  if (ver >= R2000) {
    B('$DIMTOL');
    B('$DIMLIM');
    B('$DIMTIH');
    B('$DIMTOH');
    B('$DIMSE1');
    B('$DIMSE2');
    BS('$DIMTAD');
    BS('$DIMZIN');
    BS('$DIMAZIN');
  }
  if (ver >= R2007) BS('$DIMARCSYM');
  for (const n of ['$DIMTXT', '$DIMCEN', '$DIMTSZ', '$DIMALTF', '$DIMLFAC', '$DIMTVP', '$DIMTFAC', '$DIMGAP']) BD(n);
  if (ver <= R14) {
    vars.set('$DIMPOST', dat.T());
    vars.set('$DIMAPOST', dat.T());
    vars.set('$DIMBLK', dat.T());
    vars.set('$DIMBLK1', dat.T());
    vars.set('$DIMBLK2', dat.T());
  }
  if (ver >= R2000) {
    BD('$DIMALTRND');
    B('$DIMALT');
    BS('$DIMALTD');
    B('$DIMTOFL');
    B('$DIMSAH');
    B('$DIMTIX');
    B('$DIMSOXD');
  }
  CMC('$DIMCLRD');
  CMC('$DIMCLRE');
  CMC('$DIMCLRT');
  if (ver >= R2000) {
    for (const n of ['$DIMADEC', '$DIMDEC', '$DIMTDEC', '$DIMALTU', '$DIMALTTD', '$DIMAUNIT', '$DIMFRAC', '$DIMLUNIT', '$DIMDSEP', '$DIMTMOVE', '$DIMJUST']) BS(n);
    B('$DIMSD1');
    B('$DIMSD2');
    BS('$DIMTOLJ');
    BS('$DIMTZIN');
    BS('$DIMALTZ');
    BS('$DIMALTTZ');
    B('$DIMUPT');
    BS('$DIMATFIT');
  }
  if (ver >= R2007) B('$DIMFXLON');
  if (ver >= R2010) {
    B('$DIMTXTDIRECTION');
    BD('$DIMALTMZF');
    TV('$DIMALTMZS');
    BD('$DIMMZF');
    TV('$DIMMZS');
  }
  if (ver >= R2000) {
    H('$DIMTXSTY');
    H('$DIMLDRBLK');
    H('$DIMBLK');
    H('$DIMBLK1');
    H('$DIMBLK2');
  }
  if (ver >= R2007) {
    H('$DIMLTYPE');
    H('$DIMLTEX1');
    H('$DIMLTEX2');
  }
  if (ver >= R2000) {
    vars.set('$DIMLWD', lwValue(dat.BS()));
    vars.set('$DIMLWE', lwValue(dat.BS()));
  }
  refs.blockControl = hdl.H();
  refs.layerControl = hdl.H();
  refs.styleControl = hdl.H();
  refs.ltypeControl = hdl.H();
  refs.viewControl = hdl.H();
  refs.ucsControl = hdl.H();
  refs.vportControl = hdl.H();
  refs.appidControl = hdl.H();
  refs.dimstyleControl = hdl.H();
  if (ver <= R2000) refs.vpentControl = hdl.H();
  refs.groupDict = hdl.H();
  refs.mlineStyleDict = hdl.H();
  refs.namedObjDict = hdl.H();
  if (ver >= R2000) {
    BS('$TSTACKALIGN');
    BS('$TSTACKSIZE');
    TV('$HYPERLINKBASE');
    TV('$STYLESHEET');
    refs.layoutDict = hdl.H();
    refs.plotSettingsDict = hdl.H();
    refs.plotStyleDict = hdl.H();
  }
  if (ver >= R2004) {
    refs.materialDict = hdl.H();
    refs.colorDict = hdl.H();
  }
  if (ver >= R2007) refs.visualStyleDict = hdl.H();
  if (ver >= R2013) hdl.H();
  if (ver >= R2000) {
    const flags = dat.BL();
    vars.set('$CELWEIGHT', lineweightFromIndex(flags & 0x1f));
    vars.set('$ENDCAPS', (flags & 0x60) >> 5);
    vars.set('$JOINSTYLE', (flags & 0x180) >> 7);
    vars.set('$LWDISPLAY', flags & 0x200 ? 0 : 1);
    vars.set('$XEDIT', flags & 0x400 ? 0 : 1);
    vars.set('$EXTNAMES', flags & 0x800 ? 1 : 0);
    vars.set('$PSTYLEMODE', flags & 0x2000 ? 1 : 0);
    vars.set('$OLESTARTUP', flags & 0x4000 ? 1 : 0);
    BS('$INSUNITS');
    const cepsn = dat.BS();
    vars.set('$CEPSNTYPE', cepsn);
    if (cepsn === 3) H('$CPSNID');
    TV('$FINGERPRINTGUID');
    TV('$VERSIONGUID');
  }
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
  refs.paperSpace = hdl.H();
  refs.modelSpace = hdl.H();
  refs.ltByLayer = hdl.H();
  refs.ltByBlock = hdl.H();
  refs.ltContinuous = hdl.H();
  if (ver >= R2007) {
    B('$CAMERADISPLAY');
    dat.BL();
    dat.BL();
    dat.BD();
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
  if (dat.overflowed() || hdl.overflowed()) {
    warn(sec.warnings, 'dwg.header_overflow', '헤더 변수를 읽다가 자료 끝을 넘었습니다.');
  }
  return out;
}

function lwValue(v: number): number {
  if (v === -1 || v === -2 || v === -3) return v;
  if (v === 29) return -1;
  if (v === 30) return -2;
  if (v === 31) return -3;
  return v;
}
