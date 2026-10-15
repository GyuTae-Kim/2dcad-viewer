"""ezdxf 오라클: DXF의 *Active 뷰포트 스냅 스타일(77)·등각평면(78)과 머리말 $SNAPSTYLE·$SNAPISOPAIR, 감사 결과를 JSON으로.

사용: python -I ezdxf_vport.py 입력.dxf 출력.json
"""
import json
import sys

import ezdxf


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    doc = ezdxf.readfile(src)
    active = []
    for vp in doc.viewports.get("*Active"):
        active.append({"snap_style": vp.dxf.get("snap_style"), "snap_isopair": vp.dxf.get("snap_isopair")})
    head = {k: doc.header.get(k) for k in ("$SNAPSTYLE", "$SNAPISOPAIR") if k in doc.header}
    auditor = doc.audit()
    result = {
        "version": doc.dxfversion,
        "active": active,
        "header": head,
        "audit_errors": len(auditor.errors),
        "audit_messages": [str(e.message) for e in auditor.errors][:20],
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
