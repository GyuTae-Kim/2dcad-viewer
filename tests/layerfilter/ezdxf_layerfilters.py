"""ezdxf 오라클: DXF의 LAYER 표 확장 사전 → OPENCAD_LAYERFILTERS의 XRECORD 태그, 같은 확장 사전의 항목 이름, 감사 결과를 JSON으로.

사용: python -I ezdxf_layerfilters.py 입력.dxf 출력.json
"""
import json
import sys

import ezdxf


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    doc = ezdxf.readfile(src)
    head = doc.layers.head
    result = {"xdict_keys": [], "filters": {}, "layers": {}, "audit_errors": 0, "audit_fixes": 0}
    if head.has_extension_dict:
        xd = head.get_extension_dict()
        result["xdict_keys"] = list(xd.keys())
        d = xd.get("OPENCAD_LAYERFILTERS")
        if d is not None:
            for name, xr in d.items():
                if xr is None or xr.dxftype() != "XRECORD":
                    continue
                result["filters"][name] = {
                    "handle": xr.dxf.handle,
                    "owner": xr.dxf.owner,
                    "tags": [[t.code, t.value if isinstance(t.value, (int, float, str)) else str(t.value)] for t in xr.tags],
                }
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
