"""브라우저에 둘 글꼴을 만든다.

1. Noto Sans KR 가변 글꼴(OFL)을 굵기 400으로 고정하고, 유니코드 범위별 작은 TTF로 나눈다.
   뷰어는 도면에 쓰인 문자가 든 조각만 받는다. 자주 쓰는 한글(KS X 1001 2350자)은 앞 조각에 모은다.
2. 결과: public/fonts/noto-sans-kr/<이름>.ttf 와 manifest.json(조각 → 코드 포인트 범위)

사용법: python build_fonts.py 원본_가변글꼴.ttf 출력_폴더
필요: fonttools
"""

import json
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


def ranges(codes):
    """정렬된 코드 포인트 목록 → [[시작, 끝], ...]"""
    out = []
    for c in sorted(codes):
        if out and c == out[-1][1] + 1:
            out[-1][1] = c
        else:
            out.append([c, c])
    return out


def is_ksx1001(ch):
    # 파이썬 euc-kr은 없는 음절을 8바이트 조합 순서로 바꾸므로 2바이트인지로 판별한다.
    try:
        return len(ch.encode("euc-kr")) == 2
    except UnicodeEncodeError:
        return False


def chunked(seq, n):
    if not seq:
        return []
    size = (len(seq) + n - 1) // n
    return [seq[i : i + size] for i in range(0, len(seq), size)]


def main(src, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    font = TTFont(src)
    static = instancer.instantiateVariableFont(font, {"wght": 400})
    static_path = os.path.join(out_dir, "_static.ttf")
    static.save(static_path)
    cmap = TTFont(static_path).getBestCmap()
    codes = sorted(cmap.keys())

    def in_range(c, lo, hi):
        return lo <= c <= hi

    groups = {}
    base = [c for c in codes if c < 0x1100 or in_range(c, 0x2000, 0x2BFF) or in_range(c, 0x3000, 0x303F) or in_range(c, 0xFF00, 0xFFEF)]
    groups["base"] = base
    groups["jamo"] = [c for c in codes if in_range(c, 0x1100, 0x11FF) or in_range(c, 0x3130, 0x318F) or in_range(c, 0x3200, 0x33FF) or in_range(c, 0xA960, 0xA97F) or in_range(c, 0xD7B0, 0xD7FF)]
    syl = [c for c in codes if in_range(c, 0xAC00, 0xD7A3)]
    common = [c for c in syl if is_ksx1001(chr(c))]
    rare = [c for c in syl if not is_ksx1001(chr(c))]
    for i, part in enumerate(chunked(common, 2)):
        groups[f"hangul-common-{i}"] = part
    for i, part in enumerate(chunked(rare, 6)):
        groups[f"hangul-{i}"] = part
    han = [c for c in codes if in_range(c, 0x3400, 0x9FFF) or in_range(c, 0xF900, 0xFAFF) or c >= 0x20000]
    han_common = [c for c in han if is_ksx1001(chr(c))]
    han_rare = [c for c in han if not is_ksx1001(chr(c))]
    for i, part in enumerate(chunked(han_common, 2)):
        groups[f"hanja-common-{i}"] = part
    for i, part in enumerate(chunked(han_rare, 4)):
        groups[f"hanja-{i}"] = part
    used = set()
    for v in groups.values():
        used.update(v)
    rest = [c for c in codes if c not in used]
    if rest:
        groups["rest"] = rest

    manifest = {"family": "Noto Sans KR", "weight": 400, "unitsPerEm": 1000, "chunks": []}
    for name, part in groups.items():
        if not part:
            continue
        opts = subset.Options()
        opts.layout_features = []
        opts.hinting = False
        opts.notdef_outline = True
        opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
        opts.drop_tables += ["GSUB", "GPOS", "GDEF", "BASE", "vhea", "vmtx", "STAT", "gasp", "prep", "DSIG"]
        f = TTFont(static_path)
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=part)
        sub.subset(f)
        path = os.path.join(out_dir, f"{name}.ttf")
        f.save(path)
        manifest["chunks"].append({"file": f"{name}.ttf", "ranges": ranges(part), "size": os.path.getsize(path)})
        print(name, len(part), os.path.getsize(path))
    os.remove(static_path)
    with open(os.path.join(out_dir, "manifest.json"), "w") as fp:
        json.dump(manifest, fp, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
