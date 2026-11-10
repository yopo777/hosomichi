# -*- coding: utf-8 -*-
"""旧街道（古道）が OpenStreetMap にどう書かれているか調べる
使い方: python check_kodo.py kanto-latest.osm.pbf
"""
import sys, collections, osmium

WORDS = ("旧", "古道", "街道", "道中", "往還", "宿場")
def hit(tags):
    for k, v in tags:
        if any(w in v for w in WORDS) and ("旧" in v or "古" in v or k in ("historic", "old_name", "historic:name")): return True
        if k == "historic" and v in ("road", "route", "milestone", "wayside_shrine"): return True
    return False

class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = collections.Counter(); self.keys = collections.Counter(); self.rels = []
    def way(self, w):
        if hit(w.tags):
            n = w.tags.get("name") or w.tags.get("old_name") or w.tags.get("historic:name") or "(名前なし)"
            self.ways[(n, w.tags.get("highway", "-"))] += 1
            for k, v in w.tags:
                if k in ("historic", "old_name", "historic:name", "name", "alt_name", "loc_name", "official_name", "route"): self.keys[k] += 1
    def relation(self, r):
        if hit(r.tags):
            self.rels.append((r.id, dict(r.tags), len(r.members)))

h = H(); h.apply_file(sys.argv[1])
print("=== 道（way）: 名前と道の種類（多い順） ===")
for (n, hw), c in h.ways.most_common(60): print(f"{c:6d}本  {n}  [{hw}]")
print("\n=== 使われているタグ ===")
for k, c in h.keys.most_common(): print(f"{c:6d}  {k}")
print(f"\n=== まとまり（relation）: {len(h.rels)}個 ===")
for rid, t, m in h.rels[:80]: print(f"r{rid} 部品{m}個  " + " / ".join(f"{k}={v}" for k, v in t.items() if k in ("name", "type", "route", "historic", "network", "ref", "old_name")))
