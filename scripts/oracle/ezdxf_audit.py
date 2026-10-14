"""DXF 파일을 ezdxf로 읽고 audit()을 돌려 결과를 JSON으로 쓴다(DXF 쓰기 검증용).

사용법: python ezdxf_audit.py 출력.json [--summary] 입력1.dxf [입력2.dxf ...]

출력: { 입력 경로: { "ok": bool, "load_error": str | null, "errors": [{code, message}],
                    "fixes": [{code, message}], "log": [ezdxf 경고 문자열], "summary": {...} | 없음 } }
--summary를 주면 ezdxf_dump.py와 같은 요약도 함께 넣는다. 개발용 도구이며 앱에는 포함되지 않는다.
"""

import importlib.util
import json
import logging
import os
import sys

sys.dont_write_bytecode = True  # 저장소에 __pycache__를 남기지 않는다

import ezdxf


class Collect(logging.Handler):
    def __init__(self):
        super().__init__(logging.WARNING)
        self.items = []

    def emit(self, record):
        self.items.append(record.getMessage())


def load_dump():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ezdxf_dump.py")
    spec = importlib.util.spec_from_file_location("ezdxf_dump", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def summary_of(dump, doc):
    out = {
        "version": doc.dxfversion,
        "codepage": doc.header.get("$DWGCODEPAGE", ""),
        "insunits": doc.header.get("$INSUNITS", 0),
        "layers": sorted((dump.layer_of(l) for l in doc.layers), key=lambda x: x["name"].upper()),
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
        out["blocks"][blk.name.upper()] = [dump.summarize(e) for e in blk]
    return out


def audit_file(path, want_summary, dump):
    handler = Collect()
    logger = logging.getLogger("ezdxf")
    logger.addHandler(handler)
    res = {"ok": False, "load_error": None, "errors": [], "fixes": [], "log": []}
    try:
        doc = ezdxf.readfile(path)
        if want_summary:
            res["summary"] = summary_of(dump, doc)
        auditor = doc.audit()
        res["errors"] = [{"code": int(e.code), "message": e.message} for e in auditor.errors]
        res["fixes"] = [{"code": int(e.code), "message": e.message} for e in auditor.fixes]
        res["ok"] = not auditor.errors
    except Exception as exc:  # 읽기 실패
        res["load_error"] = f"{type(exc).__name__}: {exc}"
    finally:
        logger.removeHandler(handler)
    res["log"] = handler.items[:50]
    return res


def main(argv):
    out = argv[0]
    args = argv[1:]
    want_summary = False
    if args and args[0] == "--summary":
        want_summary = True
        args = args[1:]
    dump = load_dump() if want_summary else None
    result = {p: audit_file(p, want_summary, dump) for p in args}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
