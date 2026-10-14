"""ezdxf로 리더 시험용 DXF를 만든다(여러 버전, 이진, 한글 코드 페이지, 여러 객체 종류).

사용법: python make_samples.py 출력_폴더
"""

import math
import os
import sys

import ezdxf
from ezdxf.enums import TextEntityAlignment
from ezdxf.math import Vec2, Vec3


def populate(doc, korean=False):
    msp = doc.modelspace()
    doc.layers.add("벽" if korean else "WALL", color=1)
    doc.layers.add("DIM", color=3, linetype="DASHED")
    doc.layers.add("OFF", color=5).off()
    lay = "벽" if korean else "WALL"
    msp.add_line((0, 0), (100, 0), dxfattribs={"layer": lay})
    msp.add_line((0, 0, 5), (0, 100, 5), dxfattribs={"color": 5, "lineweight": 50})
    msp.add_circle((50, 50), 20, dxfattribs={"true_color": 0x336699})
    msp.add_arc((50, 50), 30, 10, 170)
    msp.add_arc((200, 50), 30, 10, 170, dxfattribs={"extrusion": (0, 0, -1)})
    msp.add_ellipse((300, 50), major_axis=(40, 10), ratio=0.4, start_param=0.3, end_param=4.0)
    msp.add_lwpolyline([(0, 200, 0, 0, 0.5), (50, 200, 2, 3, 0), (50, 250, 0, 0, -1), (0, 250)], format="xyseb", close=True)
    msp.add_polyline2d([(400, 0), (450, 30), (500, 0)], dxfattribs={"layer": "DIM"})
    msp.add_polyline3d([(0, 0, 0), (10, 10, 10), (20, 0, 20)])
    msp.add_spline([(0, 300), (30, 340), (60, 300), (90, 360)])
    msp.add_spline_control_frame([(100, 300), (130, 340), (160, 300), (190, 360)], degree=3)
    msp.add_point((10, 10))
    msp.add_xline((0, 0), (1, 1))
    msp.add_ray((0, 0), (1, -1))
    t = "안녕하세요 도면" if korean else "Hello CAD"
    msp.add_text(t, height=5, rotation=15).set_placement((10, 400))
    msp.add_text(t, height=5).set_placement((100, 400), (200, 400), align=TextEntityAlignment.FIT)
    msp.add_text(t, height=5).set_placement((300, 400), align=TextEntityAlignment.MIDDLE_CENTER)
    msp.add_mtext(("여러 줄\\P문자" if korean else "Multi\\Pline {\\H2x;big}") * 3, dxfattribs={"char_height": 4, "width": 60}).set_location((10, 450))
    hatch = msp.add_hatch(color=2)
    hatch.paths.add_polyline_path([(0, 500), (100, 500), (100, 600), (0, 600)], is_closed=True)
    hatch.paths.add_polyline_path([(25, 525), (75, 525), (75, 575), (25, 575)], is_closed=True, flags=0)
    h2 = msp.add_hatch()
    h2.set_pattern_fill("ANSI31", scale=2, angle=30)
    ep = h2.paths.add_edge_path()
    ep.add_line((200, 500), (300, 500))
    ep.add_arc((300, 550), 50, -90, 90)
    ep.add_line((300, 600), (200, 600))
    ep.add_ellipse((200, 550), (0, 50), 0.5, 90, 270, ccw=True)
    if doc.dxfversion >= "AC1018":
        h3 = msp.add_hatch()
        h3.set_gradient((255, 0, 0), (0, 0, 255), rotation=45)
        h3.paths.add_polyline_path([(400, 500), (500, 500), (450, 600)], is_closed=True)
    h4 = msp.add_hatch()
    ep4 = h4.paths.add_edge_path()
    ep4.add_spline(control_points=[(600, 500), (650, 560), (700, 500), (650, 450)], degree=3, periodic=0)
    ep4.add_line((650, 450), (600, 500))
    msp.add_solid([(0, 700), (50, 700), (0, 750), (50, 750)])
    msp.add_trace([(100, 700), (150, 700), (100, 750), (150, 750)])
    msp.add_3dface([(200, 700), (250, 700), (250, 750), (200, 750)])
    blk = doc.blocks.new("BOLT", base_point=(0, 0))
    blk.add_circle((0, 0), 5, dxfattribs={"layer": "0", "color": 0})
    blk.add_line((-5, 0), (5, 0))
    blk.add_attdef("SIZE", (6, 0), dxfattribs={"height": 2})
    for i in range(3):
        ref = msp.add_blockref("BOLT", (400 + i * 30, 700), dxfattribs={"rotation": i * 20, "xscale": 1 + i * 0.5, "color": 1 + i})
        ref.add_auto_attribs({"SIZE": f"M{8 + i}"})
    m = msp.add_blockref("BOLT", (600, 700))
    m.dxf.column_count = 3
    m.dxf.row_count = 2
    m.dxf.column_spacing = 20
    m.dxf.row_spacing = 15
    dim = msp.add_linear_dim(base=(0, 820), p1=(0, 800), p2=(100, 800), dimstyle="EZDXF")
    dim.render()
    dim2 = msp.add_aligned_dim(p1=(200, 800), p2=(260, 840), distance=10)
    dim2.render()
    dim3 = msp.add_radius_dim(center=(400, 800), radius=30, angle=45)
    dim3.render()
    dim4 = msp.add_angular_dim_2l(base=(600, 850), line1=((550, 800), (650, 800)), line2=((550, 800), (650, 870)))
    dim4.render()
    msp.add_leader([(0, 900), (20, 920), (40, 920)])
    ml = msp.add_multileader_mtext("Standard")
    ml.set_content("MLEADER")
    ml.add_leader_line(ezdxf.render.mleader.ConnectionSide.left, [Vec3(100, 880)])
    ml.build(insert=Vec2(150, 920))
    msp.add_mline([(300, 900), (400, 900), (400, 950)])
    msp.add_wipeout([(500, 900), (550, 900), (550, 950), (500, 950)])
    if doc.dxfversion >= "AC1027":
        msp.add_helix(radius=10, pitch=5, turns=3).translate(700, 900, 0)
    return doc


def main(out):
    os.makedirs(out, exist_ok=True)
    for ver in ["R12", "R2000", "R2004", "R2007", "R2010", "R2013", "R2018"]:
        doc = ezdxf.new(ver, setup=True)
        if ver == "R12":
            msp = doc.modelspace()
            msp.add_line((0, 0), (100, 0))
            msp.add_circle((50, 50), 20)
            msp.add_arc((50, 50), 30, 10, 170)
            msp.add_text("R12 TEXT", height=5).set_placement((0, 100))
            msp.add_polyline2d([(0, 0), (10, 10), (20, 0)])
            blk = doc.blocks.new("B1")
            blk.add_line((0, 0), (5, 5))
            msp.add_blockref("B1", (30, 30))
        else:
            populate(doc)
        doc.saveas(os.path.join(out, f"gen_{ver}.dxf"))
        if ver in ("R2000", "R2018"):
            doc.saveas(os.path.join(out, f"gen_{ver}_binary.dxf"), fmt="bin")
    # 한글: R2000(ANSI_949)과 R2018(UTF-8)
    for ver, enc in [("R2000", "cp949"), ("R2018", "utf8")]:
        doc = ezdxf.new(ver, setup=True)
        doc.header["$DWGCODEPAGE"] = "ANSI_949"
        populate(doc, korean=True)
        doc.saveas(os.path.join(out, f"gen_{ver}_korean.dxf"), encoding=enc)


if __name__ == "__main__":
    main(sys.argv[1])
