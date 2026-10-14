"""DXF 파일을 ezdxf로 읽어 리더 비교용 요약 JSON을 쓴다.

사용법: python ezdxf_dump.py 입력.dxf 출력.json

요약 형식은 tests/oracle/summarize.ts와 같다. 각도는 라디안, 숫자는 소수 6자리로 반올림한다.
개발용 도구이며 앱에는 포함되지 않는다.
"""

import json
import math
import sys

import ezdxf


def r(v):
    if v is None:
        return None
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return round(v, 6) + 0.0
    return v


def p3(v):
    return [r(float(v[0])), r(float(v[1])), r(float(v[2]) if len(v) > 2 else 0.0)]


def p2(v):
    return [r(float(v[0])), r(float(v[1]))]


def g(e, key, default=None):
    """속성이 없는 객체 종류에서도 오류 없이 값을 얻는다."""
    try:
        return e.dxf.get(key, default)
    except Exception:
        return default


def color(e):
    out = {"aci": g(e, "color", 256)}
    if g(e, "true_color") is not None:
        out["rgb"] = e.dxf.true_color
    return out


def base(e):
    d = {
        "type": e.dxftype(),
        "handle": (g(e, "handle") or "").upper(),
        "layer": g(e, "layer", "0"),
        "linetype": g(e, "linetype", "ByLayer"),
        "color": color(e),
        "lineweight": g(e, "lineweight", -1),
    }
    ext = g(e, "extrusion")
    if ext is not None and (abs(ext[0]) > 1e-12 or abs(ext[1]) > 1e-12 or abs(ext[2] - 1) > 1e-12):
        d["extrusion"] = p3(ext)
    if g(e, "invisible", 0):
        d["invisible"] = True
    return d


def deg(v):
    return r(math.radians(v))


def text_fields(e, d):
    d["text"] = e.dxf.get("text", "")
    d["insert"] = p3(e.dxf.insert)
    if e.dxf.hasattr("align_point") and (e.dxf.get("halign", 0) or e.dxf.get("valign", 0)):
        d["alignPoint"] = p3(e.dxf.align_point)
    d["height"] = r(e.dxf.get("height", 0.0))
    d["rotation"] = deg(e.dxf.get("rotation", 0.0))
    d["widthFactor"] = r(e.dxf.get("width", 1.0))
    d["style"] = e.dxf.get("style", "Standard")
    d["halign"] = e.dxf.get("halign", 0)
    d["valign"] = e.dxf.get("valign", 0)


def summarize(e):
    t = e.dxftype()
    d = base(e)
    if t == "LINE":
        d["start"] = p3(e.dxf.start)
        d["end"] = p3(e.dxf.end)
    elif t == "POINT":
        d["position"] = p3(e.dxf.location)
    elif t == "CIRCLE":
        d["center"] = p3(e.dxf.center)
        d["radius"] = r(e.dxf.radius)
    elif t == "ARC":
        d["center"] = p3(e.dxf.center)
        d["radius"] = r(e.dxf.radius)
        d["startAngle"] = deg(e.dxf.start_angle)
        d["endAngle"] = deg(e.dxf.end_angle)
    elif t == "ELLIPSE":
        d["center"] = p3(e.dxf.center)
        d["majorAxis"] = p3(e.dxf.major_axis)
        d["ratio"] = r(e.dxf.ratio)
        d["startParam"] = r(e.dxf.start_param)
        d["endParam"] = r(e.dxf.end_param)
    elif t == "LWPOLYLINE":
        d["closed"] = bool(e.closed)
        d["vertices"] = [[r(x), r(y), r(b), r(s), r(w)] for x, y, s, w, b in e.get_points("xyseb")]
        d["constantWidth"] = r(e.dxf.get("const_width", 0.0))
        d["elevation"] = r(e.dxf.get("elevation", 0.0))
    elif t == "POLYLINE":
        d["flags"] = e.dxf.get("flags", 0)
        d["vertices"] = [p3(v.dxf.location) for v in e.vertices]
    elif t in ("SPLINE", "HELIX"):
        d["degree"] = e.dxf.degree
        d["flags"] = e.dxf.get("flags", 0)
        d["knots"] = len(e.knots)
        d["controlPoints"] = len(e.control_points)
        d["fitPoints"] = len(e.fit_points)
    elif t in ("XLINE", "RAY"):
        d["base"] = p3(e.dxf.start)
        d["direction"] = p3(e.dxf.unit_vector)
    elif t in ("TEXT", "ATTRIB", "ATTDEF"):
        text_fields(e, d)
        if t != "TEXT":
            d["tag"] = e.dxf.get("tag", "")
    elif t == "MTEXT":
        d["text"] = e.text
        d["insert"] = p3(e.dxf.insert)
        d["height"] = r(e.dxf.get("char_height", 0.0))
        d["width"] = r(e.dxf.get("width", 0.0))
        d["attachment"] = e.dxf.get("attachment_point", 1)
        d["style"] = e.dxf.get("style", "Standard")
    elif t == "INSERT":
        d["block"] = e.dxf.name
        d["insert"] = p3(e.dxf.insert)
        d["scale"] = [r(e.dxf.get("xscale", 1.0)), r(e.dxf.get("yscale", 1.0)), r(e.dxf.get("zscale", 1.0))]
        d["rotation"] = deg(e.dxf.get("rotation", 0.0))
        d["attribs"] = [a.dxf.get("tag", "") for a in e.attribs]
    elif t in ("DIMENSION", "ARC_DIMENSION", "LARGE_RADIAL_DIMENSION"):
        d["type"] = "DIMENSION"
        d["block"] = e.dxf.get("geometry", "")
        d["dimType"] = e.dxf.get("dimtype", 0)
        d["text"] = e.dxf.get("text", "")
        d["defPoint"] = p3(e.dxf.get("defpoint", (0, 0, 0)))
    elif t == "HATCH":
        d["patternName"] = e.dxf.get("pattern_name", "")
        d["solid"] = bool(e.dxf.get("solid_fill", 0))
        d["paths"] = len(e.paths)
        d["patternLines"] = len(e.pattern.lines) if e.pattern else 0
    elif t in ("SOLID", "TRACE", "3DFACE"):
        d["points"] = [p3(e.dxf.get(f"vtx{i}", (0, 0, 0))) for i in range(4)]
    elif t == "VIEWPORT":
        d["center"] = p3(e.dxf.center)
        d["width"] = r(e.dxf.width)
        d["height"] = r(e.dxf.height)
        d["viewHeight"] = r(e.dxf.get("view_height", 0.0))
    elif t == "MULTILEADER":
        d["leaders"] = len(e.context.leaders)
    elif t == "ACAD_TABLE":
        # ezdxf는 표의 AcDbEntity 속성을 기본값으로 둔다(비교하지 않음).
        d["layer"] = None
    return d


def layer_of(l):
    c = l.dxf.get("color", 7)
    return {
        "name": l.dxf.name,
        "color": abs(c),
        "off": c < 0,
        "frozen": bool(l.dxf.get("flags", 0) & 1),
        "locked": bool(l.dxf.get("flags", 0) & 4),
        "linetype": l.dxf.get("linetype", "Continuous"),
        "lineweight": l.dxf.get("lineweight", -3),
    }


def main(src, dst):
    doc = ezdxf.readfile(src)
    out = {
        "version": doc.dxfversion,
        "codepage": doc.header.get("$DWGCODEPAGE", ""),  # R12에는 없을 수 있다
        "insunits": doc.header.get("$INSUNITS", 0),
        "layers": sorted((layer_of(l) for l in doc.layers), key=lambda x: x["name"].upper()),
        "linetypes": sorted(lt.dxf.name for lt in doc.linetypes),
        "textStyles": sorted(s.dxf.name for s in doc.styles if s.dxf.name),
        "dimStyles": sorted(s.dxf.name for s in doc.dimstyles),
        "layouts": [
            {"name": lay.name, "block": lay.block_record.dxf.name, "tabOrder": lay.dxf_layout.dxf.get("taborder", 0)}
            for lay in sorted(doc.layouts, key=lambda x: x.dxf_layout.dxf.get("taborder", 0))
        ],
        "blocks": {},
    }
    for blk in doc.blocks:
        out["blocks"][blk.name.upper()] = [summarize(e) for e in blk]
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
