"""DXF의 ACAD_TABLE 셀(병합·정렬·서식)을 ezdxf로 읽어 JSON으로 쓴다(표 쓰기 검증용, 앱에는 포함되지 않는다).

사용법: python -I ezdxf_table.py 입력.dxf 출력.json

ezdxf는 ACAD_TABLE을 태그 저장 객체로 읽는다. AcDbTable 하위 클래스의 태그를 셀(171)마다 나눠
병합 표시(173), 병합 열·행 수(175·176), 재지정 플래그(R2007+ 91, 그 전 177), 정렬(170), 문자 높이(140),
문자 색(64), 배경색(63), 채우기(283), 문자 스타일(7), 셀 문자(R2007+ 302, 그 전 2·3 조각 + 1)를 꺼낸다.
audit() 오류 수와 고친 항목 수도 함께 쓴다.
"""

import json
import sys

sys.dont_write_bytecode = True

import ezdxf
from ezdxf.lldxf.tags import Tags


def cells_of(table):
    sub = table.xtags.get_subclass("AcDbTable")
    out = {"rows": 0, "cols": 0, "cells": []}
    cur = None
    parts = []
    full = None
    header = True
    for tag in sub:
        code, value = tag.code, tag.value
        if code == 171:
            if cur is not None:
                cur["text"] = full if full is not None else "".join(parts)
                out["cells"].append(cur)
            header = False
            cur = {}
            parts = []
            full = None
            continue
        if header:
            if code == 91 and not out["rows"]:
                out["rows"] = value
            elif code == 92 and not out["cols"]:
                out["cols"] = value
            continue
        if code == 302 and full is None:
            full = value
        elif code in (1, 2, 3) and full is None and "value" not in cur:
            parts.append(value)
        elif code == 301:
            cur["value"] = True
        key = {173: "merged", 175: "spanCols", 176: "spanRows", 177: "flags", 170: "align", 140: "height", 64: "color", 63: "fill", 283: "fillFlag", 7: "textStyle"}.get(code)
        if code == 91 and "flags" not in cur and "value" not in cur:
            key = "flags"
        if key and key not in cur:
            cur[key] = value
    if cur is not None:
        cur["text"] = full if full is not None else "".join(parts)
        out["cells"].append(cur)
    for c in out["cells"]:
        c.pop("value", None)
    return out


def main():
    src, dst = sys.argv[1], sys.argv[2]
    doc = ezdxf.readfile(src)
    auditor = doc.audit()
    tables = []
    for e in doc.entitydb.values():
        if e.dxftype() == "ACAD_TABLE":
            t = cells_of(e)
            t["handle"] = e.dxf.handle
            t["block"] = e.dxf.get("geometry", "")
            tables.append(t)
    tables.sort(key=lambda t: int(t["handle"], 16))
    res = {
        "version": doc.dxfversion,
        "errors": [f"{x.code}: {x.message}" for x in auditor.errors],
        "fixes": [f"{x.code}: {x.message}" for x in auditor.fixes],
        "tables": tables,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
