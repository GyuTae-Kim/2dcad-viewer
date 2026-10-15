"""ezdxf 오라클: DXF의 도면층 필터를 JSON으로.

- LAYER 표 확장 사전의 항목 이름
- ACLYDICTIONARY → XRECORD(AutoCAD 필터) — 중첩은 XRECORD 확장 사전의 ACLYDICTIONARY를 따라간다(경로 "부모/자식")
- OPENCAD_LAYERFILTERS → XRECORD(이 앱 기록)
- 도면층 핸들 → 이름, 감사 결과

사용: python -I ezdxf_layerfilters.py 입력.dxf 출력.json
"""
import json
import sys

import ezdxf


def tags_of(xr):
    return [[t.code, t.value if isinstance(t.value, (int, float, str)) else str(t.value)] for t in xr.tags]


def name_of(xr):
    for t in xr.tags:
        if t.code == 300:
            return str(t.value)
    return "?"


def walk(d, prefix, out, chain):
    for key, xr in d.items():
        if xr is None or xr.dxftype() != "XRECORD":
            continue
        path = prefix + name_of(xr)
        entry = {"key": key, "handle": xr.dxf.handle, "owner": xr.dxf.owner, "tags": tags_of(xr)}
        out[path] = entry
        if xr.has_extension_dict:
            xd = xr.get_extension_dict()
            entry["xdict_owner"] = xd.dictionary.dxf.owner
            nested = xd.get("ACLYDICTIONARY")
            if nested is not None:
                entry["nested_owner"] = nested.dxf.owner
                chain.append(nested.dxf.handle)
                walk(nested, path + "/", out, chain)


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    doc = ezdxf.readfile(src)
    head = doc.layers.head
    result = {"xdict_keys": [], "acly": {}, "app": {}, "layers": {}, "audit_errors": 0, "audit_fixes": 0, "nested_dicts": []}
    if head.has_extension_dict:
        xd = head.get_extension_dict()
        result["xdict_keys"] = sorted(xd.keys())
        acly = xd.get("ACLYDICTIONARY")
        if acly is not None:
            result["acly_owner"] = acly.dxf.owner
            result["xdict_handle"] = xd.dictionary.dxf.handle
            walk(acly, "", result["acly"], result["nested_dicts"])
        d = xd.get("OPENCAD_LAYERFILTERS")
        if d is not None:
            for name, xr in d.items():
                if xr is None or xr.dxftype() != "XRECORD":
                    continue
                result["app"][name] = {"handle": xr.dxf.handle, "owner": xr.dxf.owner, "tags": tags_of(xr)}
    for layer in doc.layers:
        result["layers"][layer.dxf.handle] = layer.dxf.name
    auditor = doc.audit()
    result["audit_errors"] = len(auditor.errors)
    result["audit_fixes"] = len(auditor.fixes)
    result["audit_messages"] = [str(e.message) for e in auditor.errors][:20] + [str(e.message) for e in auditor.fixes][:20]
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
