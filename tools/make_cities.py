# -*- coding: utf-8 -*-
"""
ほそみちナビ 🎨足あと「市ごとの塗り％」用のデータ cities.json を作るスクリプト

使い方:
  python make_cities.py kanto-latest.osm.pbf,kansai-latest.osm.pbf,chubu-latest.osm.pbf 配布データのフォルダ
  → 配布データのフォルダ/cities.json を作る（make_pack.py で作った t/ の道を数える・数分〜十数分）
  make_pack.py で道路データを作りなおしたら、これも作りなおす（道の数え方をアプリとそろえるため）
  できたら hosomichi-data リポジトリに入れて push

中身:
  {"v": 日付, "G": 0.001, "i0": 緯度番号のはじめ,
   "names": [市区町村名, …],
   "total": [その市の道の長さ(m), …],       … 政令市は区ごと（「千葉市花見川区」。区にわかれた市そのものは 0 になる）       … 配布データの道ぜんぶ（行き止まり・階段も入る。私有地・高速道路は配布データに入っていない）
   "rows":  [[経度番号のはじめ, 経度番号のおわり(含まない), 市の番号, …], …]}   … 約100mのマス目で、どのマスがどの市か（緯度の行ごと）
  アプリは 道の区間（way の何番目の区間）のまん中の点がどの市かを、このマス目で見る

データ: © OpenStreetMap contributors（ODbL）
"""
import sys, os, json, gzip, math, time, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_quests import osmium, rings, thin, beep, apply_all
from make_pack import tile_els   # 配布データ v1 でも v2 でも elements にする

G = 0.001   # マス目の大きさ（約100m）
R = 6371000

def hav(la1, lo1, la2, lo2):   # アプリ（router.js）と同じ計算
    RAD = math.pi / 180
    a = math.sin((la2 - la1) * RAD / 2) ** 2 + math.cos(la1 * RAD) * math.cos(la2 * RAD) * math.sin((lo2 - lo1) * RAD / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

class RelH(osmium.SimpleHandler):   # 市区町村（admin_level=7）と 政令市の区（admin_level=8 で「区」で終わるもの）
    def __init__(self):
        super().__init__(); self.city = {}; self.ward = {}
    def relation(self, r):
        t = r.tags
        if t.get("boundary") != "administrative" or not t.get("name"): return
        lv, nm = t.get("admin_level"), t["name"]
        if lv == "7": self.city[r.id] = (nm, [(m.ref, m.role) for m in r.members if m.type == "w"])
        elif lv == "8" and nm.endswith("区"): self.ward[r.id] = (nm, [(m.ref, m.role) for m in r.members if m.type == "w"])

def paint(row, j0, j1, ci):   # 行のぬり分け [(j0, j1, 市の番号)…] に、あとから区をぬる（重なった所は区になる）
    out = []
    for a, b, c in row:
        if b <= j0 or a >= j1: out.append((a, b, c)); continue
        if a < j0: out.append((a, j0, c))
        if b > j1: out.append((j1, b, c))
    out.append((j0, j1, ci)); out.sort(); return out

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
    rh = RelH(); apply_all(rh, src)
    need_w = {w for _, ms in list(rh.city.values()) + list(rh.ward.values()) for w, _ in ms}
    print(f"  市区町村 {len(rh.city)}・政令市の区 {len(rh.ward)}", flush=True)
    print("2/4 境界の線（way）を読んでるよ…", flush=True)
    wh = WayH(need_w); apply_all(wh, src)
    need_n = {n for ns in wh.ways.values() for n in ns}
    print(f"3/4 境界の点 {len(need_n):,}個を読んでるよ…", flush=True)
    nh = NodeH(need_n); apply_all(nh, src)
    L = nh.loc
    # 市ごとの形 → マス目。政令市は、そのあと区でぬりなおす（名前は「千葉市花見川区」）
    names, rowmap = [], {}
    def shape(ms):
        polys = [thin([L[n] for n in r if n in L], 0.0002) for r in rings([w for w, _ in ms], wh.ways)]
        return city_spans([p for p in polys if len(p) > 3])
    def at(i, j):
        for a, b, c in rowmap.get(i, []):
            if a <= j < b: return c
        return -1
    for cid, (nm, ms) in sorted(rh.city.items(), key=lambda x: x[1][0]):
        sp = shape(ms)
        if not sp: continue
        ci = len(names); names.append(nm)
        for i, v in sp.items():
            for j0, j1 in v: rowmap.setdefault(i, []).append((j0, j1, ci))
    for i in rowmap: rowmap[i].sort()
    nward = 0
    for cid, (nm, ms) in sorted(rh.ward.items(), key=lambda x: x[1][0]):
        sp = shape(ms)
        if not sp: continue
        i = sorted(sp)[len(sp) // 2]; j0, j1 = sp[i][0]; pc = at(i, (j0 + j1) // 2)   # まん中あたりのマスで、どの市の区か見る
        if pc < 0: continue
        pn = names[pc]
        ci = len(names); names.append(nm if nm.startswith(pn) else pn + nm); nward += 1
        for i, v in sp.items():
            for j0, j1 in v: rowmap[i] = paint(rowmap.get(i, []), j0, j1, ci)
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
    total = [0.0] * len(names); nseg = 0
    TT = 0.01
    for n, fn in enumerate(names_t):
        ti, tj = (int(x) for x in fn[:-8].split("_"))
        el = tile_els(json.loads(gzip.decompress(open(os.path.join(tdir, fn), "rb").read())))
        nd = {e["id"]: (e["lat"], e["lon"]) for e in el if e["type"] == "node"}
        seen = set()
        for e in el:
            if e["type"] != "way": continue
            ns = e["nodes"]
            for k in range(len(ns) - 1):
                u, v = ns[k], ns[k + 1]; key = (u, v) if u < v else (v, u)
                if key in seen: continue
                a, b = nd.get(u), nd.get(v)
                if not a or not b: continue
                ml, mo = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
                if math.floor(ml / TT) != ti or math.floor(mo / TT) != tj: continue   # 区間は まん中の点があるマスで1回だけ数える
                seen.add(key)
                c = city_of(round(ml, 5), round(mo, 5))
                if c >= 0: total[c] += hav(a[0], a[1], b[0], b[1]); nseg += 1
        if (n + 1) % 2000 == 0: print(f"  {n + 1}/{len(names_t)}マス（区間 {nseg:,}）…", flush=True)
    o = {"v": datetime.date.today().isoformat(), "G": G, "i0": i0, "names": names, "total": [round(t) for t in total], "rows": rows,
         "license": "© OpenStreetMap contributors / ODbL https://www.openstreetmap.org/copyright"}
    path = os.path.join(out, "cities.json")
    with open(path, "w", encoding="utf-8") as f: json.dump(o, f, ensure_ascii=False, separators=(",", ":"))
    top = sorted(zip(names, total), key=lambda x: -x[1])[:5]
    print("  道が長い市: " + "・".join(f"{a} {b / 1000:,.0f}km" for a, b in top))
    print(f"できた！ 市区町村 {len(names) - nward}＋政令市の区 {nward}・区間 {nseg:,} → cities.json {os.path.getsize(path) / 1048576:.1f}MB（{time.time() - T0:.0f}秒）")

if __name__ == "__main__":
    try: main()
    except BaseException:
        beep(False); raise
    beep(True)
