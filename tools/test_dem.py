# -*- coding: utf-8 -*-
"""
ほそみちナビ 標高ためし：「短いのに 高さが大きくかわる道（＝たぶん階段・すごい急坂）」が 見分けられるか しらべる

使い方:
  python test_dem.py kanto-latest.osm.pbf
  → 国土地理院の標高タイル（5mメッシュ）を取って、はんいの中の道の 坂のきつさ を色で地図にする
    test_dem.html ができるので、ブラウザで開いて見てね
  はんいをかえるとき: python test_dem.py kanto-latest.osm.pbf 南 西 北 東
  （ふつうは 船橋の上山町・旭町あたり）

地図の色:
  赤＝15%より急（あやしい！）・オレンジ＝10〜15%・黄色＝6〜10%・灰色＝ゆるい
  青の点線＝OSMで もう階段（highway=steps）になっている道（くらべる用）

データ: © OpenStreetMap contributors（ODbL）／標高：国土地理院 標高タイル（DEM5A・なければDEM5B）
"""
import sys, os, math, json, zlib, struct, time, urllib.request
import osmium

BOX = (35.712, 139.955, 35.735, 139.985)   # 南, 西, 北, 東（船橋 上山町・旭町あたり）
Z = 15
STEP = 4.0      # 道にそって 4m ごとに高さをとる
WIN = 16.0      # 16m の間で 高さがどれだけ変わるか → 坂のきつさ
EXCL = {"motorway", "motorway_link", "construction", "proposed", "platform", "raceway", "bus_guideway"}

# ---- PNG（国土地理院の標高タイル：RGB 8bit）を読む。Pillow いらず ----
def png_rgb(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    p, idat, w = 8, b"", 0
    while p < len(data):
        n, typ = struct.unpack(">I4s", data[p:p + 8]); body = data[p + 8:p + 8 + n]; p += 12 + n
        if typ == b"IHDR": w, h, bd, ct = struct.unpack(">IIBB", body[:10]); assert bd == 8 and ct in (2, 6)
        elif typ == b"IDAT": idat += body
    bpp = 3 if ct == 2 else 4
    raw = zlib.decompress(idat); stride = w * bpp; rows = []; prev = bytearray(stride); i = 0
    for _ in range(h):
        f = raw[i]; line = bytearray(raw[i + 1:i + 1 + stride]); i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0; b = prev[x]; c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line); prev = line
    out = []
    for line in rows:
        r = []
        for x in range(w):
            R, G, B = line[x * bpp], line[x * bpp + 1], line[x * bpp + 2]
            v = (R << 16) | (G << 8) | B
            r.append(None if v == 1 << 23 else (v - (1 << 24) if v > 1 << 23 else v) * 0.01)
        out.append(r)
    return out

tiles = {}
def tile(x, y):
    k = (x, y)
    if k in tiles: return tiles[k]
    t = None
    for name in ("dem5a_png", "dem5b_png"):   # 5mメッシュ（航空レーザ → 写真測量）
        try:
            req = urllib.request.Request(f"https://cyberjapandata.gsi.go.jp/xyz/{name}/{Z}/{x}/{y}.png", headers={"User-Agent": "hosomichi-test_dem/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r: t = png_rgb(r.read()); break
        except Exception: pass
    tiles[k] = t
    return t

def elev(la, lo):   # その点の高さ（m）。まわり4ピクセルで なめらかに
    n = 2 ** Z
    fx = (lo + 180) / 360 * n * 256
    fy = (1 - math.log(math.tan(math.radians(la)) + 1 / math.cos(math.radians(la))) / math.pi) / 2 * n * 256
    fx -= 0.5; fy -= 0.5
    x0, y0 = math.floor(fx), math.floor(fy); u, v = fx - x0, fy - y0
    vals = []
    for dx, dy, wt in ((0, 0, (1 - u) * (1 - v)), (1, 0, u * (1 - v)), (0, 1, (1 - u) * v), (1, 1, u * v)):
        px, py = x0 + dx, y0 + dy; t = tile(px // 256, py // 256)
        if t is None: return None
        h = t[py % 256][px % 256]
        if h is None: return None
        vals.append((h, wt))
    return sum(h * w for h, w in vals) / sum(w for _, w in vals)

def hav(a, b):
    R = 6371000; la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    return 2 * R * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))

class NodeH(osmium.SimpleHandler):
    def __init__(self, box):
        super().__init__(); self.box = box; self.loc = {}
    def node(self, n):
        if not n.location.valid(): return
        S, W, N, E = self.box; la, lo = n.location.lat, n.location.lon
        if S - 0.003 < la < N + 0.003 and W - 0.003 < lo < E + 0.003: self.loc[n.id] = (la, lo)

class WayH(osmium.SimpleHandler):
    def __init__(self, loc):
        super().__init__(); self.loc = loc; self.ways = []
    def way(self, w):
        hw = w.tags.get("highway")
        if not hw or hw in EXCL: return
        pts = [self.loc[n.ref] for n in w.nodes if n.ref in self.loc]
        if len(pts) < 2 or len(pts) < len(w.nodes) * 0.8: return
        self.ways.append((w.id, hw, w.tags.get("name", ""), pts))

def grade(pts):   # 道にそって STEP ごとに高さ → WIN の間の いちばん大きい坂（%）と 高さの差
    L = [0.0]
    for a, b in zip(pts, pts[1:]): L.append(L[-1] + hav(a, b))
    tot = L[-1]
    if tot < 3: return None
    k = max(2, int(tot / STEP) + 1); samp = []
    j = 0
    for s in range(k):
        d = tot * s / (k - 1)
        while j < len(pts) - 2 and L[j + 1] < d: j += 1
        seg = L[j + 1] - L[j] or 1; u = (d - L[j]) / seg
        la = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * u; lo = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * u
        h = elev(la, lo)
        if h is None: return None
        samp.append((d, h))
    best, bdh = 0.0, 0.0
    for a in range(len(samp)):
        for b in range(a + 1, len(samp)):
            dd = samp[b][0] - samp[a][0]
            if dd > WIN + 0.1: break
            if dd < min(WIN, tot) * 0.6: continue   # 短すぎる間は見ない（道が WIN より短いときは 道ぜんぶ）
            g = abs(samp[b][1] - samp[a][1]) / dd * 100
            if g > best: best, bdh = g, abs(samp[b][1] - samp[a][1])
    rise = max(h for _, h in samp) - min(h for _, h in samp)
    return best, bdh, rise, tot

def main():
    if len(sys.argv) not in (2, 6): print(__doc__); sys.exit(1)
    src = sys.argv[1]; box = tuple(map(float, sys.argv[2:6])) if len(sys.argv) == 6 else BOX
    t0 = time.time()
    print("1/3 点を読んでるよ（ちょっと時間がかかる）…", flush=True)
    nh = NodeH(box); nh.apply_file(src)
    print(f"  {len(nh.loc):,}点", flush=True)
    print("2/3 道を読んでるよ…", flush=True)
    wh = WayH(nh.loc); wh.apply_file(src)
    print(f"  {len(wh.ways):,}本", flush=True)
    print("3/3 標高をしらべてるよ（国土地理院のタイルをダウンロード）…", flush=True)
    rows = []
    for wid, hw, nm, pts in wh.ways:
        g = grade(pts)
        if g: rows.append((wid, hw, nm, pts, *g))
    print(f"  標高タイル {sum(1 for t in tiles.values() if t)}枚（取れなかった {sum(1 for t in tiles.values() if t is None)}枚）", flush=True)
    sus = sorted((r for r in rows if r[1] != "steps" and r[4] >= 10), key=lambda r: -r[4])
    print("\nあやしい道（坂が10%より急）:")
    for wid, hw, nm, pts, g, dh, rise, tot in sus[:40]:
        print(f"  {g:5.1f}%  高さの差{rise:4.1f}m  長さ{tot:5.0f}m  {hw:12s} {nm}  https://www.openstreetmap.org/way/{wid}")
    st = [r for r in rows if r[1] == "steps"]
    if st:
        gs = sorted(r[4] for r in st)
        print(f"\nくらべる用：もう階段になっている道 {len(st)}本の坂 → まん中 {gs[len(gs) // 2]:.1f}%・10%より急なのは {sum(1 for g in gs if g >= 10)}本")
    col = lambda g: "#d50000" if g >= 15 else "#ff6d00" if g >= 10 else "#fbc02d" if g >= 6 else "#9e9e9e"
    feats = [{"p": [[round(a, 6), round(b, 6)] for a, b in pts], "c": "#1a73e8" if hw == "steps" else col(g), "d": hw == "steps",
              "w": 6 if g >= 10 or hw == "steps" else 3, "t": f"{hw} {nm}<br>坂 {g:.1f}%（16mで{dh:.1f}m）・高さの差 {rise:.1f}m・長さ {tot:.0f}m<br><a href='https://www.openstreetmap.org/way/{wid}' target=_blank>way/{wid}</a>"}
             for wid, hw, nm, pts, g, dh, rise, tot in rows]
    html = """<!DOCTYPE html><meta charset=utf-8><title>標高ためし</title>
<link rel=stylesheet href=https://unpkg.com/leaflet@1.9.4/dist/leaflet.css><script src=https://unpkg.com/leaflet@1.9.4/dist/leaflet.js></script>
<style>html,body,#m{margin:0;height:100%}#k{position:absolute;z-index:999;left:8px;bottom:8px;background:#fff;padding:6px 10px;border-radius:8px;font:13px sans-serif;box-shadow:0 2px 6px #0004}</style>
<div id=m></div><div id=k><b style=color:#d50000>━</b> 15%〜 <b style=color:#ff6d00>━</b> 10〜15% <b style=color:#fbc02d>━</b> 6〜10% <b style=color:#9e9e9e>━</b> ゆるい <b style=color:#1a73e8>┅</b> OSMで階段</div>
<script>const F=__F__;const m=L.map('m');L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',{maxZoom:20,attribution:'© OpenStreetMap contributors / 標高：国土地理院'}).addTo(m);
const g=L.featureGroup().addTo(m);F.sort((a,b)=>a.w-b.w).forEach(f=>L.polyline(f.p,{color:f.c,weight:f.w,opacity:.85,dashArray:f.d?'4 6':null}).bindPopup(f.t).addTo(g));m.fitBounds(g.getBounds());</script>"""
    out = os.path.join(os.path.dirname(os.path.abspath(src)), "test_dem.html")
    open(out, "w", encoding="utf-8").write(html.replace("__F__", json.dumps(feats, ensure_ascii=False)))
    print(f"\nできた！ {out} をブラウザで開いてね（{time.time() - t0:.0f}秒）")

if __name__ == "__main__":
    main()
