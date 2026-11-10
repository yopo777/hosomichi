# -*- coding: utf-8 -*-
"""
細道ルートナビ 配布用の道路データ（マス）を作るスクリプト

使い方:
  1. python -m pip install osmium
  2. python make_pack.py 出力フォルダ
     → Geofabrik から関東のデータ（kanto-latest.osm.pbf・数百MB）を自動でダウンロードして
       出力フォルダ/index.json と 出力フォルダ/t/緯度番号_経度番号.json.gz を作る
     （ダウンロードずみの pbf を使うときは: python make_pack.py kanto-latest.osm.pbf 出力フォルダ）
  3. 出力フォルダの中身を GitHub の hosomichi-data リポジトリに push して GitHub Pages で公開

データ: © OpenStreetMap contributors（ODbL）
メモリ: 関東ぜんぶ読むので 4〜8GB くらい使います
"""
import sys, os, re, json, gzip, math, time, datetime
from collections import defaultdict
import urllib.request
import osmium

PBF_URL = "https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf"

def download(path):   # 1日以内にダウンロードしたものがあれば、それを使う
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 86400:
        print(f"ダウンロードずみの {path} を使うよ"); return
    print(f"ダウンロード中: {PBF_URL}")
    tmp = path + ".part"
    req = urllib.request.Request(PBF_URL, headers={"User-Agent": "hosomichi-make_pack/1.0"})
    with urllib.request.urlopen(req) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0); done = 0; t0 = time.time(); last = 0
        while True:
            b = r.read(1 << 20)
            if not b: break
            f.write(b); done += len(b)
            if time.time() - last > 2:
                last = time.time()
                print(f"  {done / 1048576:.0f}" + (f"/{total / 1048576:.0f}MB（{done * 100 // total}%）" if total else "MB"), flush=True)
    os.replace(tmp, path)
    print(f"ダウンロードできた: {done / 1048576:.0f}MB（{time.time() - t0:.0f}秒）")

T = 0.01   # 1マス＝0.01度（約900m×1.1km）。アプリの大きいマスと同じ
# 配るはんい（南, 西, 北, 東）。四角をいくつか組み合わせる
AREAS = {
    "関東一円": (34.88, 138.38, 37.17, 140.90),   # 1都6県（伊豆諸島・小笠原はのぞく）。データのない海などのマスは作らない
}
BAND_ROWS = 80   # 一度に作るのは緯度80マスぶん（約90km）まで。メモリを使いすぎないように、何回かに分けて読む
# アプリの Overpass の取り方と同じ道をえらぶ
EXCL = re.compile(r"^(motorway|motorway_link|construction|proposed|platform|corridor|elevator|raceway|bus_guideway|bus_stop)$")
# 小さくするため、ルート計算に使うタグだけ残す
WAY_KEYS = {"highway", "access", "bicycle", "foot", "oneway", "oneway:bicycle", "lanes", "lanes:forward", "lanes:backward",
            "lanes:both_ways", "turn:lanes", "turn:lanes:forward", "turn:lanes:backward", "bridge", "tunnel", "layer",
            "surface", "tracktype", "ramp:bicycle", "service", "junction", "sidewalk", "cycleway", "segregated", "name", "ref", "maxspeed",
            "footway", "crossing", "sidewalk:both", "sidewalk:left", "sidewalk:right", "cycleway:both", "cycleway:left", "cycleway:right",
            "lane_markings", "width", "kerb", "barrier"}
NODE_KEYS = {"highway", "crossing", "crossing:signals", "railway", "barrier"}

# ---- 旧街道（古道）の目印 ----
# 道に kodo=2（旧街道：旧東海道・旧中山道・甲州道中など）/ kodo=1（「国道○号旧道」みたいなバイパスにされた旧道）をつける
# check_kodo.py の結果から：名前（name・old_name など）と、まとまり（relation：旧東海道 2479本など）の両方で見る
KODO2 = re.compile(r"^旧.+(街道|道中|往還|海道|山道)$|.(道中|往還|古道)$")   # 旧大山街道・旧中山道・甲州道中・旧秩父往還…
KODO2_OLD = re.compile(r"(街道|道中|往還|海道|山道|古道)$")               # old_name / historic:name なら「旧」がなくてもOK
KODO1 = re.compile(r"旧道$|^旧(国道|県道|都道|道道|府道)")                  # 国道294号旧道・つくば真岡線旧道・旧都道424号…
NAME_KEYS = ("name", "alt_name", "official_name", "loc_name", "old_name", "historic:name")
KODO_ROUTES = ("road", "hiking", "foot")   # バス・自転車ルートは見ない
NO_KODO_HW = {"trunk", "trunk_link"}      # 国道1号・第一京浜など（old_name=東海道）は目印をつけない

def clean(v): return re.sub(r"[（(][^）)]*[）)]", "", v).strip()   # 「国道4号（旧陸羽街道）」→「国道4号」

def kodo_level(tags):   # tags は .get が使えるもの（osmium の TagList か dict）
    lv = 0
    for k in NAME_KEYS:
        v = tags.get(k)
        if not v: continue
        for s in v.split(";"):
            s = clean(s)
            if KODO2.search(s) or (k in ("old_name", "historic:name") and KODO2_OLD.search(s)): return 2
            if KODO1.search(s): lv = 1
    if tags.get("historic") in ("road", "route"): return 2
    return lv

class RelH(osmium.SimpleHandler):   # 最初に1回だけ：まとまり（relation）だけ読んで、旧街道の道の番号を集める
    def __init__(self):
        super().__init__()
        self.ways = {}   # relation番号 -> [道の番号]
        self.subs = {}   # relation番号 -> [子どもの relation番号]（五街道 → 旧東海道… みたいな入れ子）
        self.lv = {}     # relation番号 -> 1 or 2
    def relation(self, r):
        t = {k: v for k, v in r.tags}
        if t.get("type") != "route" or t.get("route") not in KODO_ROUTES: return
        self.ways[r.id] = [m.ref for m in r.members if m.type == "w"]
        self.subs[r.id] = [m.ref for m in r.members if m.type == "r"]
        lv = kodo_level(t)
        if not lv and t.get("network") == "JP:Gokaido": lv = 2
        if not lv and t.get("route") == "road" and re.search(r"(街道|道中|往還)$", clean(t.get("name", ""))) \
                and any("旧" in v or "古" in v for v in t.values()): lv = 2   # 黒羽街道・塩原街道など（説明などに「旧」）
        if lv: self.lv[r.id] = lv

def kodo_ways(src):
    t0 = time.time()
    print(f"旧街道をさがし中: {src}（まとまりだけ読むよ）", flush=True)
    h = RelH(); h.apply_file(src)
    out = {}
    def put(rid, lv, seen):
        if rid in seen: return
        seen.add(rid)
        for w in h.ways.get(rid, ()):
            if out.get(w, 0) < lv: out[w] = lv
        for c in h.subs.get(rid, ()): put(c, lv, seen)
    for rid, lv in h.lv.items(): put(rid, lv, set())
    n2 = sum(1 for v in h.lv.values() if v == 2)
    print(f"  旧街道のまとまり {n2}個・旧道のまとまり {len(h.lv) - n2}個 → 道 {len(out):,}本（{time.time() - t0:.0f}秒）", flush=True)
    return out

def tile_ok(i, j):   # このマスが配るはんいにかかっているか
    s, w, n, e = i * T, j * T, (i + 1) * T, (j + 1) * T
    return any(s < N and n > S and w < E and e > W for (S, W, N, E) in AREAS.values())

S0 = min(a[0] for a in AREAS.values()); W0 = min(a[1] for a in AREAS.values())
N0 = max(a[2] for a in AREAS.values()); E0 = max(a[3] for a in AREAS.values())
WANT = {(i, j) for i in range(math.floor(S0 / T), math.floor(N0 / T) + 1)
        for j in range(math.floor(W0 / T), math.floor(E0 / T) + 1) if tile_ok(i, j)}

class H(osmium.SimpleHandler):
    def __init__(self, i0, i1, kodo):   # 緯度の番号 i0〜i1 のマスだけ作る
        super().__init__()
        self.i0, self.i1, self.kodo = i0, i1, kodo
        self.nk = 0
        self.la0, self.la1 = i0 * T - 0.05, (i1 + 1) * T + 0.05
        self.ntags = {}                     # 信号・横断歩道・踏切などのタグがある点だけ
        self.tiles = defaultdict(list)      # (i,j) -> 道のリスト
        self.nw = 0
    def node(self, n):
        if not n.tags or not n.location.valid(): return
        la, lo = n.location.lat, n.location.lon
        if not (self.la0 < la < self.la1 and W0 - 0.05 < lo < E0 + 0.05): return
        t = {k: v for k, v in n.tags if k in NODE_KEYS}
        if t: self.ntags[n.id] = t
    def way(self, w):
        tg = w.tags
        hw = tg.get("highway")
        if not hw or EXCL.match(hw): return
        if tg.get("access") in ("no", "private"): return
        if tg.get("service") in ("parking_aisle", "drive-through"): return
        pts = []
        for nd in w.nodes:
            if nd.location.valid(): pts.append((nd.ref, round(nd.location.lat, 7), round(nd.location.lon, 7)))
        if len(pts) < 2: return
        if max(p[1] for p in pts) < self.i0 * T or min(p[1] for p in pts) >= (self.i1 + 1) * T: return   # この帯にかからない道
        cells = set()
        for (a, b) in zip(pts, pts[1:]):   # 線のとちゅうも見る（マスを横切るだけの道もひろう）
            k = max(1, math.ceil(max(abs(b[1] - a[1]), abs(b[2] - a[2])) / (T / 4)))
            for s in range(k + 1):
                la = a[1] + (b[1] - a[1]) * s / k; lo = a[2] + (b[2] - a[2]) * s / k
                cells.add((math.floor(la / T), math.floor(lo / T)))
        cells = {c for c in cells if c in WANT and self.i0 <= c[0] <= self.i1}
        if not cells: return
        keep = {k: v for k, v in tg if k in WAY_KEYS}
        if hw not in NO_KODO_HW:
            kd = max(kodo_level(tg), self.kodo.get(w.id, 0))
            if kd: keep["kodo"] = str(kd); self.nk += 1
        rec = (w.id, tuple(pts), keep)
        for c in cells: self.tiles[c].append(rec)
        self.nw += 1
        if self.nw % 100000 == 0: print(f"  道 {self.nw:,} 本…", flush=True)

def main():
    if len(sys.argv) == 2:
        out = sys.argv[1]; src = "kanto-latest.osm.pbf"; download(src)
    elif len(sys.argv) == 3:
        src, out = sys.argv[1], sys.argv[2]
    else:
        print(__doc__); sys.exit(1)
    os.makedirs(os.path.join(out, "t"), exist_ok=True)
    t0 = time.time()
    rows = sorted({i for (i, _) in WANT}); r0, r1 = rows[0], rows[-1]
    bands = [(a, min(a + BAND_ROWS - 1, r1)) for a in range(r0, r1 + 1, BAND_ROWS)]
    print(f"はんい {len(WANT)}マス（海などデータのない所は作らない）・{len(bands)}回に分けて読むよ")
    kodo = kodo_ways(src)
    keys, total = [], 0
    old = set(os.listdir(os.path.join(out, "t")))
    for bn, (i0, i1) in enumerate(bands):
        tb = time.time()
        print(f"[{bn + 1}/{len(bands)}] 読みこみ中: {src}（北緯 {i0 * T:.2f}〜{(i1 + 1) * T:.2f}）", flush=True)
        h = H(i0, i1, kodo)
        h.apply_file(src, locations=True, idx="flex_mem")
        print(f"  道 {h.nw:,} 本（旧街道・旧道 {h.nk:,} 本）・信号などの点 {len(h.ntags):,} 個（{time.time() - tb:.0f}秒）", flush=True)
        for n, ((i, j), recs) in enumerate(sorted(h.tiles.items())):
            nodes = {}
            for (_, pts, _) in recs:
                for (nid, la, lo) in pts: nodes[nid] = (la, lo)
            el = []
            for nid, (la, lo) in nodes.items():
                e = {"type": "node", "id": nid, "lat": la, "lon": lo}
                if nid in h.ntags: e["tags"] = h.ntags[nid]
                el.append(e)
            for (wid, pts, tags) in recs:
                el.append({"type": "way", "id": wid, "nodes": [p[0] for p in pts], "tags": tags})
            data = json.dumps({"elements": el}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            name = f"{i}_{j}.json.gz"
            gz = gzip.compress(data, compresslevel=9, mtime=0)   # mtime=0：中身が同じならファイルも同じ（gitの差分が小さい）
            with open(os.path.join(out, "t", name), "wb") as f: f.write(gz)
            old.discard(name)
            keys.append(f"{i}_{j}"); total += len(gz)
            if (n + 1) % 2000 == 0: print(f"  書き出し {n + 1}/{len(h.tiles)}マス…", flush=True)
        print(f"  {len(h.tiles)}マス書いたよ（ここまで {len(keys)}マス・{total / 1048576:.0f}MB・{(time.time() - t0) / 60:.0f}分）", flush=True)
        del h
    for name in old: os.remove(os.path.join(out, "t", name))   # はんい外になった古いマス
    v = datetime.datetime.fromtimestamp(os.path.getmtime(src)).strftime("%Y-%m-%d")
    idx = {"v": v, "T": T, "kodo": 1, "areas": AREAS, "bytes": total, "keys": keys,
           "license": "© OpenStreetMap contributors / ODbL https://www.openstreetmap.org/copyright"}
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as f: json.dump(idx, f, ensure_ascii=False, separators=(",", ":"))
    open(os.path.join(out, ".nojekyll"), "w").close()   # GitHub Pages でそのまま配る（変換しない）
    with open(os.path.join(out, "README.md"), "w", encoding="utf-8") as f:
        f.write("# hosomichi-data\n\n[細道ルートナビ](https://yopo777.github.io/hosomichi/) 用の道路データ（約1km角のマスごと）です。\n\n"
                f"- はんい: {'・'.join(AREAS.keys())}\n- 地図の日付: {v}\n- {len(keys)}マス・{total / 1048576:.0f}MB\n\n"
                "データ: © OpenStreetMap contributors。Open Database License（ODbL）で提供します。\n"
                "https://www.openstreetmap.org/copyright\n\n"
                "Geofabrik の OpenStreetMap データ（https://download.geofabrik.de/）から作っています。\n")
    print(f"できた！ {len(keys)}マス・{total / 1048576:.1f}MB（データの日付 {v}・{time.time() - t0:.0f}秒）→ {out}")

if __name__ == "__main__":
    main()
