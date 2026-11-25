# -*- coding: utf-8 -*-
"""
🌀 ワープトンネル（曲がらずに遠くまで行ける細い道）を見つけるスクリプト（ためし）

使い方:
  python make_warp.py データフォルダ                 ← hosomichi-data（index.json と t/ があるところ）
  python make_warp.py データフォルダ --min 2000      ← 2km 以上だけ（はじめは 1500m）
  python make_warp.py データフォルダ --box 35.48,138.94,35.90,139.93   ← はんい（南,西,北,東。はじめは 都内のまわりの四角）
  → データフォルダ/warp.json を作る

やりかた（ストローク）:
  1. 細い道（residential・living_street・unclassified）を取り出す。一般道（tertiary）・敷地の道（service）も つなぎとして使う（半分より多いものは のぞく）
  2. 交差点では「いちばんまっすぐ進める道」どうしをつなぐ（ずれが 30° 以内のときだけ）。交差点でない曲がり角は 75° まで
  3. つながった1本の長さをはかって、長いものを残す
  4. 入り口：その1本が 大きい道（tertiary 以上）とふれる所（両はしもふくむ）

データ: © OpenStreetMap contributors（ODbL）
"""
import sys, os, json, gzip, math, time, argparse
from collections import defaultdict

T = 0.01   # 配布データの1マス（make_pack.py と同じ）
NARROW = {"residential", "living_street", "unclassified"}
BIG = {"tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link", "trunk", "trunk_link"}
MID = {"tertiary", "service"}   # 細い道のあいだを つなぐだけの道（一般道・敷地の道）。1本のうち半分より多くなったら のぞく
SKIP_SERVICE = {"driveway", "parking_aisle", "drive-through"}
JCT = NARROW | BIG | {"service"}   # 交差点かどうかを数える道（歩道・小道は 交差点に数えない）
BAD_ACCESS = {"private", "no"}
TURN_JCT = 30   # 交差点で つないでいい ずれ（度）
TURN_BEND = 75  # 交差点でない 曲がり角で つないでいい ずれ（度）
LOOK = 15       # 向きをはかる長さ（m）

def dec_v2(o):   # make_pack.py の dec_v2 と同じ（osmium なしで動くように コピー）
    i, j = o["t"]; base = (i * 20000 + j) * 100000
    n = len(o["n"]) // 2; ids = [None] * n; k = 0; nid = 0
    for q in range(0, len(o["g"]), 2): k += o["g"][q]; nid += o["g"][q + 1]; ids[k] = nid
    for x in range(n):
        if ids[x] is None: ids[x] = -(base + x)
    el, la, lo = [], round(i * T * 1e7), round(j * T * 1e7); nt = {}; k = 0
    for q in range(0, len(o["nt"]), 2): k += o["nt"][q]; nt[k] = o["tg"][o["nt"][q + 1]]
    for x in range(n):
        la += o["n"][2 * x]; lo += o["n"][2 * x + 1]
        e = {"type": "node", "id": ids[x], "lat": la / 1e7, "lon": lo / 1e7}
        if x in nt: e["tags"] = nt[x]
        el.append(e)
    for wi, w in enumerate(o["w"]):
        r = [w[3]]
        for d in w[4:]: r.append(r[-1] + d)
        el.append({"type": "way", "id": w[0], "nodes": [ids[x] for x in r], "tags": o["tg"][w[1]]})
    return el

def dist(a, b):   # m（近いところ用）
    dy = (a[0] - b[0]) * 111320; dx = (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)

def bearing(a, b):
    dy = b[0] - a[0]; dx = (b[1] - a[1]) * math.cos(math.radians(a[0]))
    return math.degrees(math.atan2(dx, dy)) % 360

def turn(b1, b2):   # 入ってきた向き b1 → 出ていく向き b2 の ずれ（0＝まっすぐ）
    d = abs(b1 - b2) % 360
    return min(d, 360 - d)

def simplify(pts, tol=3.0):   # ダグラス・ポーカー（m）
    if len(pts) < 3: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True; st = [(0, len(pts) - 1)]
    while st:
        a, b = st.pop(); best, bi = 0, -1
        A, B = pts[a], pts[b]; L = dist(A, B)
        for k in range(a + 1, b):
            P = pts[k]
            if L < 0.01: d = dist(A, P)
            else: d = abs(dist(A, P) * math.sin(math.radians(bearing(A, P) - bearing(A, B))))
            if d > best: best, bi = d, k
        if best > tol: keep[bi] = True; st += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("data"); ap.add_argument("--min", type=float, default=1500)
    ap.add_argument("--box", default="35.48,138.94,35.90,139.93")
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv); t0 = time.time()
    S, W, N, E = map(float, a.box.split(","))
    ix = json.load(open(os.path.join(a.data, "index.json"), encoding="utf-8"))
    keys = [k for k in ix["keys"] if S <= int(k.split("_")[0]) * T < N and W <= int(k.split("_")[1]) * T < E]
    print(f"マス {len(keys):,}個を読むよ", flush=True)

    pos = {}                     # 点 → (緯度, 経度)
    sig = set()                  # 信号の点
    adj = defaultdict(set)       # 細い道の となり
    jdeg = defaultdict(set)      # 交差点を数える道の となり
    big = set()                  # 大きい道の点
    names = {}                   # (点, 点) → 道の名前
    mid = set()                  # tertiary・service の区間
    for n_, k in enumerate(keys):
        p = os.path.join(a.data, "t", k + ".json.gz")
        if not os.path.exists(p): continue
        with gzip.open(p, "rt", encoding="utf-8") as f: el = dec_v2(json.load(f))
        for e in el:
            if e["type"] == "node":
                pos[e["id"]] = (e["lat"], e["lon"])
                tg = e.get("tags") or {}
                if tg.get("highway") == "traffic_signals" or tg.get("crossing") == "traffic_signals": sig.add(e["id"])
                continue
            tg = e["tags"]; hw = tg.get("highway"); nd = e["nodes"]
            if hw in BIG:
                big.update(nd)
            if hw in JCT and tg.get("area") != "yes":
                for u, v in zip(nd, nd[1:]): jdeg[u].add(v); jdeg[v].add(u)
            ok = hw in NARROW or (hw in MID and tg.get("service") not in SKIP_SERVICE)
            if ok and tg.get("area") != "yes" and tg.get("access") not in BAD_ACCESS and tg.get("bicycle") not in ("no", "dismount"):
                for u, v in zip(nd, nd[1:]):
                    if u == v: continue
                    adj[u].add(v); adj[v].add(u)
                    if hw in MID: mid.add((min(u, v), max(u, v)))
                    if tg.get("name"): names[(min(u, v), max(u, v))] = tg["name"]
        if (n_ + 1) % 500 == 0: print(f"  {n_ + 1:,}/{len(keys):,}マス", flush=True)
    print(f"細い道の点 {len(adj):,}個（{time.time() - t0:.0f}秒）", flush=True)

    def isjct(n): return len(jdeg[n]) >= 3
    def look(u, v):   # u から v のほうへ LOOK m 進んだ向き（交差点でない 点はとびこえる）
        prev, cur, d = u, v, dist(pos[u], pos[v])
        while d < LOOK and len(adj[cur]) == 2 and not isjct(cur):
            nx = next(x for x in adj[cur] if x != prev)
            d += dist(pos[cur], pos[nx]); prev, cur = cur, nx
        return bearing(pos[u], pos[cur])

    # ---- 点ごとに「どの道とどの道がつながるか」を決める ----
    link = {}   # (点, となり) → (点, 反対がわのとなり)
    for n, nb in adj.items():
        if n not in pos or len(nb) < 2: continue
        nb = [x for x in nb if x in pos]
        out = {x: look(n, x) for x in nb}
        lim = TURN_JCT if isjct(n) else TURN_BEND
        cand = []
        for i in range(len(nb)):
            for j in range(i + 1, len(nb)):
                x, y = nb[i], nb[j]
                dv = turn((out[x] + 180) % 360, out[y])   # x から来て y へ出る
                if dv <= lim: cand.append((dv, x, y))
        cand.sort(); used = set()
        for dv, x, y in cand:
            if x in used or y in used: continue
            used.add(x); used.add(y); link[(n, x)] = y; link[(n, y)] = x

    # ---- つないで1本にする ----
    seen = set(); strokes = []
    def ek(u, v): return (u, v) if u < v else (v, u)
    def walk(a0, b0):   # a0 から b0 の向きに たどる
        path = [a0, b0]; seen.add(ek(a0, b0)); u, v = a0, b0
        while True:
            w = link.get((v, u))
            if w is None or ek(v, w) in seen: break
            seen.add(ek(v, w)); path.append(w); u, v = v, w
        return path
    for u in adj:
        for v in adj[u]:
            if ek(u, v) in seen or u not in pos or v not in pos: continue
            fw = walk(u, v)          # u → v → … 前へ
            w = link.get((u, v))     # u の うしろがわ
            if w is not None and ek(u, w) not in seen:
                bw = walk(u, w)      # u → w → … うしろへ
                fw = list(reversed(bw))[:-1] + fw
            strokes.append(fw)

    global STATE; STATE = dict(pos=pos, adj=adj, jdeg=jdeg, big=big, link=link, strokes=strokes, isjct=isjct, look=look, names=names)
    res = []
    for path in strokes:
        pts = [pos[x] for x in path]
        L = sum(dist(p, q) for p, q in zip(pts, pts[1:]))
        if L < a.min: continue
        Lm = sum(dist(pos[u], pos[v]) for u, v in zip(path, path[1:]) if ek(u, v) in mid)
        if Lm * 2 > L: continue   # 一般道・敷地の道ばかりのものは ワープトンネルではない
        gates = []   # 入り口：大きい道とふれる所（この1本の 細い道の区間のはし）。40m以内に つづけてあるものは1つに
        for k, x in enumerate(path):
            if x not in big: continue
            nar = [e for e in ((path[k - 1], x) if k else None, (x, path[k + 1]) if k + 1 < len(path) else None) if e and ek(*e) not in mid]
            if not nar: continue
            if gates and dist(gates[-1], pos[x]) < 40: continue
            gates.append([round(pos[x][0], 5), round(pos[x][1], 5), 1 if x in sig else 0])
        nm = defaultdict(float)
        for u, v in zip(path, path[1:]):
            s = names.get(ek(u, v))
            if s: nm[s] += dist(pos[u], pos[v])
        name = max(nm, key=nm.get) if nm else ""
        js = sum(1 for x in path[1:-1] if isjct(x))
        res.append({"l": round(L), "nm": name, "j": js, "p": [[round(la, 5), round(lo, 5)] for la, lo in simplify(pts)], "g": gates})
    res.sort(key=lambda r: -r["l"])
    out = a.out or os.path.join(a.data, "warp.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"v": ix.get("v"), "built": time.strftime("%Y-%m-%dT%H:%M:%S"), "min": a.min, "box": [S, W, N, E],
                   "license": "© OpenStreetMap contributors / ODbL", "s": res}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"ワープトンネル {len(res):,}本（{a.min:.0f}m以上・いちばん長いの {res[0]['l'] if res else 0}m）→ {out}（{os.path.getsize(out) / 1048576:.1f}MB・{time.time() - t0:.0f}秒）")
    for r in res[:15]: print(f"  {r['l']:>6}m 入り口{len(r['g']):>3} {r['nm'] or '（名前なし）'}  {r['p'][0]}")

if __name__ == "__main__":
    main()
