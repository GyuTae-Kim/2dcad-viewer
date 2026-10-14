"""예제 도면(public/samples/opencad-sample.dxf)을 만든다. 이 저장소에서 직접 그린 도면이다.

사용법: python make_sample.py 출력.dxf   (ezdxf 1.4 필요)
"""

import math
import sys

import ezdxf
from ezdxf.enums import TextEntityAlignment
from ezdxf.math import Vec2


def main(out):
    doc = ezdxf.new("R2018", setup=True, units=4)
    doc.header["$MEASUREMENT"] = 1
    doc.header["$LUNITS"] = 2
    doc.header["$LUPREC"] = 2
    doc.header["$LTSCALE"] = 1
    doc.header["$PDMODE"] = 3
    doc.header["$PDSIZE"] = 2
    doc.styles.add("한글", font="NotoSansKR-Regular.ttf").set_extended_font_data("Noto Sans KR")
    doc.styles.add("ROMANS", font="romans.shx")

    layers = [
        ("외형선", 7, "Continuous", 50),
        ("숨은선", 3, "DASHED", 25),
        ("중심선", 1, "CENTER", 18),
        ("치수", 4, "Continuous", 18),
        ("해치", 8, "Continuous", 13),
        ("문자", 2, "Continuous", 25),
        ("가공", 6, "Continuous", 25),
        ("표제란", 7, "Continuous", 35),
        ("뷰포트", 9, "Continuous", 13),
    ]
    for name, color, lt, lw in layers:
        doc.layers.add(name, color=color, linetype=lt, lineweight=lw)
    doc.layers.get("뷰포트").dxf.plot = 0

    msp = doc.modelspace()

    # ---- 정면도: 120 × 80 판, 모서리 R8, 구멍·장공
    w, h, r = 120.0, 80.0, 8.0
    outline = [
        (r, 0, 0),
        (w - r, 0, math.tan(math.radians(90) / 4)),
        (w, r, 0),
        (w, h - r, math.tan(math.radians(90) / 4)),
        (w - r, h, 0),
        (r, h, math.tan(math.radians(90) / 4)),
        (0, h - r, 0),
        (0, r, math.tan(math.radians(90) / 4)),
    ]
    msp.add_lwpolyline([(x, y, 0, 0, b) for x, y, b in outline], format="xyseb", close=True, dxfattribs={"layer": "외형선"})
    holes = [(15, 15), (105, 15), (15, 65), (105, 65)]
    for x, y in holes:
        msp.add_circle((x, y), 4.5, dxfattribs={"layer": "외형선"})
        msp.add_line((x - 7, y), (x + 7, y), dxfattribs={"layer": "중심선"})
        msp.add_line((x, y - 7), (x, y + 7), dxfattribs={"layer": "중심선"})
    # 가운데 큰 구멍
    msp.add_circle((60, 40), 18, dxfattribs={"layer": "외형선"})
    msp.add_circle((60, 40), 22, dxfattribs={"layer": "숨은선"})
    msp.add_line((34, 40), (86, 40), dxfattribs={"layer": "중심선"})
    msp.add_line((60, 14), (60, 66), dxfattribs={"layer": "중심선"})
    # 장공
    # 장공: 직선 → 반원 → 직선 → 반원(볼록도는 그 정점에서 나가는 선분의 것)
    msp.add_lwpolyline([(40, 70, 0, 0, 0), (80, 70, 0, 0, 1), (80, 74, 0, 0, 0), (40, 74, 0, 0, 1)], format="xyseb", close=True, dxfattribs={"layer": "가공"})
    msp.add_line((36, 72), (84, 72), dxfattribs={"layer": "중심선"})

    doc.dimstyles.new(
        "ISO-25",
        dxfattribs={
            "dimtxt": 3.0,
            "dimasz": 2.5,
            "dimexo": 0.625,
            "dimexe": 1.25,
            "dimgap": 0.8,
            "dimdec": 1,
            "dimtad": 1,
            "dimtih": 0,
            "dimtoh": 0,
            "dimzin": 8,
            "dimlunit": 2,
            "dimtxsty": "ROMANS",
            "dimclrt": 2,
        },
    )
    dim_attr = {"layer": "치수"}
    msp.add_linear_dim(base=(0, -12), p1=(0, 0), p2=(w, 0), dimstyle="ISO-25", dxfattribs=dim_attr).render()
    msp.add_linear_dim(base=(-12, 0), p1=(0, 0), p2=(0, h), angle=90, dimstyle="ISO-25", dxfattribs=dim_attr).render()
    msp.add_linear_dim(base=(0, 92), p1=(15, 65), p2=(105, 65), dimstyle="ISO-25", dxfattribs=dim_attr).render()
    msp.add_linear_dim(base=(132, 0), p1=(105, 15), p2=(105, 65), angle=90, dimstyle="ISO-25", dxfattribs=dim_attr).render()
    msp.add_diameter_dim(center=(60, 40), radius=18, angle=35, dimstyle="ISO-25", dxfattribs=dim_attr).render()
    msp.add_radius_dim(center=(w - r, h - r), radius=r, angle=45, dimstyle="ISO-25", dxfattribs=dim_attr).render()
    d = msp.add_diameter_dim(center=(15, 15), radius=4.5, angle=225, dimstyle="ISO-25", override={"dimtxt": 2.5}, dxfattribs=dim_attr)
    d.set_text("4-<>")
    d.render()

    # ---- 측면도(단면): 두께 10, 해치
    ox = 160
    msp.add_lwpolyline([(ox, 0), (ox + 10, 0), (ox + 10, h), (ox, h)], close=True, dxfattribs={"layer": "외형선"})
    hatch = msp.add_hatch(color=256, dxfattribs={"layer": "해치"})
    hatch.set_pattern_fill("ANSI31", scale=0.6)
    hatch.paths.add_polyline_path([(ox, 0), (ox + 10, 0), (ox + 10, 18), (ox, 18)], is_closed=True)
    hatch.paths.add_polyline_path([(ox, 62), (ox + 10, 62), (ox + 10, h), (ox, h)], is_closed=True)
    hatch.associative = False
    for y0, y1 in ((18, 62), (35.5, 44.5)):
        msp.add_line((ox, y0), (ox + 10, y0), dxfattribs={"layer": "외형선" if y0 == 18 else "숨은선"})
        msp.add_line((ox, y1), (ox + 10, y1), dxfattribs={"layer": "외형선" if y1 == 62 else "숨은선"})
    msp.add_line((ox - 5, 40), (ox + 15, 40), dxfattribs={"layer": "중심선"})
    msp.add_linear_dim(base=(ox, -12), p1=(ox, 0), p2=(ox + 10, 0), dimstyle="ISO-25", dxfattribs=dim_attr).render()

    # ---- 주석
    t = msp.add_text("정면도", height=4, dxfattribs={"layer": "문자", "style": "한글"})
    t.set_placement((w / 2, -26), align=TextEntityAlignment.TOP_CENTER)
    t = msp.add_text("측면도 (단면 A-A)", height=4, dxfattribs={"layer": "문자", "style": "한글"})
    t.set_placement((ox + 5, -26), align=TextEntityAlignment.TOP_CENTER)
    notes = (
        "주기\\P"
        "1. 재질: SS275, 두께 10\\P"
        "2. 지시 없는 모서리는 C0.5\\P"
        "3. 표면 처리: 분체 도장(흑색)\\P"
        "4. 일반 공차: KS B ISO 2768-m"
    )
    msp.add_mtext(notes, dxfattribs={"layer": "문자", "style": "한글", "char_height": 3, "width": 90}).set_location((190, 80))
    ml = msp.add_multileader_mtext("Standard")
    ml.set_content("장공 4×40\\P(케이블 통로)", char_height=2.5)
    ml.add_leader_line(ezdxf.render.mleader.ConnectionSide.left, [Vec2(82, 73)])
    ml.build(insert=Vec2(100, 100))
    msp.add_point((60, 40), dxfattribs={"layer": "중심선"})

    # 볼트 블록
    blk = doc.blocks.new("M8_BOLT", base_point=(0, 0))
    blk.add_circle((0, 0), 6.5, dxfattribs={"layer": "0"})
    blk.add_lwpolyline([(6.5 * math.cos(a), 6.5 * math.sin(a)) for a in [math.radians(30 + 60 * i) for i in range(6)]], close=True, dxfattribs={"layer": "0"})
    blk.add_circle((0, 0), 4, dxfattribs={"layer": "0", "linetype": "DASHED"})
    blk.add_attdef("SIZE", (0, -10), dxfattribs={"height": 2.5, "layer": "0"}).set_placement((0, -10), align=TextEntityAlignment.TOP_CENTER)
    for i, (x, y) in enumerate([(230, 20), (250, 20), (270, 20)]):
        ref = msp.add_blockref("M8_BOLT", (x, y), dxfattribs={"layer": "가공", "rotation": i * 15})
        ref.add_auto_attribs({"SIZE": f"M8×{20 + i * 5}"})
    msp.add_text("체결 부품", height=3, dxfattribs={"layer": "문자", "style": "한글"}).set_placement((222, 32))

    # ---- 배치: A3 가로, 표제란, 뷰포트 1:1
    lay = doc.layouts.new("A3 도면")
    lay.page_setup(size=(420, 297), margins=(10, 10, 10, 10), units="mm")
    lay.add_viewport(center=(160, 160), size=(290, 200), view_center_point=(140, 30), view_height=200, dxfattribs={"layer": "뷰포트"})
    lay.add_lwpolyline([(0, 0), (400, 0), (400, 277), (0, 277)], close=True, dxfattribs={"layer": "표제란", "lineweight": 70})
    tb = [(230, 0), (400, 0), (400, 40), (230, 40)]
    lay.add_lwpolyline(tb, close=True, dxfattribs={"layer": "표제란"})
    for y in (10, 20, 30):
        lay.add_line((230, y), (400, y), dxfattribs={"layer": "표제란"})
    lay.add_line((290, 0), (290, 40), dxfattribs={"layer": "표제란"})
    rows = [("도명", "브래킷 판"), ("도번", "OC-2D-0001"), ("척도", "1:1"), ("단위", "mm")]
    for i, (k, v) in enumerate(rows):
        y = 33 - i * 10
        lay.add_text(k, height=4, dxfattribs={"layer": "표제란", "style": "한글"}).set_placement((236, y))
        lay.add_text(v, height=4, dxfattribs={"layer": "표제란", "style": "한글"}).set_placement((296, y))
    lay.add_text("OpenCAD 예제 도면", height=5, dxfattribs={"layer": "표제란", "style": "한글"}).set_placement((236, 45))

    doc.set_modelspace_vport(height=160, center=(140, 30))
    doc.saveas(out)


if __name__ == "__main__":
    main(sys.argv[1])
