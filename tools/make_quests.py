# -*- coding: utf-8 -*-
"""
ほそみちナビ クエスト用のデータ quests.json を作るスクリプト（サーバーいらずにするため）

使い方:
  python make_quests.py kanto-latest.osm.pbf 出力フォルダ
  → 出力フォルダ/quests.json を作る（make_pack.py と同じ pbf を使う・数分）
  できたら hosomichi-data リポジトリに入れて push

中身:
  spots/緯度番号_経度番号.json（0.05°のマス）… 地図の「まわりのスポット」用（トイレ・コンビニ・神社…）
  {"v": 日付,
   "lines":  [[路線名, 会社, [[駅名, 緯度, 経度], …]], …],          … 路線の駅ぜんぶ（走る順）
   "cities": [[市区町村名, {"station": [[名前, 緯度, 経度], …], "shrine": […], …}], …],
              … 市区町村の 駅・神社・お寺・城・展望スポット…ぜんぶ（境界は admin_level=7。QUEST_KINDS のジャンル）
   "spots": {"T": 0.05, "keys": [マスの番号, …]}}

データ: © OpenStreetMap contributors（ODbL）
"""
import sys, os, re, json, time, datetime
from collections import defaultdict
def load_osmium():
    # Windows のスマートアプリコントロールが osmium の部品（DLL）をいくつか止めることがある。
    # このスクリプトが使うのは SimpleHandler（読むところ）だけなので、止められた部品は身代わりを置いて読みこまない
    import types
    stubbed = []
    for _ in range(12):
        try:
            import osmium
            if stubbed: print(f"（Windows に止められた osmium の部品 {', '.join(stubbed)} は使わずに動かすよ）", flush=True)
            return osmium
        except ImportError as e:
            m = re.search(r"importing (\w+)", str(e))
            name = m.group(1) if m else ""
            if not name or name.startswith("_") or name in ("io", "osm") or name in stubbed: raise   # 本体・読むのに使う部品は身代わりにできない
            stubbed.append(name)
            for k in [k for k in sys.modules if k == "osmium" or k.startswith("osmium.")]:
                if k[7:] not in stubbed: del sys.modules[k]   # 身代わりはのこして、ほかは読みなおす
            stub = types.ModuleType("osmium." + name)
            def _no(*a, **k): raise RuntimeError(f"osmium の {name} 部品は Windows に止められているので使えないよ")
            stub.__getattr__ = lambda attr: _no
            sys.modules["osmium." + name] = stub
    raise ImportError("osmium が読みこめなかったよ")
osmium = load_osmium()

RAIL = {"train", "subway", "light_rail", "monorail", "tram"}
def clean(v): return re.sub(r"\s*[（(][^）)]*[）)]\s*", "", v or "").strip()   # 「千代田線（綾瀬→代々木上原）」→「千代田線」
def sta_name(v): return re.sub(r"駅$", "", (v or "").strip())
def is_station(t): return t.get("railway") in ("station", "halt") or (t.get("public_transport") == "station" and t.get("train") == "yes")
# スポットのジャンル（アプリの SPOT_KINDS と同じ名前）。名前がなくてもいいもの = NONAME
NONAME = {"toilet", "water", "bikepark", "bike", "xing", "signal", "steps", "ramp", "elev", "cbar", "bollard", "gate",
          "railx", "footbr", "underpass", "stop", "bump", "constr", "bench", "shelter", "vending", "repair", "police", "aed", "jizo", "tree", "spring", "fall"}
MACHI_KINDS = ("school", "univ", "hospital", "townhall", "library", "post", "fire", "factory", "waterw", "power", "ground", "park",
               "shrine", "temple", "church", "castle", "kofun", "sight", "view", "michi")   # 面なら外形も入れる（アプリが「となりの道を通ったか」を見るため）
MID_KINDS = ("bridge", "ramp", "steps", "cbar", "bollard", "gate", "footbr", "underpass", "constr")   # 線（way）のスポットは まん中の点
def spot_kind(t, is_way=False):
    g = t.get; a, sh, hi, to = g("amenity"), g("shop"), g("historic"), g("tourism")
    n = g("name")
    if a == "place_of_worship" and n:
        r = g("religion")
        return "shrine" if r == "shinto" else "temple" if r == "buddhist" else "church" if r == "christian" else None
    if is_way and g("bridge") and g("highway") and n and "橋" in n: return "bridge"
    hw = g("highway")
    if hw == "crossing" and not is_way:   # 横断歩道（しまもようのあるもの。信号のあるなしは関係なく）
        c = g("crossing") or ""
        if c in ("marked", "uncontrolled", "zebra", "traffic_signals") or g("crossing:markings") not in (None, "no"): return "xing"
        return None
    if hw == "traffic_signals" and not is_way: return "signal"   # 信号機
    if is_way and hw == "steps": return "ramp" if g("ramp:bicycle") == "yes" else "steps"   # スロープ（溝）つき階段／ふつうの階段
    b = g("barrier")
    if b == "cycle_barrier": return "cbar"   # 自転車止めの柵（くねくね）
    if b == "bollard": return "bollard"      # ポール
    if b in ("gate", "lift_gate", "swing_gate"): return "gate"   # ゲート・遮断機
    if g("railway") in ("level_crossing", "crossing") and not is_way: return "railx"   # 踏切
    if is_way and hw in ("footway", "path", "cycleway", "pedestrian") and g("bridge") not in (None, "no"): return "footbr"   # 歩道橋
    if is_way and hw in ("footway", "path", "cycleway", "pedestrian") and g("tunnel") == "yes": return "underpass"   # 地下道
    if hw == "stop" and not is_way: return "stop"   # 一時停止
    if g("traffic_calming") in ("bump", "hump", "table", "cushion"): return "bump"   # 減速の段差
    if is_way and hw == "construction": return "constr"   # 工事中の道
    if a == "bench": return "bench"
    if a == "shelter": return "shelter"   # 東屋・屋根つきの休けい所
    if a == "vending_machine" and "drink" in (g("vending") or ""): return "vending"   # 飲み物の自販機
    if a in ("bicycle_repair_station", "compressed_air"): return "repair"   # 空気入れ・修理スタンド
    if a == "police": return "police"
    if g("emergency") == "defibrillator": return "aed"
    if hi == "wayside_shrine": return "jizo"   # お地蔵さん・道祖神・庚申塔
    if g("natural") == "spring": return "spring"   # 湧き水
    if g("waterway") == "waterfall": return "fall"
    if g("natural") == "tree" and (n or g("denotation") == "natural_monument"): return "tree"   # 名前のある木・天然記念物
    if hw == "elevator": return "elev"
    if a == "toilets": return "toilet"
    if a == "drinking_water": return "water"
    if a == "bicycle_parking":   # 月極・定期・関係者だけの駐輪場は出さない（ちょっと止めるのに使えないので）
        if g("access") in ("private", "no", "permissive_monthly") or re.search(r"月極|定期|契約|専用|関係者", (n or "") + (g("description") or "") + (g("note") or "")): return None
        return "bikepark"
    if sh == "bicycle": return "bike"
    if not n: return None
    if a == "school": return "school"   # 🏫 小学校・中学校・高校（名前のあるもの）
    if a in ("university", "college"): return "univ"   # 🎓 大学・専門学校
    mm = g("man_made")
    plain = not sh and not a and not to and not g("craft")   # お店・食べ物屋（「〇〇パン工場」など）は名前で見分けない
    if mm in ("water_works", "wastewater_plant") or (plain and re.search(r"浄水場|水道局|水道部|下水|水再生|汚水処理|浄化センター|配水場|給水所", n)): return "waterw"   # 🚰 浄水場・水道局
    if mm == "works" or (plain and (g("building") in ("industrial", "factory") or re.search(r"工場|製作所|製造所", n))): return "factory"   # 🏭 工場
    if g("power") == "plant": return "power"   # ⚡ 発電所
    if g("leisure") in ("pitch", "stadium", "sports_centre", "track", "golf_course") or g("landuse") == "recreation_ground" or (plain and re.search(r"グラウンド|グランド|運動場|球場|競技場|運動公園|スポーツ公園", n)): return "ground"   # 🏟 グラウンド・球場
    if a == "townhall": return "townhall"   # 🏛 役所
    if a == "fire_station": return "fire"   # 🚒 消防署
    if a == "post_office": return "post"   # 📮 郵便局
    if a == "library": return "library"   # 📚 図書館
    if a == "hospital": return "hospital"
    if a == "ferry_terminal" or (g("route") == "ferry"): return "ferry"   # 渡し船
    if hi == "milestone" and "一里塚" in n: return "ichiri"
    if sh == "convenience": return "conv"
    if a == "cafe": return "cafe"
    if a in ("restaurant", "fast_food") and "ramen" in (g("cuisine") or ""): return "ramen"
    if a in ("restaurant", "fast_food", "food_court"):   # 🍴 ランチ用（料理の種類 cuisine か、名前で見分ける）
        cu = (g("cuisine") or "").lower()
        def has(pat_cu, pat_nm=None): return bool(re.search(pat_cu, cu)) or bool(pat_nm and re.search(pat_nm, n))
        if has(r"ramen", r"ラーメン|らーめん|拉麺|中華そば|つけ麺"): return "ramen"
        if has(r"soba|udon", r"そば|蕎麦|うどん|饂飩"): return "soba"
        if has(r"sushi", r"寿司|鮨|すし"): return "sushi"
        if has(r"curry|indian|nepal", r"カレー|インド|ネパール"): return "curry"
        if has(r"chinese|dumpling|gyoza", r"中華|餃子|飯店|菜館|酒家"): return "chinese"
        if has(r"burger", r"バーガー|マクドナルド|モスバーガー|ロッテリア"): return "burger"
        if has(r"italian|pizza|pasta|french|western|steak|hamburg|yoshoku", r"イタリア|ピザ|パスタ|洋食|ステーキ|ハンバーグ|ビストロ|トラットリア"): return "western"
        if has(r"japanese|teishoku|tonkatsu|tempura|donburi|gyudon|katsu|tendon|unagi", r"定食|食堂|とんかつ|天ぷら|天丼|丼|牛丼|うなぎ|鰻|すき家|吉野家|松屋|やよい軒|大戸屋"): return "teishoku"
        return "restaurant"
    if sh == "bakery": return "bakery"
    if sh in ("confectionery", "pastry", "ice_cream") or a == "ice_cream": return "sweets"
    if sh in ("alcohol", "wine") or g("craft") in ("brewery", "winery", "distillery"): return "liquor"
    if a == "public_bath" or g("bath:type") == "onsen": return "bath"
    if hi in ("castle", "fort") or (hi == "ruins" and "城" in n): return "castle"
    if hi in ("tomb", "archaeological_site"): return "kofun"
    if hi in ("memorial", "monument", "milestone", "boundary_stone", "wayside_cross") or (hi == "memorial" and g("memorial") == "stone"): return "monument"
    if to == "viewpoint": return "view"
    if "道の駅" in n and (a or to or g("highway") == "services"): return "michi"
    if g("leisure") == "park": return "park"
    if to == "attraction" or hi: return "sight"
    return None
def famous(t): return 1 if (t.get("wikidata") or t.get("wikipedia")) else 0
QUEST_KINDS = {"jizo", "tree", "spring", "fall", "ichiri", "ferry", "station", "shrine", "temple", "church", "castle", "kofun", "monument", "view", "michi", "sight", "bridge", "bath"}

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
        super().__init__(); self.need = need; self.ways = {}; self.pow = []   # pow: (種類, 名前, [node id])（面のスポット・橋）
    def way(self, w):
        if w.id in self.need: self.ways[w.id] = [n.ref for n in w.nodes]
        if not w.tags: return
        k = spot_kind(w.tags, True)
        if k: self.pow.append((k, w.tags.get("name") or "", [n.ref for n in w.nodes], famous(w.tags)))

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
        k = spot_kind(n.tags)
        if k: self.pow.append((k, n.tags.get("name") or "", la, lo, famous(n.tags)))

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

def dedup(pts, d=0.01):   # 同じ名前で近い点は1つに（ホームごとの点・JRと私鉄の同じ駅など）。マス目で近くだけ見るので数が多くても速い
    keep, grid = [], defaultdict(list)
    for p in pts:
        gi, gj = int(p[1] // d), int(p[2] // d)
        near = [q for a in (gi - 1, gi, gi + 1) for b in (gj - 1, gj, gj + 1) for q in grid[(a, b)]]
        if all(p[0] != q[0] or abs(p[1] - q[1]) + abs(p[2] - q[2]) > d for q in near):
            keep.append(p); grid[(gi, gj)].append(p)
    return keep

def main():
    if len(sys.argv) != 3: print(__doc__); sys.exit(1)
    src, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True); T0 = time.time()
    print("1/3 relation（境界・路線）を読んでるよ…", flush=True)
    rh = RelH(); rh.apply_file(src)
    print(f"  市区町村 {len(rh.city)}・路線 {len(rh.route)}（まとめ {len(rh.master)}）", flush=True)
    need_w = {w for _, ms in rh.city.values() for w, _ in ms}
    print("2/3 way（境界の線・面になっているスポット・橋）を読んでるよ…", flush=True)
    wh = WayH(need_w); wh.apply_file(src)
    need_n = {n for ns in wh.ways.values() for n in ns} | {n for _, _, ns, _ in wh.pow for n in ns}
    need_n |= {n for _, _, ms in rh.route.values() for n, _ in ms}
    print(f"3/3 node（座標 {len(need_n):,}点・駅・スポット）を読んでるよ…", flush=True)
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
    pts = [("station", n, la, lo, 0) for n, la, lo in nh.sta] + nh.pow
    outline = {}   # (ジャンル, 名前, 緯度, 経度) → 外形 [緯度, 経度, 緯度, 経度, …]（まちの建物の面だけ・約20mおき・16点まで）
    for k, n, ns, imp in wh.pow:   # 面のスポットは、まわりの点の平均（橋は まん中の点）
        ps = [L[x] for x in ns if x in L]
        if not ps: continue
        if k in MID_KINDS: pts.append((k, n) + ps[len(ps) // 2] + (imp,))
        else:
            la, lo = sum(p[0] for p in ps) / len(ps), sum(p[1] for p in ps) / len(ps)
            pts.append((k, n, la, lo, imp))
            if k in MACHI_KINDS and len(ps) >= 3:
                r = thin(ps, 0.0002)
                if len(r) > 16: r = [r[i * len(r) // 16] for i in range(16)]
                outline[(k, n, round(la, 5), round(lo, 5))] = [round(c, 5) for q in r for c in q]
    print(f"  スポット {len(pts):,}か所", flush=True)
    cities = []
    for cid, (nm, ms) in rh.city.items():
        polys = [thin([L[n] for n in r if n in L]) for r in rings([w for w, _ in ms], wh.ways)]
        polys = [p for p in polys if len(p) > 3]
        if not polys: continue
        S = min(p[0] for r in polys for p in r); N = max(p[0] for r in polys for p in r)
        W = min(p[1] for r in polys for p in r); E = max(p[1] for r in polys for p in r)
        got = defaultdict(list)
        for k, n, la, lo, _ in pts:
            if k in QUEST_KINDS and n and S <= la <= N and W <= lo <= E and inside(polys, la, lo): got[k].append((n, round(la, 5), round(lo, 5)))
        if got: cities.append([nm, {k: [list(p) for p in dedup(v, 0.01 if k == "station" else 0.003)] for k, v in got.items()}])
    cities.sort(key=lambda x: x[0])

    # まわりのスポット：0.05°のマスに分ける（同じ名前・同じジャンルで 30m 以内は1つに）
    T = 0.05; tiles = defaultdict(lambda: defaultdict(list))
    # 有名なもの（Wikipedia・Wikidata にのっているもの）は4つ目に 1 をつける。アプリは引いたとき有名なものから出す
    pts.sort(key=lambda x: -x[4])   # 同じ所に2つあったら有名なほうをのこす
    for k, n, la, lo, imp in pts:
        if k == "station": continue
        rla, rlo = round(la, 5), round(lo, 5); ol = outline.get((k, n, rla, rlo))
        tiles[f"{int(la // T)}_{int(lo // T)}"][k].append((n, rla, rlo) + ((1 if imp else 0, ol) if ol else (1,) if imp else ()))
    sdir = os.path.join(out, "spots"); os.makedirs(sdir, exist_ok=True)
    for f in os.listdir(sdir):
        if f.endswith(".json"): os.remove(os.path.join(sdir, f))
    nsp = 0
    for key, kinds in tiles.items():
        d = {k: [list(p) for p in dedup(v, 0.0003)] for k, v in kinds.items()}; nsp += sum(len(v) for v in d.values())
        with open(os.path.join(sdir, key + ".json"), "w", encoding="utf-8") as f: json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  まわりのスポット {nsp:,}か所 → spots/ {len(tiles)}マス", flush=True)
    # 引いたとき用（ズーム12より引いたとき）：0.1°のマスごと・ジャンルごとに、有名なもの3つまで（なければ1つ）
    OT = 0.1; cell = defaultdict(list)
    for k, n, la, lo, imp in pts:
        if k != "station": cell[(k, int(la // OT), int(lo // OT))].append((n, round(la, 5), round(lo, 5)) + ((1,) if imp else ()))
    ov = defaultdict(list)
    for (k, _, _), v in cell.items():
        fam = [p for p in v if len(p) > 3]
        ov[k] += fam[:3] if fam else [next((p for p in v if p[0]), v[0])]   # 有名なのがなければ、名前のあるものを1つ
    with open(os.path.join(out, "spots_overview.json"), "w", encoding="utf-8") as f: json.dump(ov, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  引いたとき用 {sum(len(v) for v in ov.values()):,}か所 → spots_overview.json（{os.path.getsize(os.path.join(out, 'spots_overview.json')) / 1048576:.1f}MB）", flush=True)
    o = {"v": datetime.date.today().isoformat(), "lines": lines, "cities": cities, "spots": {"T": T, "keys": sorted(tiles)}}
    path = os.path.join(out, "quests.json")
    with open(path, "w", encoding="utf-8") as f: json.dump(o, f, ensure_ascii=False, separators=(",", ":"))
    c = defaultdict(int)
    for _, d in cities:
        for k, v in d.items(): c[k] += len(v)
    print(f"できた！ 路線 {len(lines)}・市区町村 {len(cities)}（" + "・".join(f"{k} {v}" for k, v in sorted(c.items(), key=lambda x: -x[1])) + "）"
          f" → quests.json {os.path.getsize(path) / 1048576:.1f}MB（{time.time() - T0:.0f}秒）")

def beep(ok=True):   # 終わったら音で知らせる（成功：ピッピッピー／失敗：ブー）
    try:
        import winsound
        for f, ms in ([(1200, 150), (1200, 150), (1600, 400)] if ok else [(300, 800)]): winsound.Beep(f, ms)
    except Exception:
        print("\a", end="", flush=True)

if __name__ == "__main__":
    try: main()
    except BaseException:
        beep(False); raise
    beep(True)
