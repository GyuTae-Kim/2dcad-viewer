"""ezdxf 오라클: 루트 사전 AcStStandard(표준 파일 연결)와 도면층 확장 자료 ACLAYTRANS(LAYTRANS 매핑), 감사 결과를 JSON으로.

사용: python -I ezdxf_lyrecords.py 입력.dxf 출력.json
"""
import json
import sys

import ezdxf


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    doc = ezdxf.readfile(src)
    result = {"acst": [], "acst_owner": None, "root": None, "laytrans": {}, "appids": [], "audit_errors": 0, "audit_fixes": 0}
    root = doc.rootdict
    result["root"] = root.dxf.handle
    d = root.get("AcStStandard")
    if d is not None:
        result["acst_owner"] = d.dxf.owner
        for key, xr in d.items():
            tags = [[t.code, t.value if isinstance(t.value, (int, float, str)) else str(t.value)] for t in xr.tags] if xr is not None and xr.dxftype() == "XRECORD" else None
            result["acst"].append([key, xr.dxf.owner if xr is not None else None, tags])
    for layer in doc.layers:
        if layer.has_xdata("ACLAYTRANS"):
            result["laytrans"][layer.dxf.name] = [str(t.value) for t in layer.get_xdata("ACLAYTRANS") if t.code == 1000]
    result["appids"] = [a.dxf.name for a in doc.appids]
    auditor = doc.audit()
    result["audit_errors"] = len(auditor.errors)
    result["audit_fixes"] = len(auditor.fixes)
    result["audit_messages"] = [str(e.message) for e in auditor.errors][:20] + [str(e.message) for e in auditor.fixes][:20]
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
