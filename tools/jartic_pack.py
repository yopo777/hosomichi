#!/usr/bin/env python3
"""JARTIC 交通規制情報（拡張版標準フォーマット k_2.1 の CSV）→ ほそみちナビ用の小さいファイル（タイルと同じ 0.01° マス）

つかいかた:
  python3 tools/jartic_pack.py 出力フォルダ 千葉県警_202609_k_2_1.csv [警視庁_....csv ...]

出力: 出力フォルダ/j/{緯度×100}_{経度×100}.json.gz（タイル t/ と同じ名前）
  { "v": 1, "src": [...],
    "xw":  [[lat, lon], ...]            横断歩道（85）
    "bx":  [[lat, lon], ...]            自転車横断帯（87）
    "sig": [[lat, lon], ...]            信号機設置（98）
    "ow":  [{"p": [[lat, lon], ...], "b": 0/1, "h": "0700-0900"}]   一方通行（11）。p は通ってよい向きの順。
            b=1：自転車は除く（自転車は逆向きもOK）。h：時間つき（ないときは一日中）
    "nx":  [[[lat, lon], ...], ...]     歩行者等横断禁止（14）の線
    "ln":  [[[lat, lon], ...], ...]     車両通行帯（20）の線（いまは分析用）
  }
出典：公益財団法人 日本道路交通情報センター（JARTIC）交通規制情報オープンデータ
"""
import csv, gzip, json, math, os, sys
from collections import defaultdict

KEEP = {"85": "xw", "87": "bx", "98": "sig", "11": "ow", "14": "nx", "20": "ln"}


def digit(code, k):   # 対象・除外車両コード：右から k けた目が 1 か（10の累乗の足し算）
    code = (code or "").strip()
    return len(code) >= k and code[-k] == "1"


def bike_target(r, n=1):   # その規制が自転車にもかかるか（対象車両：A の1けた目＝車両、D の3けた目＝自転車・6けた目＝軽車両）
    A, D = r.get(f"対象車両コード{n}_A", ""), r.get(f"対象車両コード{n}_D", "")
    if not (A or r.get(f"対象車両コード{n}_B") or r.get(f"対象車両コード{n}_C") or D):
        return True   # 書いてない＝車両ぜんぶ
    return digit(A, 1) or digit(D, 3) or digit(D, 6)


def bike_excluded(r, n=1):   # 除外車両に 自転車（D3）か 軽車両（D6）
    D = r.get(f"除外車両コード{n}_D", "")
    return digit(D, 3) or digit(D, 6)


def pts_of(s):
    out = []
    for q in (s or "").split(";"):
        a = q.split()
        if len(a) == 2:
            try:
                lon, lat = float(a[0]), float(a[1])
                out.append([round(lat, 6), round(lon, 6)])
            except ValueError:
                pass
    return out


def tiles_of(pts):   # 線が通るマスぜんぶ（はしの点の四角＋点ごと）
    la = [p[0] for p in pts]; lo = [p[1] for p in pts]
    i0, i1 = math.floor(min(la) * 100), math.floor(max(la) * 100)
    j0, j1 = math.floor(min(lo) * 100), math.floor(max(lo) * 100)
    return [(i, j) for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)]


def read_csv(path):
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "cp932"):
        try:
            return list(csv.DictReader(raw.decode(enc).splitlines()))
        except UnicodeDecodeError:
            continue
    raise SystemExit("文字コードがわからない: " + path)


def main():
    out, files = sys.argv[1], sys.argv[2:]
    T = defaultdict(lambda: defaultdict(list))
    src, stat = [], defaultdict(int)
    for f in files:
        rows = read_csv(f)
        src.append(os.path.basename(f))
        for r in rows:
            k = KEEP.get(r.get("共通規制種別コード"))
            if not k or r.get("意思決定廃止日"):
                continue
            pts = pts_of(r.get("規制場所の経度緯度"))
            if not pts:
                continue
            if k in ("xw", "bx", "sig"):
                p = pts[0]
                T[(math.floor(p[0] * 100), math.floor(p[1] * 100))][k].append(p)
                stat[k] += 1
                continue
            if len(pts) < 2:
                continue
            if k == "ow":
                if r.get("指定・禁止方向の別コード") == "1":
                    pts = pts[::-1]   # 1＝禁止する向きの順 → 通ってよい向きにする
                if not bike_target(r) or bike_excluded(r):
                    item = {"p": pts, "b": 1}; stat["ow_bike_ok"] += 1
                else:
                    item = {"p": pts, "b": 0}
                h0, h1 = r.get("規制時間1_開始", ""), r.get("規制時間1_終了", "")
                if h0 and h1 and not (h0 == "0" and h1 == "2400"):
                    item["h"] = f"{int(h0):04d}-{int(h1):04d}"; stat["ow_time"] += 1
            else:
                item = pts
            stat[k] += 1
            for t in tiles_of(pts):
                T[t][k].append(item)
    os.makedirs(os.path.join(out, "j"), exist_ok=True)
    size = 0
    for (i, j), d in T.items():
        d = {"v": 1, "src": src, **d}
        b = gzip.compress(json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode(), 9)
        open(os.path.join(out, "j", f"{i}_{j}.json.gz"), "wb").write(b)
        size += len(b)
    print("マス", len(T), "ぜんぶで", round(size / 1e6, 2), "MB", dict(stat))


if __name__ == "__main__":
    main()
