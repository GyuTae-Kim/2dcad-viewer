"""ezdxf 오라클: DXF의 LAYER 표 확장 사전 → ACAD_LAYERSTATES의 XRECORD 태그와 감사 결과를 JSON으로.

사용: python -I ezdxf_layerstates.py 입력.dxf 출력.json
"""
import json
import sys

import ezdxf


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    doc = ezdxf.readfile(src)
    head = doc.layers.head
    result = {"has_xdict": False, "states": {}, "audit_errors": 0, "audit_fixes": 0, "layers": {}}
    if head.has_extension_dict:
        result["has_xdict"] = True
        xd = head.get_extension_dict()
        d = xd.get("ACAD_LAYERSTATES")
        if d is not None:
            for name, xr in d.items():
                if xr is None or xr.dxftype() != "XRECORD":
                    continue
                result["states"][name] = [[t.code, t.value if isinstance(t.value, (int, float, str)) else str(t.value)] for t in xr.tags]
    for layer in doc.layers:
        result["layers"][layer.dxf.handle] = layer.dxf.name
    auditor = doc.audit()
    result["audit_errors"] = len(auditor.errors)
    result["audit_fixes"] = len(auditor.fixes)
    result["audit_messages"] = [str(e.message) for e in auditor.errors][:20]
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
