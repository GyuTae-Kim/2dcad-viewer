"""DXF의 주석 축척 컨텍스트 데이터 구조를 ezdxf로 읽어 JSON으로 쓴다(주석 축척 쓰기 검증용, 개발 도구).

사용법: python -I ezdxf_ctxdata.py 입력.dxf 출력.json

출력: { "version", "audit_errors": [문자열], "classes": [DXF 이름], "records": [{
          "handle", "type", "owner", "key"(축척 사전의 키), "scales_dict"(ACDB_ANNOTATIONSCALES 사전),
          "manager", "xdict", "entity", "entity_type", "entity_xdict_ok", "reactor_ok", "subclasses": [표지],
          "tags": [[코드, 값], ...](표지 뒤 본문), "scale_type"(340이 가리키는 객체 종류) }] }
"""

import json
import sys

sys.dont_write_bytecode = True

import ezdxf


def entry_key(d, handle):
    try:
        for k, v in d.items():
            h = v.dxf.handle if hasattr(v, "dxf") else str(v)
            if str(h).upper() == handle.upper():
                return k
    except Exception:
        pass
    return None


def main(src, out):
    doc = ezdxf.readfile(src)
    auditor = doc.audit()
    db = doc.entitydb
    res = {
        "version": doc.dxfversion,
        "audit_errors": [str(e.message) for e in auditor.errors],
        "classes": sorted({c.dxf.name for c in doc.classes}),
        "records": [],
    }
    for obj in doc.objects:
        t = obj.dxftype()
        if "CONTEXTDATA" not in t:
            continue
        rec = {"handle": obj.dxf.handle, "type": t, "owner": obj.dxf.owner}
        sd = db.get(obj.dxf.owner)
        rec["key"] = entry_key(sd, obj.dxf.handle) if sd is not None and sd.dxftype() == "DICTIONARY" else None
        rec["reactor_ok"] = obj.dxf.owner in (obj.reactors.get() if obj.reactors else [])
        mgr = db.get(sd.dxf.owner) if sd is not None else None
        rec["scales_dict"] = entry_key(mgr, sd.dxf.handle) if mgr is not None and mgr.dxftype() == "DICTIONARY" else None
        xd = db.get(mgr.dxf.owner) if mgr is not None else None
        rec["manager"] = entry_key(xd, mgr.dxf.handle) if xd is not None and xd.dxftype() == "DICTIONARY" else None
        ent = db.get(xd.dxf.owner) if xd is not None else None
        rec["xdict"] = xd.dxf.handle if xd is not None else None
        rec["entity"] = ent.dxf.handle if ent is not None else None
        rec["entity_type"] = ent.dxftype() if ent is not None else None
        ok = False
        if ent is not None and ent.has_extension_dict:
            ok = ent.get_extension_dict().dictionary.dxf.handle == xd.dxf.handle
        rec["entity_xdict_ok"] = ok
        subs, tags = [], []
        xtags = getattr(obj, "xtags", None)
        if xtags is not None:
            for sub in xtags.subclasses[1:]:
                for tag in sub:
                    if tag.code == 100:
                        subs.append(tag.value)
                    else:
                        v = tag.value
                        if isinstance(v, (tuple, list)):
                            v = list(v)
                        tags.append([tag.code, v])
        rec["subclasses"] = subs
        rec["tags"] = tags
        scale = None
        for code, v in tags:
            if code == 340:
                o = db.get(str(v))
                scale = o.dxftype() if o is not None else None
                break
        rec["scale_type"] = scale
        res["records"].append(rec)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, default=str)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
