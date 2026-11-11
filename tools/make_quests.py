# -*- coding: utf-8 -*-
"""
細道ルートナビ クエスト用のデータ quests.json を作るスクリプト（サーバーいらずにするため）

使い方:
  python make_quests.py kanto-latest.osm.pbf 出力フォルダ
  → 出力フォルダ/quests.json を作る（make_pack.py と同じ pbf を使う・数分）
  できたら hosomichi-data リポジトリに入れて push

中身:
  {"v": 日付,
   "lines":  [[路線名, 会社, [[駅名, 緯度, 経度], …]], …],          … 路線の駅ぜんぶ（走る順）
   "cities": [[市区町村名, {"station": [[名前, 緯度, 経度], …], "shrine": […], "temple": […]}], …]}
              … 市区町村の駅・神社・お寺ぜんぶ（境界は admin_level=7）

データ: © OpenStreetMap contributors（ODbL）
"""
import sys, os, re, json, time, datetime
from collections import defaultdict
try:
    import osmium
except ImportError as e:
    # Windows のスマートアプリコントロールが osmium の「area」部品（DLL）だけ止めることがある。
    # このスクリプトは area を使わないので、身代わりを置いて読みこまないようにする
    if "area" not in str(e) and "アプリケーション制御" not in str(e): raise
    import types
    for k in [k for k in sys.modules if k == "osmium" or k.startswith("osmium.")]: del sys.modules[k]
    stub = types.ModuleType("osmium.area")
    class AreaManager:
        def __init__(self, *a, **k): raise RuntimeError("osmium の area 部品が Windows に止められているので使えないよ")
    stub.AreaManager = AreaManager
    sys.modules["osmium.area"] = stub
    import osmium
    print("（osmium の area 部品は Windows に止められていたので、使わずに動かすよ）", flush=True)

RAIL = {"train", "subway", "light_rail", "monorail", "tram"}
def clean(v): return re.sub(r"\s*[（(][^）)]*[）)]\s*", "", v or "").strip()   # 「千代田線（綾瀬→代々木上原）」→「千代田線」
def sta_name(v): return re.sub(r"駅$", "", (v or "").strip())
def is_station(t): return t.get("railway") in ("station", "halt") or (t.get("public_transport") == "station" and t.get("train") == "yes")
def pow_kind(t):   # 神社・お寺
    if t.get("amenity") != "place_of_worship" or not t.get("name"): return None
    r = t.get("religion")
    return "shrine" if r == "shinto" else "temple" if r == "buddhist" else None

# ---- 1回目：relation（市区町村の境界・路線）----
class RelH(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.city = {}      # 境界 relation id → (名前, [(way id, 役割)])
        self.route = {}     # 路線 relation id → (名前, 会社, [(node id, 役割)])
        self.master = {}    # route_master id → (名前, 会社, [route id])
    def relation(self, r):
        t = r.tags
        if t.get("boundary") == "administrative" and t.get("admin_level") == "7" and t.get("name"):
            self.city[r.id] = (t["name"], [(m.ref, m.role) for m in r.members if m.type == "w"])
        elif t.get("type") == "route" and t.get("route") in RAIL:
            self.route[r.id] = (t.get("name") or "", t.get("operator") or "", [(m.ref, m.role) for m in r.members if m.type == "n"])
        elif t.get("type") == "route_master" and t.get("route_master") in RAIL:
            self.master[r.id] = (t.get("name") or "", t.get("operator") or "", [m.ref for m in r.members if m.type == "r"])

# ---- 2回目：way（境界の線・面になっている神社とお寺）----
class WayH(osmium.SimpleHandler):
    def __init__(self, need):
        super().__init__(); self.need = need; self.ways = {}; self.pow = []   # pow: (種類, 名前, [node id])
    def way(self, w):
        if w.id in self.need: self.ways[w.id] = [n.ref for n in w.nodes]
        k = pow_kind(w.tags)
        if k: self.pow.append((k, w.tags["name"], [n.ref for n in w.nodes]))

# ---- 3回目：node（座標・駅・点の神社とお寺）----
class NodeH(osmium.SimpleHandler):
    def __init__(self, need):
        super().__init__(); self.need = need; self.loc = {}; self.name = {}; self.sta = []; self.pow = []
    def node(self, n):
        if not n.location.valid(): return
        la, lo = n.location.lat, n.location.lon
        if n.id in self.need:
            self.loc[n.id] = (la, lo)
            if n.tags.get("name"): self.name[n.id] = n.tags["name"]
        if not n.tags: return
        if is_station(n.tags) and n.tags.get("name"): self.sta.append((sta_name(n.tags["name"]), la, lo))
        k = pow_kind(n.tags)
        if k: self.pow.append((k, n.tags["name"], la, lo))

def rings(way_ids, ways):   # way をつないで輪にする（端と端が同じ node のものをつなぐ）
    segs = [list(ways[w]) for w in way_ids if w in ways and len(ways[w]) > 1]
    out = []
    while segs:
        r = segs.pop()
        while r[0] != r[-1]:
            for i, s in enumerate(segs):
                if s[0] == r[-1]: r += s[1:]; break
                if s[-1] == r[-1]: r += s[-2::-1]; break
            else: break   # つながらない（pbf のはしで切れている）→ そのまま使う
            segs.pop(i)
        if len(r) > 3: out.append(r)
    return out

def thin(r, d=0.0008):   # 境界の点を約80mおきに間引く（判定を速くするため。境い目ぎりぎりの所は少しずれてもOK）
    if len(r) < 4: return r
    k = [r[0]]
    for p in r[1:-1]:
        if abs(p[0] - k[-1][0]) + abs(p[1] - k[-1][1]) > d: k.append(p)
    k.append(r[-1]); return k

def inside(polys, la, lo):   # 偶奇判定（外の輪も穴も同じあつかいでOK）
    c = False
    for r in polys:
        for i in range(len(r) - 1):
            (y1, x1), (y2, x2) = r[i], r[i + 1]
            if (y1 > la) != (y2 > la) and lo < (x2 - x1) * (la - y1) / (y2 - y1) + x1: c = not c
    return c

def merge_line(stop_lists):   # いちばん駅が多い向きを土台に、支線の駅を「ひとつ前の駅」のうしろに入れる（アプリと同じ）
    out = []
    for r in sorted(stop_lists, key=len, reverse=True):
        prev = -1
        for s in r:
            i = next((k for k, o in enumerate(out) if o[0] == s[0]), -1)
            if i >= 0: prev = i; continue
            out.insert(prev + 1, s); prev += 1
    return out

def dedup(pts, d=0.01):   # 同じ名前で近い点は1つに（ホームごとの点・JRと私鉄の同じ駅など）
    keep = []
    for p in pts:
        if all(p[0] != q[0] or abs(p[1] - q[1]) + abs(p[2] - q[2]) > d for q in keep): keep.append(p)
    return keep

def main():
    if len(sys.argv) != 3: print(__doc__); sys.exit(1)
    src, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True); T0 = time.time()
    print("1/3 relation（境界・路線）を読んでるよ…", flush=True)
    rh = RelH(); rh.apply_file(src)
    print(f"  市区町村 {len(rh.city)}・路線 {len(rh.route)}（まとめ {len(rh.master)}）", flush=True)
    need_w = {w for _, ms in rh.city.values() for w, _ in ms}
    print("2/3 way（境界の線・神社とお寺の面）を読んでるよ…", flush=True)
    wh = WayH(need_w); wh.apply_file(src)
    need_n = {n for ns in wh.ways.values() for n in ns} | {n for _, _, ns in wh.pow for n in ns}
    need_n |= {n for _, _, ms in rh.route.values() for n, _ in ms}
    print(f"3/3 node（座標 {len(need_n):,}点・駅・神社・お寺）を読んでるよ…", flush=True)
    nh = NodeH(need_n); nh.apply_file(src)
    L = nh.loc

    # 路線
    def stops(rid):
        _, _, ms = rh.route[rid]
        st = [m for m, role in ms if role.startswith("stop")] or [m for m, role in ms if role.startswith("platform")]
        return [(sta_name(nh.name[m]), round(L[m][0], 5), round(L[m][1], 5)) for m in st if m in L and m in nh.name]
    lines, used = [], set()
    for mid, (nm, op, rids) in rh.master.items():
        rs = [stops(r) for r in rids if r in rh.route]; used |= set(rids)
        st = merge_line([r for r in rs if r])
        if nm and len(st) >= 2: lines.append([clean(nm), op, [list(s) for s in st]])
    grp = defaultdict(list)   # route_master がない路線は、名前（かっこの中をとったもの）でまとめる
    for rid, (nm, op, _) in rh.route.items():
        if rid not in used and clean(nm): grp[(clean(nm), op)].append(stops(rid))
    for (nm, op), rs in grp.items():
        st = merge_line([r for r in rs if r])
        if len(st) >= 2: lines.append([nm, op, [list(s) for s in st]])
    lines.sort(key=lambda x: x[0])

    # 市区町村
    pts = [("station", n, la, lo) for n, la, lo in nh.sta] + nh.pow
    for k, n, ns in wh.pow:   # 面の神社・お寺は、まわりの点の平均
        ps = [L[x] for x in ns if x in L]
        if ps: pts.append((k, n, sum(p[0] for p in ps) / len(ps), sum(p[1] for p in ps) / len(ps)))
    cities = []
    for cid, (nm, ms) in rh.city.items():
        polys = [thin([L[n] for n in r if n in L]) for r in rings([w for w, _ in ms], wh.ways)]
        polys = [p for p in polys if len(p) > 3]
        if not polys: continue
        S = min(p[0] for r in polys for p in r); N = max(p[0] for r in polys for p in r)
        W = min(p[1] for r in polys for p in r); E = max(p[1] for r in polys for p in r)
        got = defaultdict(list)
        for k, n, la, lo in pts:
            if S <= la <= N and W <= lo <= E and inside(polys, la, lo): got[k].append((n, round(la, 5), round(lo, 5)))
        if got: cities.append([nm, {k: [list(p) for p in dedup(v)] for k, v in got.items()}])
    cities.sort(key=lambda x: x[0])

    o = {"v": datetime.date.today().isoformat(), "lines": lines, "cities": cities}
    path = os.path.join(out, "quests.json")
    with open(path, "w", encoding="utf-8") as f: json.dump(o, f, ensure_ascii=False, separators=(",", ":"))
    c = defaultdict(int)
    for _, d in cities:
        for k, v in d.items(): c[k] += len(v)
    print(f"できた！ 路線 {len(lines)}・市区町村 {len(cities)}（駅 {c['station']}・神社 {c['shrine']}・お寺 {c['temple']}）"
          f" → quests.json {os.path.getsize(path) / 1048576:.1f}MB（{time.time() - T0:.0f}秒）")

if __name__ == "__main__": main()
