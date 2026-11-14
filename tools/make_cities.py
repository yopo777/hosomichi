# -*- coding: utf-8 -*-
"""
ほそみちナビ 🎨足あと「市ごとの塗り％」用のデータ cities.json を作るスクリプト

使い方:
  python make_cities.py kanto-latest.osm.pbf 配布データのフォルダ
  → 配布データのフォルダ/cities.json を作る（make_pack.py で作った t/ の道を数える・数分〜十数分）
  make_pack.py で道路データを作りなおしたら、これも作りなおす（道の数え方をアプリとそろえるため）
  できたら hosomichi-data リポジトリに入れて push

中身:
  {"v": 日付, "G": 0.001, "i0": 緯度番号のはじめ,
   "names": [市区町村名, …],
   "total": [その市の道の長さ(m), …],       … 配布データの道ぜんぶ（行き止まり・階段も入る。私有地・高速道路は配布データに入っていない）
   "rows":  [[経度番号のはじめ, 経度番号のおわり(含まない), 市の番号, …], …]}   … 約100mのマス目で、どのマスがどの市か（緯度の行ごと）
  アプリは 道の区間（way の何番目の区間）のまん中の点がどの市かを、このマス目で見る

データ: © OpenStreetMap contributors（ODbL）
"""
import sys, os, json, gzip, math, time, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_quests import osmium, RelH, rings, thin, beep

G = 0.001   # マス目の大きさ（約100m）
R = 6371000

def hav(la1, lo1, la2, lo2):   # アプリ（router.js）と同じ計算
    RAD = math.pi / 180
    a = math.sin((la2 - la1) * RAD / 2) ** 2 + math.cos(la1 * RAD) * math.cos(la2 * RAD) * math.sin((lo2 - lo1) * RAD / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

class WayH(osmium.SimpleHandler):   # 境界の線だけ
    def __init__(self, need):
        super().__init__(); self.need = need; self.ways = {}
    def way(self, w):
        if w.id in self.need: self.ways[w.id] = [n.ref for n in w.nodes]

class NodeH(osmium.SimpleHandler):   # 境界の点の座標だけ
    def __init__(self, need):
        super().__init__(); self.need = need; self.loc = {}
    def node(self, n):
        if n.id in self.need and n.location.valid(): self.loc[n.id] = (n.location.lat, n.location.lon)

def city_spans(polys):   # 市の中に入っているマス：緯度の行 i → [(j0, j1)…]（偶奇判定・マスのまん中で見る。線を1回なぞるだけで速い）
    xs = {}
    for r in polys:
        n = len(r)
        for k in range(n):
            (y1, x1), (y2, x2) = r[k], r[(k + 1) % n]   # 閉じていない輪も、はじめとさいごをつなぐ
            if y1 == y2: continue
            lo, hi = min(y1, y2), max(y1, y2)
            for i in range(math.ceil(lo / G - 0.5), math.ceil(hi / G - 0.5)):   # この線をまたぐ行（行のまん中 y=(i+0.5)G が lo〜hi の間）
                y = (i + 0.5) * G
                xs.setdefault(i, []).append(x1 + (x2 - x1) * (y - y1) / (y2 - y1))
    out = {}
    for i, v in xs.items():
        v.sort()
        sp = [(math.ceil(a / G - 0.5), math.ceil(b / G - 0.5)) for a, b in zip(v[0::2], v[1::2])]
        sp = [(a, b) for a, b in sp if b > a]
        if sp: out[i] = sp
    return out

def main():
    if len(sys.argv) != 3: print(__doc__); sys.exit(1)
    src, out = sys.argv[1], sys.argv[2]; T0 = time.time()
    tdir = os.path.join(out, "t")
    if not os.path.isdir(tdir): print(f"{tdir} がないよ（make_pack.py で作った配布データのフォルダを指定してね）"); sys.exit(1)
    print("1/4 市区町村の境界（relation）を読んでるよ…", flush=True)
    rh = RelH(); rh.apply_file(src)
    need_w = {w for _, ms in rh.city.values() for w, _ in ms}
    print(f"  市区町村 {len(rh.city)}", flush=True)
    print("2/4 境界の線（way）を読んでるよ…", flush=True)
    wh = WayH(need_w); wh.apply_file(src)
    need_n = {n for ns in wh.ways.values() for n in ns}
    print(f"3/4 境界の点 {len(need_n):,}個を読んでるよ…", flush=True)
    nh = NodeH(need_n); nh.apply_file(src)
    L = nh.loc
    # 市ごとの形 → マス目
    names, rowmap = [], {}
    for cid, (nm, ms) in sorted(rh.city.items(), key=lambda x: x[1][0]):
        polys = [thin([L[n] for n in r if n in L], 0.0002) for r in rings([w for w, _ in ms], wh.ways)]
        polys = [p for p in polys if len(p) > 3]
        if not polys: continue
        ci = len(names); names.append(nm)
        for i, sp in city_spans(polys).items():
            for j0, j1 in sp: rowmap.setdefault(i, []).append((j0, j1, ci))
    i0, i1 = min(rowmap), max(rowmap)
    rows = [[v for sp in sorted(rowmap.get(i, [])) for v in sp] for i in range(i0, i1 + 1)]
    def city_of(la, lo):
        row = rows[math.floor(la / G) - i0] if i0 <= math.floor(la / G) <= i1 else []
        j = math.floor(lo / G)
        for n in range(0, len(row), 3):
            if row[n] <= j < row[n + 1]: return row[n + 2]
        return -1
    # 配布データの道を数える（同じ道は1回だけ。区間のまん中の点がある市に足す）
    names_t = sorted(n for n in os.listdir(tdir) if n.endswith(".json.gz"))
    print(f"4/4 配布データの道 {len(names_t)}マスを数えてるよ…", flush=True)
    total = [0.0] * len(names); seen = set(); nseg = 0
    for n, fn in enumerate(names_t):
        el = json.loads(gzip.decompress(open(os.path.join(tdir, fn), "rb").read()))["elements"]
        nd = {e["id"]: (e["lat"], e["lon"]) for e in el if e["type"] == "node"}
        for e in el:
            if e["type"] != "way" or e["id"] in seen: continue
            seen.add(e["id"]); ns = e["nodes"]
            for k in range(len(ns) - 1):
                a, b = nd.get(ns[k]), nd.get(ns[k + 1])
                if not a or not b: continue
                c = city_of(round((a[0] + b[0]) / 2, 5), round((a[1] + b[1]) / 2, 5))
                if c >= 0: total[c] += hav(a[0], a[1], b[0], b[1]); nseg += 1
        if (n + 1) % 2000 == 0: print(f"  {n + 1}/{len(names_t)}マス（道 {len(seen):,}本）…", flush=True)
    o = {"v": datetime.date.today().isoformat(), "G": G, "i0": i0, "names": names, "total": [round(t) for t in total], "rows": rows,
         "license": "© OpenStreetMap contributors / ODbL https://www.openstreetmap.org/copyright"}
    path = os.path.join(out, "cities.json")
    with open(path, "w", encoding="utf-8") as f: json.dump(o, f, ensure_ascii=False, separators=(",", ":"))
    top = sorted(zip(names, total), key=lambda x: -x[1])[:5]
    print("  道が長い市: " + "・".join(f"{a} {b / 1000:,.0f}km" for a, b in top))
    print(f"できた！ 市区町村 {len(names)}・区間 {nseg:,} → cities.json {os.path.getsize(path) / 1048576:.1f}MB（{time.time() - T0:.0f}秒）")

if __name__ == "__main__":
    try: main()
    except BaseException:
        beep(False); raise
    beep(True)
