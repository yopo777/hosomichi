#!/usr/bin/env python3
r"""JARTIC 交通規制情報（拡張版標準フォーマット k_2.1 の CSV）→ ほそみちナビ用の小さいファイル（タイルと同じ 0.01° マス）

つかいかた:
  python3 tools/jartic_pack.py 出力フォルダ 千葉県警_202609_k_2_1.csv [警視庁_....csv ...]
  python3 tools/jartic_pack.py 出力フォルダ D:\Python\jartic\jartic_202611      ← フォルダの中の typeD_*.zip・*.csv をぜんぶ
  （zip のままでも読めるよ）

出力: 出力フォルダ/j/{緯度×100}_{経度×100}.json.gz（タイル t/ と同じ名前）
  { "v": 1, "src": [...],
    "xw":  [[lat, lon], ...]            横断歩道（85）
    "bx":  [[lat, lon], ...]            自転車横断帯（87）
    "sig": [[lat, lon], ...]            信号機設置（98）
    "ow":  [{"p": [[lat, lon], ...], "b": 0/1, "h": "0700-0900"}]   一方通行（11）。p は通ってよい向きの順。
            b=1：自転車は除く（自転車は逆向きもOK）。h：時間つき（ないときは一日中）
    "nx":  [[[lat, lon], ...], ...]     歩行者等横断禁止（14）の線
    "ln":  [[[lat, lon], ...], ...]     車両通行帯（20）の線（いまは分析用）
    "ne":  [{"p": [lat, lon], "b": 1?, "h"?, "w"?}]   車両進入禁止（13）の点（b=1：自転車は除く）。まだアプリでは使わない
    "cx":  [{"p": [lat, lon], "h"?, "w"?}]   普通自転車の交差点進入禁止（83）の点。まだアプリでは使わない
    "sw":  [{"p": [[lat, lon], ...], "h"?, "w"?}]   普通自転車歩道通行可（81）の線。まだアプリでは使わない
    "bl":  [{"p": [[lat, lon], ...], "h"?, "w"?}]   普通自転車専用通行帯（110）の線。まだアプリでは使わない
    "nb":  [{"p": [[lat, lon], ...], "h": "0700-0900", "q": 1}]   自転車が通れない（通行止め 4・車両通行止め 5）の線。
            h：時間つき。q=1：対象車両コードが空っぽで 名前が「車両」など（自転車も入る と思うけど たしかめ中）
  }
出典：公益財団法人 日本道路交通情報センター（JARTIC）交通規制情報オープンデータ
"""
import csv, glob, gzip, io, json, math, os, re, sys, zipfile
from collections import defaultdict

KEEP = {"85": "xw", "87": "bx", "98": "sig", "11": "ow", "14": "nx", "20": "ln", "4": "nb", "5": "nb", "1": "nb",   # 1 歩行者用道路も nb（k=1）
        "13": "ne", "83": "cx", "81": "sw", "110": "bl"}   # 車両進入禁止（点）・自転車の交差点進入禁止（点）・自転車歩道通行可（線）・自転車専用通行帯（線）：まだアプリでは使わない（先に入れておく）


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


NB_NAME = re.compile(r"自転車通行止め|軽車両|軽車[）)]")          # 名前でわかる 自転車の通行止め（コードに自転車のけたがなくても。埼玉の上葛飾橋など）
NB_NOT = re.compile(r"自動車|大型|二輪|バス|[0-9０-９]+[tｔ]|重量|高さ")   # コードが空っぽのとき：この名前なら 自転車は関係ない
NB_MAXLEN = 5000   # これより長い線はすてる（警視庁の 30km の「通行禁止」など）


def has_codes(r, n=1):
    return any((r.get(f"対象車両コード{n}_{c}") or "").strip() not in ("", "0") for c in "ABCD")


def line_len(pts):
    return sum(math.hypot((pts[k][0] - pts[k - 1][0]) * 111000, (pts[k][1] - pts[k - 1][1]) * 111000 * math.cos(math.radians(pts[k][0]))) for k in range(1, len(pts)))


def nb_kind(r):   # 自転車が通れない通行止めか → None（関係ない）／ 0（たしか）／ 1（たぶん：コードが空っぽ）
    name = r.get("県別規制種別名称") or ""
    if any(bike_excluded(r, n) for n in range(1, 6)): return None
    if r.get("共通規制種別コード") == "1": return 0   # 歩行者用道路：自転車を除く でなければ 自転車も入れない（コードが空っぽでも。除外「その他」は 許可車両など）
    # 除外が「その他」だけ・時間が空っぽ（警視庁などの「通行禁止」）：災害のときの緊急交通路みたい。ふだんは関係ないので すてる
    if digit(r.get("除外車両コード1_D", ""), 15) and not (r.get("規制時間1_開始") or "").strip(): return None
    if NB_NAME.search(name): return 0
    if not has_codes(r): return None if NB_NOT.search(name) else 1
    return 0 if any(bike_target(r, n) for n in range(1, 6) if n == 1 or has_codes(r, n)) else None


# 曜日：いつ規制するか → 規制する曜日（JS の getDay：0＝日〜6＝土）のリスト、または None（毎日）。休日はわからないので 平日あつかい（規制する側＝安全なほう）
# 曜日コード：1 土日・2 土日休日・3 日曜休日・4 土・5 日・6 休日・99 その他。データには 説明書にない 9 や、規制と除外に同じコードが入った行もあるので 規制条件の文を先に見る
WEEK = {"1": {0, 6}, "2": {0, 6}, "3": {0}, "4": {6}, "5": {0}, "6": set()}


def week_of(r):
    cond = r.get("規制条件") or ""
    if re.search(r"土曜日?、日曜日?、休日を除く", cond): return [1, 2, 3, 4, 5]
    if re.search(r"日曜日?、休日を除く", cond): return [1, 2, 3, 4, 5, 6]
    if re.search(r"日曜[^。]*に限る", cond): return [0]
    a, x = (r.get("規制曜日コード1") or "").strip(), (r.get("除外曜日コード1") or "").strip()
    if a and x and a == x: return None   # どっちにも同じ → わからない → 毎日
    if x in WEEK: return sorted(set(range(7)) - WEEK[x])
    if a in WEEK and WEEK[a]: return sorted(WEEK[a])
    return None


def time_week(r):   # {h?: "0700-0900", w?: "12345"}（一日中・毎日なら空）
    out = {}
    h0, h1 = (r.get("規制時間1_開始") or "").strip(), (r.get("規制時間1_終了") or "").strip()
    if h0 and h1 and h0.isdigit() and h1.isdigit() and not (int(h0) == 0 and int(h1) in (0, 2400)):
        out["h"] = f"{int(h0):04d}-{int(h1):04d}"
    w = week_of(r)
    if w is not None and len(w) < 7: out["w"] = "".join(map(str, w))
    return out


def pts_of(s):
    out = []
    for q in (s or "").split(";"):
        a = q.split()
        if len(a) == 2:
            try:
                lon, lat = float(a[0]), float(a[1])
                out.append([round(lat, 5), round(lon, 5)])   # 約1m（もともと そこまで正確ではない）
            except ValueError:
                pass
    return out


M = 0.0003   # マスのふち（約30m）。さかい目の近くの線も となりのマスに入れる


def clip(pts):   # 線を マスごとに 切る → {(i, j): [切れはし…]}（マスにかかる線分だけ。ふち M までのばす）
    out = defaultdict(list)
    for k in range(1, len(pts)):
        a, b = pts[k - 1], pts[k]
        i0, i1 = math.floor((min(a[0], b[0]) - M) * 100), math.floor((max(a[0], b[0]) + M) * 100)
        j0, j1 = math.floor((min(a[1], b[1]) - M) * 100), math.floor((max(a[1], b[1]) + M) * 100)
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                S, W, N, E = i / 100 - M, j / 100 - M, (i + 1) / 100 + M, (j + 1) / 100 + M
                t0, t1, ok = 0.0, 1.0, True   # 線分を 四角で切る（Liang–Barsky）
                for p_, q_ in ((-(b[0] - a[0]), a[0] - S), (b[0] - a[0], N - a[0]), (-(b[1] - a[1]), a[1] - W), (b[1] - a[1], E - a[1])):
                    if p_ == 0:
                        if q_ < 0: ok = False
                    else:
                        r = q_ / p_
                        if p_ < 0: t0 = max(t0, r)
                        else: t1 = min(t1, r)
                if not ok or t0 > t1:
                    continue
                runs = out[(i, j)]
                pa = [round(a[0] + (b[0] - a[0]) * t0, 5), round(a[1] + (b[1] - a[1]) * t0, 5)]
                pb = [round(a[0] + (b[0] - a[0]) * t1, 5), round(a[1] + (b[1] - a[1]) * t1, 5)]
                if runs and runs[-1][1] == k - 1 and runs[-1][0][-1] == pa: runs[-1][0].append(pb); runs[-1][1] = k
                else: runs.append([[pa, pb], k])
    return {t: [r[0] for r in rs if len(r[0]) > 1] for t, rs in out.items()}


def zname(i):   # zip の中のファイル名（日本語の名前が cp437 で入っていることがある）
    n = i.filename
    if not (i.flag_bits & 0x800):
        try: n = n.encode("cp437").decode("cp932")
        except (UnicodeEncodeError, UnicodeDecodeError): pass
    return os.path.basename(n)


def sources(args):   # [(名前, CSVのバイト列)]。フォルダ・zip・csv をうけつける
    for a in args:
        if os.path.isdir(a):
            yield from sources(sorted(glob.glob(os.path.join(a, "*.zip")) + glob.glob(os.path.join(a, "*.csv"))))
        elif a.lower().endswith(".zip"):
            with zipfile.ZipFile(a) as z:
                for i in z.infolist():
                    if i.filename.lower().endswith(".csv"):
                        yield zname(i), z.read(i)
        else:
            yield os.path.basename(a), open(a, "rb").read()


def read_csv(name, raw):
    for enc in ("utf-8-sig", "cp932"):
        try:
            return list(csv.DictReader(io.StringIO(raw.decode(enc))))
        except UnicodeDecodeError:
            continue
    raise SystemExit("文字コードがわからない: " + name)


def main():
    out, files = sys.argv[1], sys.argv[2:]
    T = defaultdict(lambda: defaultdict(list)); TS = defaultdict(set)   # TS：そのマスに入っている 県警の名前
    src, stat = [], defaultdict(int)
    for name, raw in sources(files):
        rows = read_csv(name, raw); del raw
        src.append(name); print("  読んだ:", name, len(rows), "件")
        for r in rows:
            k = KEEP.get(r.get("共通規制種別コード"))
            if not k or r.get("意思決定廃止日"):
                continue
            pts = pts_of((r.get("規制場所の経度緯度") or "").split("/")[0] if k == "nb" else r.get("規制場所の経度緯度"))
            if not pts:
                continue
            if k in ("ne", "cx"):   # 点＋α：{p, b?（1＝自転車は除く）, h?, w?}
                if k == "ne" and not bike_target(r) and not any(bike_excluded(r, n) for n in range(1, 6)): continue   # 自転車にかからない（大型だけ など）
                item = {"p": pts[0]}
                if any(bike_excluded(r, n) for n in range(1, 6)): item["b"] = 1
                tw = time_week(r); item.update(tw)
                p = pts[0]; t = (math.floor(p[0] * 100), math.floor(p[1] * 100))
                T[t][k].append(item); TS[t].add(name); stat[k] += 1
                continue
            if k in ("sw", "bl"):   # 線：{p, h?, w?}
                if len(pts) < 2: continue
                tw = time_week(r); stat[k] += 1
                for sec in [x for x in (pts_of(z) for z in (r.get("規制場所の経度緯度") or "").split("/")) if len(x) >= 2]:
                    for t, parts in clip(sec).items():
                        TS[t].add(name)
                        for pp in parts: T[t][k].append({**tw, "p": pp})
                continue
            if k in ("xw", "bx", "sig"):
                p = pts[0]; t = (math.floor(p[0] * 100), math.floor(p[1] * 100))
                T[t][k].append(p); TS[t].add(name)
                stat[k] += 1
                continue
            if len(pts) < 2:
                continue
            if k == "nb":   # 「/」で区間がいくつかに分かれていることがある → 区間ごとに
                q = nb_kind(r)
                if q is None:
                    continue
                item = {}
                if q: item["q"] = 1
                if r.get("共通規制種別コード") == "1": item["k"] = 1; stat["nb_pw"] += 1   # 🚶 歩行者用道路
                else:   # 標識の絵：t "x"＝通行止め（301）／"v"＝車両通行止め（302・車両ぜんぶ）／なし＝自転車・軽車両通行止め（309）
                    # 11/21：コード 4（通行禁止）は 対象車両コードで 標識を決める。空っぽ＝だれも通れない（301）／A の車両＝車両ぜんぶ（302）／
                    #         それ以外（自転車・軽車両 だけ など）＝🚳（309）。前は 4 なら いつも 301 にしていて、自転車だけの所まで 🚧 になっていた
                    if r.get("共通規制種別コード") == "4" and not any(has_codes(r, n) for n in range(1, 6)): item["t"] = "x"; stat["nb_x"] += 1
                    elif r.get("共通規制種別コード") == "4":
                        if any(digit(r.get(f"対象車両コード{n}_A", ""), 1) for n in range(1, 6)): item["t"] = "v"; stat["nb_v"] += 1
                    elif not (NB_NAME.search(r.get("県別規制種別名称") or "") or any(digit(r.get(f"対象車両コード{n}_D", ""), 3) or digit(r.get(f"対象車両コード{n}_D", ""), 6) for n in range(1, 6))):
                        item["t"] = "v"; stat["nb_v"] += 1
                h0, h1 = (r.get("規制時間1_開始") or "").strip(), (r.get("規制時間1_終了") or "").strip()
                if h0 and h1 and not (int(h0) == 0 and int(h1) == 2400):
                    item["h"] = f"{int(h0):04d}-{int(h1):04d}"
                w = week_of(r)
                if w is not None and len(w) < 7: item["w"] = "".join(map(str, w)); stat["nb_week"] += 1   # 規制する曜日（"123456" など）
                secs = [x for x in (pts_of(z) for z in (r.get("規制場所の経度緯度") or "").split("/")) if len(x) >= 2]
                secs = [x for x in secs if line_len(x) <= NB_MAXLEN]
                if not secs:
                    stat["nb_long"] += 1; continue
                stat["nb"] += 1; stat["nb_q"] += q; stat["nb_time"] += "h" in item
                for x in secs:
                    for t, parts in clip(x).items():
                        TS[t].add(name)
                        for pp in parts: T[t]["nb"].append({**item, "p": pp})
                continue
            elif k == "ow":
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
            for t, parts in clip(pts).items():
                TS[t].add(name)
                for q in parts:
                    T[t][k].append({**item, "p": q} if k == "ow" else q)
    os.makedirs(os.path.join(out, "j"), exist_ok=True)
    size = 0
    for (i, j), d in T.items():
        d = {"v": 1, "src": sorted(TS[(i, j)]), **d}
        b = gzip.compress(json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode(), 9)
        open(os.path.join(out, "j", f"{i}_{j}.json.gz"), "wb").write(b)
        size += len(b)
    # データの版（アプリは これが変わったら 端末に保存した JARTIC を取りなおす）。robocopy /MIR で消えないように ここで作る
    import datetime
    ver = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y%m%d%H%M")
    open(os.path.join(out, "j", "ver.json"), "w", encoding="utf-8").write(json.dumps({"v": ver, "src": src}, ensure_ascii=False))
    print("マス", len(T), "ぜんぶで", round(size / 1e6, 2), "MB", dict(stat), "版", ver)


if __name__ == "__main__":
    main()
