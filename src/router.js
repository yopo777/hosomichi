// ==== 細道ルート計算エンジン（Web Worker / Node 両用） ====
// 設定（cfg）はページ側から渡される。DEFAULT_CFG がおすすめ値
const DEFAULT_CFG = {
  pen: {                 // 1m を何m分と数えるか（大きいほど避ける）。"no" は通らない
    living_street: 1, residential: 1, service: 1.2, unclassified: 1.2, cycleway: 1,
    tertiary: 5, secondary: 8, primary: 8, trunk: 8,
    footway: 5, pedestrian: 1.5, path: 1.5, track: 1.5,
  },
  steps: "no",           // 階段: "no"=通らない / "ramp"=自転車スロープ付きなら / "yes"=通る
  bridge: 3,             // 歩道橋・地下道（歩行者用）: 倍率 or "no"
  unpaved: "no",         // 砂利・土の道: 倍率 or "no"（1=気にしない）
  wideCross: "crosswalk", // 4車線以上の横断: "signal" / "crosswalk" / "any"
  bigCross: "mid",       // 県道・国道を渡る: "mid"=2車線と同じ / "wide"=4車線と同じ
  park: 5,               // 公園の中の道（園路など）："no"=通らない / 倍率 / 1=気にしない
  cemetery: 5,           // 霊園・墓地の中の道："no"=通らない / 倍率 / 1=気にしない
  station: 5,            // 駅の中の通路（自由通路・コンコース）："no"=通らない / 倍率 / 1=気にしない
  slope: 5,              // 坂道：のぼり 1m を何m分と数えるか（0＝気にしない）
  sidewalk: 3,           // 歩道（段差・柵）のある道の倍率。1＝気にしない
  kodo: 1,               // 旧街道の倍率（1＝気にしない / 0.6 なら 1m を 0.6m 分と数える）。「○○旧道」はその半分くらいの効き目
  oneway: "small",       // 一方通行の逆向き: "no"=通らない / "small"=細い道だけ通る / "all"=太い道も通る
  midCross: 100,         // 2車線の道を横断歩道以外で渡るときの追加コスト(m相当)。旧: "must"/"prefer"/"any"
};
const BASE = { tertiary_link: "tertiary", secondary_link: "secondary", primary_link: "primary", trunk_link: "trunk" };
const OTHER_PENALTY = 2.0;
const EXCLUDE = new Set(["motorway", "motorway_link", "construction", "proposed", "raceway", "bus_guideway",
  "elevator", "corridor", "platform", "bus_stop"]);
const UNPAVED = new Set(["gravel", "fine_gravel", "pebblestone", "unpaved", "dirt", "earth", "ground", "grass",
  "sand", "mud", "compacted", "woodchips", "rock", "grass_paver"]);
const SIGNAL_RADIUS = 35, CROSSWALK_RADIUS = 20;
const HARD = 3000, SOFT = 500;    // 横断ルールを守れないときの追加コスト(m相当)
// 2車線の横断コスト。数字(m)か、むかしの設定の文字
const ONEWAY_OK = new Set(["residential", "living_street", "service", "unclassified", "road", "cycleway", "footway", "path", "pedestrian", "track"]);
const ONEWAY_REV = 1.3;           // 一方通行を逆向きに走るときは少しだけ避ける
const ONEWAY_REV_BIG = 2;         // 太い道の逆向き（反対車線の歩道などを走る）はもう少し避ける
const midPen = v => typeof v === "number" ? v : ({ must: HARD, prefer: SOFT, any: 0 })[v] ?? (isFinite(+v) ? +v : 0);
const MID_ROADS = new Set(["tertiary", "secondary", "primary", "trunk"]);
const CYCLE_OK = new Set(["footway", "path", "pedestrian", "track", "bridleway"]);
const FOOTLIKE = new Set(["footway", "pedestrian", "path", "steps"]);
const KIND_JA = {
  living_street: "生活道路", residential: "住宅街の道", service: "私道・通路", unclassified: "細めの一般道",
  track: "農道", path: "小道", cycleway: "自転車道", pedestrian: "歩行者道", footway: "歩道",
  tertiary: "一般道", secondary: "県道クラス", primary: "国道・主要道", trunk: "幹線国道", steps: "階段", road: "道",
};
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function lanesOf(t) { const n = parseInt(String(t.lanes || "0").split(";")[0]); return isNaN(n) ? 0 : n; }
function isOneway(t) { return ["yes", "1", "true", "-1"].includes(t.oneway); }
// 車線数。lanes がなければ lanes:forward+backward、turn:lanes の数も見る（右折レーンで3車線になる所）
function lanesAll(t) {
  let n = lanesOf(t);
  const fb = (parseInt(t["lanes:forward"]) || 0) + (parseInt(t["lanes:backward"]) || 0) + (parseInt(t["lanes:both_ways"]) || 0);
  const tl = k => t[k] ? String(t[k]).split("|").length : 0;
  const tf = tl("turn:lanes:forward"), tb = tl("turn:lanes:backward");
  const tn = isOneway(t) ? tl("turn:lanes") : (tf || tb) ? (tf || 1) + (tb || 1) : 0;
  return Math.max(n, fb, tn);
}
function isWide(t) {
  const hw = t.highway || "", n = lanesOf(t), ow = isOneway(t);
  if (n >= 4) return true;
  if (!ow && lanesAll(t) >= 3) return true;   // 右折レーンなどで3車線以上＝4車線と同じ扱い
  if ((hw === "trunk" || hw === "trunk_link") && n !== 2 && !(ow && n === 1)) return true;
  if (["trunk", "primary", "secondary"].includes(hw) && ow && n >= 2) return true;
  return false;
}
// 横断のときの道の格: 2=4車線以上 / 1=2車線の道（一般道以上 or 2車線） / 0=細い道
function levelOf(t, cfg) {
  if (isWide(t)) return 2;
  const b = BASE[t.highway] || t.highway;
  if (cfg && cfg.bigCross === "wide" && ["primary", "secondary", "trunk"].includes(b)) return 2;   // 県道・国道は4車線と同じ扱い
  if (MID_ROADS.has(b) || lanesOf(t) >= 2) return 1;
  return 0;
}
function isUnpaved(t) {
  const sf = t.surface || "";
  if (UNPAVED.has(sf) || ["grade3", "grade4", "grade5"].includes(t.tracktype)) return "sure";
  if (!sf && (t.highway === "track" || t.highway === "path") && t.tracktype !== "grade1" && t.bicycle !== "designated") return "maybe";   // 自転車指定なら舗装とみなす
  return null;
}
const yes = v => v && v !== "no";
// 旧街道か：2＝旧街道（旧東海道・甲州道中など）/ 1＝バイパスにされた旧道（国道○号旧道など）/ 0＝ちがう
// 配布データは kodo タグつき（まとまり＝relation も見てある）。Overpass のデータは名前だけで見る
const KODO2 = /^旧.+(街道|道中|往還|海道|山道)$|.(道中|往還|古道)$/, KODO1 = /旧道$|^旧(国道|県道|都道|道道|府道)/;
function kodoOf(t) {
  if (t.kodo) return +t.kodo || 0;
  if (!t.name || t.highway === "trunk" || t.highway === "trunk_link") return 0;
  let lv = 0;
  for (const s0 of String(t.name).split(";")) {
    const s = s0.replace(/[（(][^）)]*[）)]/g, "").trim();
    if (KODO2.test(s)) return 2;
    if (KODO1.test(s)) lv = 1;
  }
  return lv;
}
// 道1本の倍率と表示名。通らないなら null
function wayCost(t, cfg) {
  const hw = t.highway, b = BASE[hw] || hw;
  let p, name = KIND_JA[b] || b;
  if (hw === "steps") {
    if (cfg.steps === "no") return null;
    if (cfg.steps === "ramp" && t["ramp:bicycle"] !== "yes") return null;
    p = cfg.steps === "ramp" ? 8 : 5;
    name = cfg.steps === "ramp" ? "自転車スロープ付き階段" : "階段";
  } else if (CYCLE_OK.has(hw) && t.bicycle === "designated") {
    // 自転車の通行指定がある歩道・小道・農道（川べりのサイクリングロードに多い）＝自転車道あつかい
    p = cfg.pen.cycleway ?? 1; name = "自転車道";
    if (p === "no") return null;
  } else {
    p = cfg.pen[b] ?? OTHER_PENALTY;
    if (p === "no") return null;
    if (lanesOf(t) >= 2 && p > 1) p *= 1.5;
    const kd = kodoOf(t);
    if (kd) {
      const km = Math.min(1, +cfg.kodo || 1);
      p *= kd === 2 ? km : Math.sqrt(km);
      name += kd === 2 ? "・旧街道" : "・旧道";
    }
  }
  if (FOOTLIKE.has(hw) && t.bicycle !== "designated" && (yes(t.bridge) || yes(t.tunnel))) {
    if (cfg.bridge === "no") return null;
    p *= cfg.bridge; name = yes(t.bridge) ? "歩道橋" : "地下道";
  }
  const u = isUnpaved(t);
  if (u) {
    if (u === "sure" && cfg.unpaved === "no") return null;
    const m = cfg.unpaved === "no" ? 20 : cfg.unpaved;
    p *= u === "sure" ? m : Math.max(1, Math.sqrt(m));
    name = u === "sure" ? "砂利・土の道" : "舗装不明の小道";
  }
  return [p, name];
}
const R = 6371000, RAD = Math.PI / 180;
function hav(la1, lo1, la2, lo2) {
  const a = Math.sin((la2 - la1) * RAD / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin((lo2 - lo1) * RAD / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function overpassQuery(b) {
  return `[out:json][timeout:40];
way["highway"]["highway"!~"^(motorway|motorway_link|construction|proposed|platform|corridor|elevator|raceway|bus_guideway|bus_stop)$"]["access"!~"^(no|private)$"]["service"!~"^(parking_aisle|drive-through)$"](${b.s},${b.w},${b.n},${b.e});
(._;>;);
out body qt;`;
}

// ==== ログ（ページの「ログ」タブに出す） ====
let logFn = null;
function log(msg, lv = "i") { if (logFn) logFn({ t: Date.now(), lv, msg }); }
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(2) + "MB" : (n / 1024).toFixed(0) + "KB";

// ==== 途中で止める ====
let stopReq = false;
const stopWaiters = new Set();   // 道路データ待ちをしている所を、止めたときに起こす
const aborts = new Set();
class StopError extends Error { constructor() { super("止めたよ"); this.stopped = true; } }
const checkStop = () => { if (stopReq) throw new StopError(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1マスの取得。8秒返事がなければ次のサーバーにも同時にたのみ（かけもち）、早く返ってきた方を使う
const HEDGE_MS = 8000, TRY_TIMEOUT = 45000;
let cancelFetch = false;   // ルートができた後など、もういらない取得をやめる
async function fetchOSM(b, prog, start = 0, quick = false, tag = "") {
  const body = "data=" + encodeURIComponent(overpassQuery(b));
  const urls = OVERPASS_URLS.map((_, i) => OVERPASS_URLS[(i + start) % OVERPASS_URLS.length]);
  let last;
  const race = () => new Promise(resolve => {
    let next = 0, failed = 0, finished = false, hedge = null;
    const acs = [];
    const finish = v => { if (finished) return; finished = true; clearTimeout(hedge); for (const a of acs) { a.abort(); aborts.delete(a); } resolve(v); };
    const launch = () => {
      if (finished || next >= urls.length) return;
      const url = urls[next++], host = new URL(url).host, ac = new AbortController(), tq = Date.now();
      acs.push(ac); aborts.add(ac);
      log(`取得開始 [${tag}] → ${host}${quick ? "（予備データあり）" : ""}`);
      prog({ msg: `${host} サーバーが計算中`, done: 0, total: 0 });
      const to = setTimeout(() => { ac.timedOut = true; ac.abort(); }, TRY_TIMEOUT);
      clearTimeout(hedge);
      hedge = setTimeout(() => { if (!finished && next < urls.length) { log(`  ${HEDGE_MS / 1000}秒返事がないので、次のサーバーにも同時にたのむ [${tag}]`); launch(); } }, HEDGE_MS);
      (async () => {
        try {
          const res = await fetch(url, { method: "POST", body, signal: ac.signal, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
          if (!res.ok) throw new Error("HTTP " + res.status);
          log(`  返事あり [${tag}] ${host} HTTP ${res.status}（${((Date.now() - tq) / 1000).toFixed(1)}秒）`);
          const total = +res.headers.get("Content-Length") || 0;
          const reader = res.body.getReader(), chunks = []; let done = 0;
          for (;;) {
            const { value, done: fin } = await reader.read();
            if (fin) break;
            chunks.push(value); done += value.length;
            prog({ msg: `${host} ダウンロード中`, done, total });
          }
          const buf = new Uint8Array(done); let o = 0;
          for (const c of chunks) { buf.set(c, o); o += c.length; }
          const text = new TextDecoder().decode(buf), json = JSON.parse(text);
          if (json.remark && /error|timed out|memory/i.test(json.remark)) throw new Error(json.remark.slice(0, 80));
          if (finished) return;
          const nw = json.elements.filter(e => e.type === "way").length;
          log(`  取得OK [${tag}] ${host} ${kb(done)}・道 ${nw}本・点 ${json.elements.length - nw}個（合計 ${((Date.now() - tq) / 1000).toFixed(1)}秒）`, "ok");
          finish({ json, text });
        } catch (e) {
          if (finished) return;
          if (stopReq || cancelFetch) return finish(null);
          last = e; failed++;
          prog({ msg: `${host} 失敗: ${e.message}`, warn: true });
          log(`  失敗 [${tag}] ${host}: ${ac.timedOut ? `時間切れ(${TRY_TIMEOUT / 1000}秒)` : e.name === "AbortError" ? "中止" : e.message}`, "w");
          if (failed >= urls.length) finish(null); else if (next < urls.length && failed >= next) launch();
        } finally { clearTimeout(to); aborts.delete(ac); }
      })();
    };
    launch();
  });
  // サーバーが混んでいる（502/504/429 など）ときは、だんだん長く待ちながら何回かやりなおす
  const WAITS = [10, 20, 40, 60, 90];
  for (let round = 0; round <= (quick ? 0 : WAITS.length); round++) {   // quick：予備の古いデータがあるので1周だけ
    checkStop(); if (cancelFetch) throw new StopError();
    const r = await race();
    checkStop(); if (cancelFetch) throw new StopError();
    if (r) return r;
    if (!quick && round < WAITS.length) {
      log(`全サーバー失敗 [${tag}]。${WAITS[round]}秒待ってやりなおし（${round + 1}/${WAITS.length}）`, "w");
      for (let sec = WAITS[round]; sec > 0; sec--) {
        prog({ msg: `サーバーが混んでるみたい（${last?.message || ""}）。${sec}秒後にもう一度ためすよ（${round + 1}/${WAITS.length}回目）` });
        await sleep(1000); checkStop(); if (cancelFetch) throw new StopError();
      }
    }
  }
  log(`取得あきらめ [${tag}]: ${last?.message || ""}`, "e");
  throw new Error("OSMのデータが取れませんでした（" + (last?.message || "") + "）。サーバーが混んでるみたい。しばらくしてから「▶ 続きを計算」でためしてね");
}

function buildGraph(osm, cfg, onProg) {
  cfg = { ...DEFAULT_CFG, ...cfg, pen: { ...DEFAULT_CFG.pen, ...(cfg && cfg.pen) } };
  const idx = new Map(), lat = [], lon = [], ntags = new Map(), ids = [];
  for (const e of osm.elements) if (e.type === "node") {
    idx.set(e.id, lat.length); ids.push(e.id); if (e.tags) ntags.set(lat.length, e.tags); lat.push(e.lat); lon.push(e.lon);
  }
  const N = lat.length, adj = Array.from({ length: N }, () => []);
  const lvl = new Uint8Array(N), inGraph = new Uint8Array(N);
  const d = (u, v) => hav(lat[u], lon[u], lat[v], lon[v]);
  const NE = osm.elements.length; let ei = 0;
  const mainWays = [];
  const cosl0 = Math.cos((lat[0] || 35) * RAD), X = i => lon[i] * cosl0 * 111320, Y = i => lat[i] * 111320;
  // 歩道（段差・柵があることが多い）がある道：道のすぐ横に、同じ向きの歩道の線が走っているか
  const swPen = +cfg.sidewalk || 1, fwGrid = new Map(), GS = 20;
  if (swPen > 1) {
    for (const e of osm.elements) {
      if (e.type !== "way") continue;
      const t = e.tags || {};
      if (!(t.highway === "footway" || t.highway === "cycleway" || (t.highway === "path" && t.footway === "sidewalk"))) continue;
      if (t.footway === "crossing" || t.cycleway === "crossing" || t.crossing) continue;
      const nd = e.nodes.map(id => idx.get(id)).filter(x => x !== undefined);
      for (let k = 1; k < nd.length; k++) {
        const ax = X(nd[k - 1]), ay = Y(nd[k - 1]), bx = X(nd[k]), by = Y(nd[k]), seg = [ax, ay, bx, by];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / GS));
        const seen = new Set();
        for (let s = 0; s <= n; s++) {
          const key = Math.floor((ax + (bx - ax) * s / n) / GS) + "," + Math.floor((ay + (by - ay) * s / n) / GS);
          if (seen.has(key)) continue; seen.add(key);
          if (!fwGrid.has(key)) fwGrid.set(key, []); fwGrid.get(key).push(seg);
        }
      }
    }
  }
  const SW_ROADS = new Set(["living_street", "residential", "unclassified", "service", "tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link", "trunk", "trunk_link", "road"]);
  const swTag = t => ["both", "left", "right", "separate", "yes"].includes(t.sidewalk) || ["yes", "separate"].includes(t["sidewalk:both"]) || ["yes", "separate"].includes(t["sidewalk:left"]) || ["yes", "separate"].includes(t["sidewalk:right"]);
  const hasSW = (u, v) => {   // 区間 u→v の横（13m以内）に、平行な歩道の線があるか（半分以上の場所で）
    const ax = X(u), ay = Y(u), bx = X(v), by = Y(v), L = Math.hypot(bx - ax, by - ay);
    if (L < 1) return false;
    const ux = (bx - ax) / L, uy = (by - ay) / L, n = Math.max(1, Math.round(L / 10));
    let hit = 0;
    for (let s = 0; s < n; s++) {
      const f = (s + 0.5) / n, px = ax + (bx - ax) * f, py = ay + (by - ay) * f, cx = Math.floor(px / GS), cy = Math.floor(py / GS);
      let ok = false;
      for (let i = -1; i <= 1 && !ok; i++) for (let j = -1; j <= 1 && !ok; j++) {
        for (const [qx, qy, rx, ry] of fwGrid.get((cx + i) + "," + (cy + j)) || []) {
          const dx = rx - qx, dy = ry - qy, l = Math.hypot(dx, dy); if (l < 1) continue;
          if (Math.abs((dx * ux + dy * uy) / l) < 0.93) continue;   // 平行じゃない（横断歩道など）
          let tq = ((px - qx) * dx + (py - qy) * dy) / (l * l); tq = Math.max(0, Math.min(1, tq));
          if (Math.hypot(px - qx - tq * dx, py - qy - tq * dy) <= 13) { ok = true; break; }
        }
      }
      if (ok) hit++;
    }
    return hit * 2 >= n;
  };
  let swLen = 0;
  // 駅の中・駅の自由通路：駅（配布データの駅一覧）から150m以内の、歩道・小道で、
  // 橋・地下・屋根つき・建物の中・階（level）がある・名前に「通路」「コンコース」「改札」「駅」がある道
  const stPen = cfg.station === "no" ? null : (+cfg.station || 1), STA_R = 150;
  const cemPen = cfg.cemetery === "no" ? null : (+cfg.cemetery || 1), parkPen = cfg.park === "no" ? null : (+cfg.park || 1);
  const inArea = (kind, nd) => {   // 道のまん中の点（と両はし）が はんいの中か
    const m = nd[nd.length >> 1];
    return areaHas(kind, lat[m], lon[m]) || (nd.length > 2 && areaHas(kind, lat[nd[0]], lon[nd[0]]) && areaHas(kind, lat[nd[nd.length - 1]], lon[nd[nd.length - 1]]));
  };
  const wayLen = nd => { let L = 0; for (let i = 1; i < nd.length; i++) L += hav(lat[nd[i - 1]], lon[nd[i - 1]], lat[nd[i]], lon[nd[i]]); return L; };
  const nearSta = (la, lo, R) => {
    if (!stationGrid) return false;
    const cx = Math.floor(lo / 0.002), cy = Math.floor(la / 0.002);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [sl, so] of stationGrid.get((cx + a) + "," + (cy + b)) || [])
      if (hav(la, lo, sl, so) < R) return true;
    return false;
  };
  const isStaPath = (t, nd) => {
    if (!["footway", "pedestrian", "path", "corridor"].includes(t.highway)) return false;
    const inside = yes(t.bridge) || yes(t.tunnel) || t.tunnel === "building_passage" || yes(t.covered) || yes(t.indoor) || t.level != null
      || (t.layer && t.layer !== "0") || /通路|コンコース|改札|駅/.test(t.name || "");
    const m = nd[nd.length >> 1], ends = [nd[0], m, nd[nd.length - 1]];
    if (inside) return ends.some(i => nearSta(lat[i], lon[i], STA_R));
    // 印のない歩道でも、駅のすぐそば（60m）で歩道（sidewalk）・横断歩道でなければ、駅の中の通路とみる
    if (t.highway !== "footway" && t.highway !== "corridor") return false;
    if (t.footway === "sidewalk" || t.footway === "crossing") return false;
    return ends.every(i => nearSta(lat[i], lon[i], 60));
  };
  for (const e of osm.elements) {
    if (onProg && (++ei & 0x3fff) === 0) onProg(ei / NE * 0.9);
    if (e.type !== "way") continue;
    const t = e.tags || {}, hw = t.highway;
    if (!hw || EXCLUDE.has(hw)) continue;
    if (t.access === "no" || t.access === "private" || t.bicycle === "no") continue;
    const nd = e.nodes.map(id => idx.get(id)).filter(x => x !== undefined);
    if (nd.length < 2) continue;
    const L0 = levelOf(t, cfg);
    if (L0) { mainWays.push([nd, L0]); for (const i of nd) if (L0 > lvl[i]) lvl[i] = L0; }   // 通らない道でも「横断する道」としては数える
    const wc = wayCost(t, cfg);
    if (!wc) continue;
    let [pen, name] = wc;
    if (stationGrid && cfg.station !== 1 && isStaPath(t, nd)) {   // 駅の中の通路
      if (stPen === null) continue;
      pen = Math.max(pen, cfg.pen.footway || 1) * stPen; name = "駅の通路";
    }
    if (areaGrids && cfg.cemetery !== 1 && !BIG_HW.has(hw) && inArea("cemetery", nd)) {   // 霊園・墓地の中の道
      if (cemPen === null) continue;
      pen *= cemPen; name = "霊園の中";
    }
    // 公園の中の道（園路・交通公園のコースなど）。川ぞいのサイクリングロードみたいな
    // 長い（400m以上）自転車道と、ふつうの道（住宅街の道など）は、公園の中でもそのまま通る
    else if (areaGrids && areaGrids.park && cfg.park !== 1 && !BIG_HW.has(hw) && inArea("park", nd)
      && !(["residential", "unclassified", "living_street"].includes(hw) || (hw === "cycleway" && wayLen(nd) >= 400))) {
      if (parkPen === null) continue;
      pen = Math.max(pen, 1) * parkPen; name = "公園の中";
    }
    if (["footway", "path", "pedestrian", "cycleway", "track"].includes(hw) && nd.some(i => ntags.get(i)?.railway === "crossing")) {
      let wl = 0; for (let i = 1; i < nd.length; i++) wl += d(nd[i - 1], nd[i]);
      if (wl < 200) { pen = 1.0; name = "歩行者・自転車用踏切"; }
    }
    let ow = t.oneway; if (t["oneway:bicycle"] === "no") ow = "no";
    let fwd = ow !== "-1", back = !["yes", "1", "true"].includes(ow);
    // 一方通行の逆向き：細い道なら自転車はだいたい通れる（「自転車を除く」）。橋・トンネル・大きい道・自転車も一方通行の道はだめ
    let rp = pen, rname = name;
    const small = ONEWAY_OK.has(hw) && lanesOf(t) < 2;
    if (fwd !== back && (cfg.oneway === "small" || cfg.oneway === "all") && t["oneway:bicycle"] !== "yes" && !yes(t.bridge) && !yes(t.tunnel)
        && (small || cfg.oneway === "all")) {
      fwd = back = true; rp = pen * (small ? ONEWAY_REV : ONEWAY_REV_BIG);
      rname = small ? name + "（一方通行を逆向き）" : `歩道（${name}の逆向き）`;   // 太い道の逆向き＝歩道を走る（色も歩道の色）
    }
    const rev = ow === "-1";   // 逆向き一方通行なら「正方向」が逆走
    const swRoad = swPen > 1 && SW_ROADS.has(hw), swAll = swRoad && swTag(t);
    for (let i = 1; i < nd.length; i++) {
      const u = nd[i - 1], v = nd[i], L = d(u, v);
      inGraph[u] = 1; inGraph[v] = 1;
      const m = swRoad && (swAll || hasSW(u, v)) ? swPen : 1;   // 歩道のある道は避ける
      if (m > 1) swLen += L;
      if (fwd) adj[u].push({ v, c: L * (rev ? rp : pen) * m, L, l: L0, k: rev ? rname : name, w: e.id });
      if (back) adj[v].push({ v: u, c: L * (rev ? pen : rp) * m, L, l: L0, k: rev ? name : rname, w: e.id });
    }
  }
  // 大きい道の向き（横断かどうか＝道の反対側に出るかを判定するため）
  const dirX = new Float32Array(N), dirY = new Float32Array(N);
  const cosl = Math.cos((lat[0] || 35) * RAD);
  for (const [nd, L0] of mainWays) for (let k = 0; k < nd.length; k++) {
    const i = nd[k]; if (lvl[i] !== L0 || dirX[i] || dirY[i]) continue;
    const a = nd[Math.max(0, k - 1)], b = nd[Math.min(nd.length - 1, k + 1)];
    dirX[i] = (lon[b] - lon[a]) * cosl * 111320; dirY[i] = (lat[b] - lat[a]) * 111320;
  }
  // 信号・横断歩道の場所
  const mkGrid = () => new Map();
  const gSig = mkGrid(), gXw = mkGrid();
  const put = (g, i) => { const k = Math.round(lat[i] * 2000) + "," + Math.round(lon[i] * 2000); if (!g.has(k)) g.set(k, []); g.get(k).push(i); };
  for (const [i, t] of ntags) {
    if (t.highway === "traffic_signals" || t.crossing === "traffic_signals" || t["crossing:signals"] === "yes") put(gSig, i);
    else if (t.highway === "crossing" && !["no", "unmarked", "informal"].includes(t.crossing)) put(gXw, i);
  }
  const near = (g, i, r) => {
    const a = Math.round(lat[i] * 2000), b = Math.round(lon[i] * 2000);
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++)
      for (const j of g.get((a + x) + "," + (b + y)) || []) if (d(i, j) <= r) return true;
    return false;
  };
  // 横断の追加コスト（その点で lvl の道を横切るとき）と種類 1=信号 2=横断歩道 3=なし
  const xcost = new Float32Array(N), xkind = new Uint8Array(N);
  let nNodes = 0;
  for (let i = 0; i < N; i++) {
    if (inGraph[i]) nNodes++;
    if (!lvl[i] || !inGraph[i]) continue;
    const sig = near(gSig, i, SIGNAL_RADIUS), xw = near(gXw, i, CROSSWALK_RADIUS);
    xkind[i] = sig ? 1 : xw ? 2 : 3;
    if (lvl[i] === 2) xcost[i] = cfg.wideCross === "any" ? 0 : sig ? 0 : (cfg.wideCross === "crosswalk" && xw) ? 0 : HARD;
    else xcost[i] = sig || xw ? 0 : midPen(cfg.midCross);
  }
  const nBlk = applyBlocks(lat, lon, adj, N);
  // 1周の帰り道：通った所を通りにくくしたぶん、道を渡るルールも同じだけ重くする（でないと「遠回りより国道を信号なしで渡る」になる）
  if (usedNodes && usedNodes.size) for (let i = 0; i < N; i++) if (xcost[i]) xcost[i] *= USED_PEN;
  return { lat, lon, adj, lvl, xcost, xkind, inGraph, nNodes, cfg, nBlk, dirX, dirY, cosl, idx, ids, turn: +(cfg.turn || 0), swLen,
    hk: Math.min(1, +cfg.kodo || 1) };   // 旧街道を 1m＜1m と数えるときは、A* の見こみもそのぶん小さくする（でないと良いルートを見のがす）
}

// 🚫 通れない印（自分でつけた印。画面から毎回もらう）：印から12m以内を通る道のつながりを切る
let blockPts = [], avoidPts = [];   // 🚫 通れない（道を切る）／ ⚠ 通りたくない（その道を ×AVOID_PEN）
const AVOID_PEN = 5;
const BLOCK_R = 12;
let usedNodes = null;   // ぐるっと1周：前の区間で通ったあたり（約180mのマス）。同じ道も、となりの平行な道も通りにくくする
const USED_PEN = 2;
const usedKey = (la, lo) => Math.round(la * 600) + "," + Math.round(lo * 490);   // 約180mのマス
function markUsed(route) {
  for (let i = 0; i < route.length; i++) {
    const [a, b] = route[i]; usedNodes.add(usedKey(a, b));
    if (i + 1 < route.length) { const [c, d] = route[i + 1], n = Math.floor(hav(a, b, c, d) / 40);
      for (let k = 1; k <= n; k++) usedNodes.add(usedKey(a + (c - a) * k / (n + 1), b + (d - b) * k / (n + 1))); }
  }
}
function applyBlocks(lat, lon, adj, N) {
  if (usedNodes && usedNodes.size) {
    const u8 = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (adj[i] && adj[i].length && usedNodes.has(usedKey(lat[i], lon[i]))) u8[i] = 1;
    for (let u = 0; u < N; u++) if (u8[u]) for (const e of adj[u]) if (u8[e.v]) e.c *= USED_PEN;
  }
  if (!blockPts.length && !avoidPts.length) return 0;
  const allPts = [...blockPts.map(p => [p[0], p[1], 0]), ...avoidPts.map(p => [p[0], p[1], 1])];
  const C = 0.002, g = new Map();   // 印を約200mのマスに入れる
  for (const [la, lo, kind] of allPts) { const k = Math.floor(la / C) + "," + Math.floor(lo / C); if (!g.has(k)) g.set(k, []); g.get(k).push([la, lo, kind]); }
  const nearBlocks = i => {
    const a = Math.floor(lat[i] / C), b = Math.floor(lon[i] / C), out = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (const p of g.get((a + x) + "," + (b + y)) || []) out.push(p);
    return out;
  };
  const cosl = Math.cos((allPts[0][0]) * RAD), M = 111320;
  const segDist = (p, u, v) => {   // 点 p と 線分 u-v のきょり（m）
    const ax = (lon[u] - p[1]) * cosl * M, ay = (lat[u] - p[0]) * M, bx = (lon[v] - p[1]) * cosl * M, by = (lat[v] - p[0]) * M;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    return Math.hypot(ax + dx * t, ay + dy * t);
  };
  // 印ごとに、いちばん近い道（とそれと同じくらい近い道＝交差点なら全部）だけを切る。
  // 12m 以内でも、となりの道（いちばん近い道より 4m 以上はなれている）は切らない
  const hits = [], dmin = new Map();
  for (let u = 0; u < N; u++) {
    if (!adj[u] || !adj[u].length) continue;
    const bs = nearBlocks(u); if (!bs.length) continue;
    for (const e of adj[u]) for (const p of bs) {
      const d = segDist(p, u, e.v); if (d >= BLOCK_R) continue;
      hits.push([u, e.v, p, d]); if (!(dmin.get(p) <= d)) dmin.set(p, d);
    }
  }
  let n = 0; const avoidW = new Set();
  for (const [u, v, p, d] of hits) {
    if (d > dmin.get(p) + 4) continue;
    if (p[2]) { const e = adj[u].find(x => x.v === v); if (e) avoidW.add(e.w); continue; }   // ⚠ 通りたくない：その道（OSMの1本）をまるごと
    const before = adj[u].length;
    adj[u] = adj[u].filter(x => x.v !== v); adj[v] = adj[v].filter(x => x.v !== u);
    if (adj[u].length < before) n++;
  }
  if (avoidW.size) { for (let u = 0; u < N; u++) if (adj[u]) for (const e of adj[u]) if (avoidW.has(e.w)) e.c *= AVOID_PEN; n += avoidW.size; }
  return n;
}
// ゲージ用：処理ぜんたいのどこまで来たか（0〜1）。1=道路データ 2=つながり 3=探索 4=ほかのルート
function stageFrac(p) {
  if (!p || !p.stage) return null;
  if (p.stage === 1) return 0.03 + 0.57 * (p.total ? Math.min(1, p.done / p.total) : 0);
  return [0, 0, 0.65, 0.8, 0.9][p.stage] ?? null;
}
// ==== 🔁 ぐるっと1周：出発のまわりに見えない経由地を2つ置いて、三角形にまわって出発にもどる ====
// 向き（北・東・南・西に張りだす）を変えて候補を作り、走りたい長さに近い順に3本まで出す
async function loopRoute(req, prog) {
  const s = req.s, V = req.via || null, D = Math.max(3, +req.loop || 20) * 1000, cfg = { ...(req.cfg || {}), alts: false };
  const c0 = Math.cos(s[0] * RAD), M = 111320;
  const at = (la, lo, ang, d) => [la + Math.cos(ang) * d / M, lo + Math.sin(ang) * d / (M * c0)];   // ang: 北=0 東=π/2
  const out = [], T0 = Date.now();
  const dV = V ? hav(s[0], s[1], V[0], V[1]) : 0;
  log(`==== 🔁 ぐるっと1周 ${D / 1000}km（出発 ${s[0].toFixed(5)},${s[1].toFixed(5)}${V ? `・経由地まで ${(dV / 1000).toFixed(1)}km` : ""}） ====`, "h");
  // 候補1本：出発 → pts… → 出発
  const runCand = async (label, pts, ci, nc) => {
    const stops = pts.filter(p => p.via).map(p => ({ la: p[0], lo: p[1], kind: "via", name: "経由地" }));
    const way = [s, ...pts, s], parts = [], nl = way.length - 1;
    usedNodes = new Set(); let dupM = 0, allM = 0;
    log(`--- ${label} ---`, "h");
    try {
      for (let li = 0; li < nl; li++) {
        const k0 = ci * nl + li, K = nc * nl;   // ゲージ：候補×区間 の何番目か
        prog({ msg: `🔁 ${label} ${li + 1}/${nl}区間（候補 ${ci + 1}/${nc}）`, frac: k0 / K });
        const r = await route({ ...req, s: li ? parts[li - 1].route[parts[li - 1].route.length - 1] : way[0], g: way[li + 1], cfg, loop: undefined, via: undefined },
          p => { const f = stageFrac(p); prog({ ...p, stage: undefined, msg: `🔁 ${label} ${li + 1}/${nl}区間（候補 ${ci + 1}/${nc}）\n` + (p.msg || ""), frac: f == null ? undefined : (k0 + f) / K }); }, () => {});
        if (li) for (let i = 1; i < r.route.length; i++) {   // 前の区間と同じあたりを走る長さ（往復っぽさ）
          const [a1, b1] = r.route[i - 1], [a2, b2] = r.route[i], m = hav(a1, b1, a2, b2);
          allM += m; if (usedNodes.has(usedKey((a1 + a2) / 2, (b1 + b2) / 2))) dupM += m;
        } else allM += r.len || 0;
        markUsed(r.route);
        parts.push(r);
      }
    } catch (e) { if (stopReq) throw e; log(`${label}は作れなかった: ${e.message}`, "w"); return null; }
    const L = joinLegs(parts);
    L.dup = allM ? dupM / allM : 0;
    log(`${label}: ${(L.len / 1000).toFixed(1)}km（目標 ${D / 1000}km）・同じあたりを往復 ${Math.round(L.dup * 100)}%`, "ok");
    L.how = label; L.stops = stops.map(p => ({ p: [p.la, p.lo], kind: p.kind, name: p.name }));
    out.push(L);
    return L;
  };
  try {
    if (!V) {
      // 経由地なし：出発を通る円の上に見えない経由地を2つ（三角形）。向きを変えて4本
      const DIRS = [["北まわり", 0], ["東まわり", 90], ["南まわり", 180], ["西まわり", 270]];
      let fac = 6.5;   // 道のり ≒ 半径 × fac（三角形の周り 5.2 × 道のくねくね）。1本目の結果で合わせる
      for (let di = 0; di < DIRS.length && !stopReq; di++) {
        const [dn, deg] = DIRS[di], th = deg * RAD, R = D / fac, c = at(s[0], s[1], th, R);   // 円の中心（出発から その向きに R）
        const w1 = at(c[0], c[1], th + Math.PI + 2 * Math.PI / 3, R), w2 = at(c[0], c[1], th + Math.PI - 2 * Math.PI / 3, R);
        const L = await runCand(`${dn}（半径 ${(R / 1000).toFixed(1)}km）`, [w1, w2], di, DIRS.length);
        if (L) L.how = dn;
        if (L && out.length === 1) fac = Math.min(9, Math.max(4.5, fac * L.len / D));   // 長さのずれを次の候補で直す
      }
    } else {
      // 経由地あり：出発と経由地のまん中から左右に見えない点を出す。①左に三角形 ②右に三角形 ③行きは左・帰りは右（ひし形）
      // 目標が短すぎるときは 経由地まで行って別の道で帰る
      let kf = 1.25;   // 道のり ≒ 図形の周り × kf。1本目の結果で合わせる
      const ex = (V[1] - s[1]) * c0 * M, ny = (V[0] - s[0]) * M, mid = [(s[0] + V[0]) / 2, (s[1] + V[1]) / 2];
      const Vp = Object.assign([V[0], V[1]], { via: true });
      const off = (base, side, h) => [base[0] + (ex / dV) * side * h / M, base[1] + (-ny / dV) * side * h / (M * c0)];   // side=1 で左
      const plan = ["L", "R", "LR"];
      for (let ci = 0; ci < plan.length && !stopReq; ci++) {
        const P = D / kf, k = plan[ci];
        if (k !== "LR") {
          const h2 = ((P - dV) / 2) ** 2 - dV * dV / 4;
          if (h2 <= (dV * 0.15) ** 2) {   // 三角形にするほど長さがない
            if (ci === 0) { log(`目標 ${D / 1000}km だと、経由地まで行って帰るだけで ほぼいっぱい（まっすぐで往復 ${(2 * dV / 1000).toFixed(1)}km）。行きと帰りを別の道にするよ`, "w");
              await runCand("経由地まで行って別の道で帰る", [Vp], 0, 1); }
            break;
          }
          const h = Math.sqrt(h2), W = off(mid, k === "L" ? 1 : -1, h);
          await runCand(k === "L" ? "経由地へ行って左まわりで帰る" : "経由地へ行って右まわりで帰る", [Vp, W], ci, plan.length);
        } else {
          const h2 = (P / 4) ** 2 - dV * dV / 4;
          if (h2 <= (dV * 0.15) ** 2) continue;
          const h = Math.sqrt(h2);
          await runCand("行きは左・帰りは右", [off(mid, 1, h), Vp, off(mid, -1, h)], ci, plan.length);
        }
        if (out.length === 1 && !out[0].kfSet) { out[0].kfSet = 1; kf = Math.min(1.8, Math.max(1.05, kf * out[0].len / D)); }
      }
    }
  } finally { usedNodes = null; }
  if (!out.length) throw new Error("1周するルートが作れなかったよ。長さを変えるか、出発を道の多い所にしてみてね");
  const score = o => Math.abs(o.len - D) / D + o.dup * 1.5;   // 長さが目標に近くて、往復の少ないもの
  out.sort((a, b) => score(a) - score(b));
  const [main, ...others] = out.slice(0, 3);
  log(`==== 🔁 完了 ${out.map(o => o.how + " " + (o.len / 1000).toFixed(1) + "km").join("・")}（${((Date.now() - T0) / 1000).toFixed(1)}秒） ====`, "ok");
  return { ...main, alts: others, loop: D / 1000, sec: (Date.now() - T0) / 1000 };
}
// 区間をつなぐ。つなぎ目の「行ってすぐもどる」ムダはけずる
function joinLegs(parts) {
  let route = parts[0].route.slice(), ek = (parts[0].ek || []).slice();
  const res = { ok: [], xw: [], ng: [], kinds: {}, turns: 0, len: 0 };
  const same = (p, q) => p && q && p[0] === q[0] && p[1] === q[1];
  for (let i = 0; i < parts.length; i++) {
    const P = parts[i];
    if (i) {
      const R2 = P.route, E2 = P.ek || []; let k = 0;
      while (k + 1 < R2.length && route.length - 2 - k >= 0 && same(route[route.length - 2 - k], R2[1 + k])) k++;
      for (let j = 0; j < k; j++) res.len -= 2 * hav(R2[j][0], R2[j][1], R2[j + 1][0], R2[j + 1][1]);
      route = route.slice(0, route.length - k).concat(R2.slice(1 + k));
      ek = ek.slice(0, ek.length - k).concat(E2.slice(k));
    }
    res.ok.push(...(P.ok || [])); res.xw.push(...(P.xw || [])); res.ng.push(...(P.ng || []));
    for (const [k, v] of Object.entries(P.kinds || {})) res.kinds[k] = (res.kinds[k] || 0) + v;
    res.turns += P.turns || 0; res.len += P.len || 0;
  }
  return { ...res, route, ek: ek.length === route.length - 1 ? ek : undefined };
}
// 道の「つながりのかたまり」。駅の中の通路や公園の中の小道など、外とつながってない所を見分ける
function components(G) {
  if (G.comp) return G.comp;
  const N = G.lat.length, par = new Int32Array(N);
  for (let i = 0; i < N; i++) par[i] = i;
  const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let u = 0; u < N; u++) for (const e of G.adj[u]) { const a = f(u), b = f(e.v); if (a !== b) par[a] = b; }
  const root = new Int32Array(N), size = new Map();
  for (let i = 0; i < N; i++) if (G.inGraph[i]) { root[i] = f(i); size.set(root[i], (size.get(root[i]) || 0) + 1); }
  let big = 0; for (const v of size.values()) big = Math.max(big, v);
  return (G.comp = { root, size, big });
}
// 近い点をえらぶ：ちゃんと外の道とつながっている点（大きいかたまり）だけ
function nearestGood(G, la, lo, sameAs = -1) {
  const C = components(G), min = Math.min(C.big, Math.max(30, C.big * 0.05));
  let best = -1, bd = Infinity, any = -1, ad = Infinity;
  for (let i = 0; i < G.lat.length; i++) {
    if (!G.inGraph[i]) continue;
    const d = hav(la, lo, G.lat[i], G.lon[i]);
    if (d < ad) { ad = d; any = i; }
    const ok = sameAs >= 0 ? C.root[i] === C.root[sameAs] : C.size.get(C.root[i]) >= min;
    if (ok && d < bd) { bd = d; best = i; }
  }
  return { n: best, d: bd, nearestAny: any, dAny: ad, size: best >= 0 ? C.size.get(C.root[best]) : 0, anySize: any >= 0 ? C.size.get(C.root[any]) : 0 };
}

function nearest(G, la, lo) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < G.lat.length; i++) {
    if (!G.inGraph[i]) continue;
    const dd = hav(la, lo, G.lat[i], G.lon[i]);
    if (dd < bd) { bd = dd; best = i; }
  }
  return [best, bd];
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(k, v) {
    const K = this.k, V = this.v; let i = K.length; K.push(k); V.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= k) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = k; V[i] = v;
  }
  pop() {
    const K = this.k, V = this.v, rk = K[0], rv = V[0], lk = K.pop(), lv = V.pop(), n = K.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= lk) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = lk; V[i] = lv;
    }
    return [rk, rv];
  }
}

// A*：ゴールまでのまっすぐな距離を見こみに足して、ゴールの方向から先に調べる（はやい）
// 状態 = (点, 入ってきた道の格)。格の低い道 → 格の高い道の点 → 格の低い道 と抜けたら「横断」
// g<0 のときはゴールが範囲の外：調べられるところまで全部調べる（途中までのルート用）
function search(G, s, g, gll, useLen, onProg) {
  const N = G.lat.length, best = new Float64Array(N * 3).fill(Infinity), prev = new Int32Array(N * 3).fill(-1);
  const glat = gll[0], glon = gll[1], kx = Math.cos(glat * RAD) * 111320 * 0.995, ky = 111320 * 0.995;
  const hk = useLen ? 1 : (G.hk || 1);
  const H = i => Math.hypot((G.lon[i] - glon) * kx, (G.lat[i] - glat) * ky) * hk;
  const closed = new Uint8Array(N * 3), inWay = new Float64Array(N * 3).fill(-1);  // その状態に入ってきた道
  const h = new Heap(); best[s * 3] = 0; h.push(H(s), s * 3);
  let goal = -1, pops = 0, far = 0;
  const D0 = H(s) || 1;
  while (h.size) {
    const st = h.pop()[1];
    if (closed[st]) continue;
    closed[st] = 1;
    const c = best[st];
    const u = (st / 3) | 0, ul = st % 3;
    if ((++pops & 0x7fff) === 0 && onProg) {
      far = Math.max(far, 1 - H(u) / D0);
      onProg(Math.min(0.99, Math.max(0, far)));
    }
    if (u === g) { goal = st; break; }
    const L = G.lvl[u], pu = prev[st] >= 0 ? (prev[st] / 3) | 0 : -1;
    const chk = !useLen && L > 0 && G.xcost[u] > 0 && pu >= 0;
    const tw = !useLen && G.turn > 0 && pu >= 0 ? inWay[st] : -1;
    for (const e of G.adj[u]) {
      let nc = c + (useLen ? e.L : e.c);
      if (chk && isCrossing(G, pu, u, e.v, ul, e.l, L)) nc += G.xcost[u];
      if (tw >= 0 && e.w !== tw && isTurn(G, pu, u, e.v)) nc += G.turn;   // 別の道へ曲がる
      const ns = e.v * 3 + e.l;
      if (nc < best[ns] && !closed[ns]) { best[ns] = nc; prev[ns] = st; inWay[ns] = e.w; h.push(nc + H(e.v), ns); }
    }
  }
  return { goal, best, prev, closed, H, pops };
}
function pathTo(prev, st) { const p = []; for (; st >= 0; st = prev[st]) p.push((st / 3) | 0); return p.reverse(); }
function dijkstra(G, s, g, useLen, onProg) {
  const r = search(G, s, g, [G.lat[g], G.lon[g]], useLen, onProg);
  if (r.goal < 0) throw new Error("ルートが見つかりませんでした（道がつながっていないか、設定で通れない道が多すぎるかも）");
  return pathTo(r.prev, r.goal);
}

// 大きい道(格L)の点 u で、p→u→v と進むのが「道を横切る」かどうか
// ・細い道→細い道：p と v が大きい道の反対側にある
// ・細い道→大きい道 / 大きい道→細い道：右折（左側通行なので反対車線を横切る）
function isCrossing(G, p, u, v, inL, outL, L) {
  if (inL >= L && outL >= L) return false;           // 大きい道をそのまま進む
  const X = i => [(G.lon[i] - G.lon[u]) * G.cosl * 111320, (G.lat[i] - G.lat[u]) * 111320];
  const [px, py] = X(p), [vx, vy] = X(v);
  if (inL < L && outL < L) {
    const dx = G.dirX[u], dy = G.dirY[u];
    if (!dx && !dy) return true;
    const a = dx * py - dy * px, b = dx * vy - dy * vx;
    return a * b < 0;                                  // 反対側に出る
  }
  // 曲がる向き：入ってきた向き (u-p) から出ていく向き (v-u)
  const ix = -px, iy = -py, cr = ix * vy - iy * vx, dt = ix * vx + iy * vy;
  return Math.atan2(cr, dt) < -0.5;                  // 約30°以上の右折
}

// p→u→v で、進む向きが40°以上かわるか（＝曲がる）
function isTurn(G, p, u, v) {
  const c = G.cosl;
  const ax = (G.lon[u] - G.lon[p]) * c, ay = G.lat[u] - G.lat[p], bx = (G.lon[v] - G.lon[u]) * c, by = G.lat[v] - G.lat[u];
  const ang = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
  return ang > 0.7;
}

function edge(G, u, v) {
  let best = null; for (const e of G.adj[u]) if (e.v === v && (!best || e.c < best.c)) best = e;
  return best;
}

function analyze(G, path) {
  const ok = [], xw = [], ng = [], ngIdx = [], kinds = {}, ek = []; let len = 0, turns = 0;
  for (let i = 1; i < path.length; i++) {
    const e = edge(G, path[i - 1], path[i]); len += e.L; kinds[e.k] = (kinds[e.k] || 0) + e.L; ek.push(e.k);
  }
  for (let i = 1; i < path.length - 1; i++) {
    if (edge(G, path[i - 1], path[i]).w !== edge(G, path[i], path[i + 1]).w && isTurn(G, path[i - 1], path[i], path[i + 1])) turns++;
    const u = path[i], L = G.lvl[u]; if (!L) continue;
    if (isCrossing(G, path[i - 1], u, path[i + 1], edge(G, path[i - 1], u).l, edge(G, u, path[i + 1]).l, L)) {
      const p = [G.lat[u], G.lon[u]], k = G.xkind[u];
      if (k === 1) ok.push(p); else if (k === 2) xw.push(p);
      else if (G.xcost[u] > 0 || L === 2) { ng.push(p); ngIdx.push(i); }   // ルール違反（または4車線を信号なし）
    }
  }
  return { ok, xw, ng, ngIdx, kinds, len, ek, turns };
}

// ==== タイル分割取得 ＋ 保存（メモリ ＋ IndexedDB） ====
// 範囲を TILE 度ごとのマスに分けて、1マスずつ取得・保存する
// マスの大きさ：近場は細かく（取る量を少なく）、遠い所は大きめ（問い合わせ回数を少なく）
const tileFor = (s, g) => hav(s[0], s[1], g[0], g[1]) <= 6000 ? 0.005 : 0.01;   // 約550m角 / 約1.1km角
const PARALLEL = 4;                // 同時に取るマスの数（サーバーを分けて並行で）
// 道路データはできるだけたくさん・長く（1年）とっておく
const DB_NAME = "hosomichi", STORE = "tiles", MAX_AGE = 365 * 864e5, MAX_TILES = 50000;
const mem = new Map();             // key -> elements
let dbp = null;
function openDB() {
  if (dbp) return dbp;
  dbp = new Promise(ok => {
    if (typeof indexedDB === "undefined") return ok(null);
    try {
      const r = indexedDB.open(DB_NAME, 4);
      r.onupgradeneeded = () => {
        const db = r.result;   // 古い形式（大きいマス）は捨てて作りなおす
        for (const n of [...db.objectStoreNames]) db.deleteObjectStore(n);
        db.createObjectStore(STORE, { keyPath: "key" });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(null);
    } catch { ok(null); }
  });
  return dbp;
}
const idbReq = r => req(r);   // route(req) の中では req が別のものになるので、こっちを使う
function req(r) { return new Promise((ok, ng) => { r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); }); }
async function store(mode) { const db = await openDB(); return db ? db.transaction(STORE, mode).objectStore(STORE) : null; }
async function pack(text) {
  // 長くたくさんとっておくので gzip でちぢめる（保存はルートを出したあとなので待たせない）
  if (typeof CompressionStream !== "undefined") {
    const s = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return { gz: true, blob: await new Response(s).blob() };
  }
  return { gz: false, blob: new Blob([text]) };
}
async function unpack(rec) {
  let s = rec.blob.stream();
  if (rec.gz) s = s.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(s).text());
}
async function getTile(key) {
  try {
    const st = await store("readonly"); if (!st) return null;
    const r = await req(st.get(key));
    if (!r) return null;
    const el = (await unpack(r)).elements;
    return { el, stale: Date.now() - r.savedAt > MAX_AGE, pv: r.pv || null };   // 古くても、取れなかったときの予備に使う
  } catch { return null; }
}
// 大きいマス(0.01°)と小さいマス(0.005°)は、どちらかがあれば代わりに使う（先取りは大きいマスでためる）
async function getTileAny(key) {
  const r = await getTile(key); if (r && !r.stale) return r;
  const [T, ij] = key.split(":"), [i, j] = ij.split(",").map(Number);
  if (T === "0.005") {
    const p = await getTile(`0.01:${Math.floor(i / 2)},${Math.floor(j / 2)}`);
    if (p && !p.stale) return p;
  } else if (T === "0.01") {
    const rs = await Promise.all([[0, 0], [0, 1], [1, 0], [1, 1]].map(([a, b]) => getTile(`0.005:${2 * i + a},${2 * j + b}`)));
    if (rs.every(x => x && !x.stale)) return { el: rs.flatMap(x => x.el), stale: false };
  }
  return r;
}
// ==== 配布データ（GitHub Pages に置いた道路データ。Overpass にアクセスしないですむ） ====
// 形式: <base>index.json（{v:日付, keys:["緯度番号_経度番号", ...]}）と <base>t/緯度番号_経度番号.json.gz（大きいマス 0.01°）
let packBase = null, packIdx = null, packV = 0, packAt = 0, packBytes = 0, packId = "", packEmpty = null, packAreas = [];
const bigOf = k => { const [T, ij] = k.split(":"), [i, j] = ij.split(",").map(Number); return T === "0.01" ? k : `0.01:${Math.floor(i / 2)},${Math.floor(j / 2)}`; };
const packName = big => big.split(":")[1].replace(",", "_");
async function packIndex() {
  if (!packBase) return null;
  if (packIdx && Date.now() - packAt < 6 * 3600e3) return packIdx;
  try {
    const res = await fetch(packBase + "index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    packIdx = new Set(j.keys); packV = Date.parse(j.v) || Date.now(); packBytes = j.bytes || 0;
    packId = j.built || `${j.v}:${j.bytes}`;   // 配布データの版。作りなおすと変わる
    packEmpty = j.empty ? new Set(j.empty) : null;   // 範囲の中だけど道がないマス（川・湖・田んぼなど）
    packAreas = Object.values(j.areas || {});
    log(`配布データ: ${packIdx.size}マス（${j.v} の地図・${(packBytes / 1048576).toFixed(0)}MB）`, "ok");
  } catch (e) { packIdx = packIdx || new Set(); log(`配布データの一覧が読めなかった（${e.message}）。サーバーから取るよ`, "w"); }
  packAt = Date.now();
  return packIdx;
}
// 配布データの範囲の中で、道がないので作っていないマス（ダウンロードしなくていい）
const packEmptyHas = big => {
  const n = packName(big);
  if (packEmpty) return packEmpty.has(n);
  const [i, j] = n.split("_").map(Number), la = (i + 0.5) * 0.01, lo = (j + 0.5) * 0.01;   // 古い index：範囲の四角の中ならそうみなす
  return packAreas.some(([S, W, N, E]) => la > S && la < N && lo > W && lo < E);
};
const packHas = async big => { const p = await packIndex(); return !!(p && p.has(packName(big))); };
async function packTile(big) {   // 大きいマスを配布データから取って、端末に保存する（ちぢめたまま保存）
  const res = await fetch(`${packBase}t/${packName(big)}.json.gz`);
  if (!res.ok) throw new Error("HTTP " + res.status);
  let blob = await res.blob(), text;
  const h = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (h[0] === 0x1f && h[1] === 0x8b) text = await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
  else { text = await blob.text(); blob = (await pack(text)).blob; }   // ブラウザが先にほどいていたとき
  const json = JSON.parse(text);
  const st = await store("readwrite");
  if (st) await req(st.put({ key: big, savedAt: packV, pv: packId, gz: true, blob, size: blob.size }));
  mem.set(big, json.elements);
  return { el: json.elements, bytes: blob.size };
}
// 配布データをまとめて入れる（パソコン向け）
let pkStop = false;
async function packAll(post) {
  const p = await packIndex(); if (!p || !p.size) return post({ fin: true, msg: "配布データが見つからなかったよ" });
  const { have } = await haveKeys(), list = [...p].map(n => "0.01:" + n.replace("_", ",")).filter(k => !have.has(k));
  let done = 0, bytes = 0, next = 0;
  log(`==== 配布データをまとめて入れる：${list.length}マス（もう持ってる ${p.size - list.length}マス）====`, "h");
  const run = async () => {
    while (next < list.length && !pkStop) {
      const k = list[next++];
      for (let tries = 0; tries < 3 && !pkStop; tries++) {
        try { const r = await packTile(k); bytes += r.bytes; done++; post({ tile: k }); break; }
        catch (e) { await sleep(2000 * (tries + 1)); }
      }
      post({ done, total: list.length, bytes });
    }
  };
  await Promise.all([run(), run(), run()]);
  log(`配布データ：${done}マス入れたよ（${(bytes / 1048576).toFixed(1)}MB）${pkStop ? "・とちゅうで止めた" : ""}`, "ok");
  post({ fin: true, done, total: list.length, bytes, stopped: pkStop });
}
// ==== 自動でためる：地図のまん中に近い、まだ持ってない大きいマス(約1km角)を、ゆっくり1つずつ取る ====
// ルート計算が始まったら、取ってる途中のものも止めてお休み。終わったらまた続ける
let pfStop = true, pfRun = false, routing = false, pfAc = null;
const PF_R = 20, PF_GAP = 5000;   // まん中から20kmまで・1マスごとに5秒休む
// いつも使っているあたり＝ためてあるマス（ルートを作った所）のまん中。中央値なので、たまに遠くへ行っても引っぱられない
async function homeCenter() {
  const st = await store("readonly"); if (!st) return null;
  const keys = await req(st.getAllKeys()); if (!keys.length) return null;
  const la = [], lo = [];
  for (const k of keys) { const [T, ij] = String(k).split(":"), t = +T, [i, j] = ij.split(",").map(Number); la.push((i + 0.5) * t); lo.push((j + 0.5) * t); }
  const med = a => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  return [+med(la).toFixed(4), +med(lo).toFixed(4)];
}
async function haveKeys() {   // 持っている大きいマス（小さいマス4つそろっていれば持ってるとみなす）と、1年より古いマス
  const st = await store("readonly"); if (!st) return { have: new Set(), touched: new Set(), old: [] };
  const now = Date.now(), recs = await req(st.getAll()), have = new Set(), small = new Map(), fresh = new Set(), oldRaw = [];
  for (const r of recs) {
    const [T, ij] = r.key.split(":"), [i, j] = ij.split(",").map(Number);
    const big = T === "0.01" ? r.key : `0.01:${Math.floor(i / 2)},${Math.floor(j / 2)}`;
    if (now - r.savedAt > MAX_AGE) oldRaw.push({ big, t: r.savedAt }); else if (T === "0.01") fresh.add(r.key);
    if (T === "0.01") have.add(r.key);
    else small.set(big, (small.get(big) || 0) + 1);
  }
  for (const [k, n] of small) if (n >= 4) have.add(k);
  // 古いマスは大きいマスごと取りなおす（いちばん古いものから）。もう新しい大きいマスがあればいらない
  const seen = new Set(), old = [];
  for (const o of oldRaw.sort((a, b) => a.t - b.t)) if (!fresh.has(o.big) && !seen.has(o.big)) { seen.add(o.big); old.push(o.big); }
  return { have, touched: new Set([...have, ...small.keys()]), old };
}
async function autoPrefetch(post0) {
  let curKey = null;
  const post = m => post0({ ...m, fetching: curKey });
  const T = 0.01, failed = new Map();
  let { have, touched, old } = await haveKeys(), reload = false, reloadAt = Date.now();
  let srv = 0, fail = 0, got = 0, bytes = 0, cand = [], candC = null, home = null, homeAt = 0;
  log(`==== 自動でためる：スタート（持ってる大きいマス ${have.size}個・1年より古くて取りなおすマス ${old.length}個）====`, "h");
  while (!pfStop) {
    if (routing) { reload = true; post({ msg: "ルート計算中なのでお休み中" }); await sleep(1000); continue; }
    if (reload) {   // ルートを作ったあとは、持っているマスを読みなおす（保存がおわるのを少し待つ）
      await sleep(3000); ({ have, touched, old } = await haveKeys()); reload = false; reloadAt = Date.now(); home = null;
    }
    // 「いつも使っているあたり」のまん中（20マスごとに計算しなおす）
    if (!home || got - homeAt >= 20) { home = await homeCenter(); homeAt = got; }
    if (!home) { post({ msg: "まだルートを作ってないので、お休み中（ルートを作ると、そのまわりからためるよ）" }); await sleep(10000); continue; }
    const c = home;
    if (!candC || candC[0] !== c[0] || candC[1] !== c[1]) {   // まん中から近い順
      candC = c; cand = [];
      const cl = Math.cos(c[0] * RAD), dl = PF_R / 111.32, dg = dl / cl;
      for (let i = Math.floor((c[0] - dl) / T); i <= Math.floor((c[0] + dl) / T); i++)
        for (let j = Math.floor((c[1] - dg) / T); j <= Math.floor((c[1] + dg) / T); j++) {
          const km = hav(c[0], c[1], (i + 0.5) * T, (j + 0.5) * T) / 1000;
          if (km <= PF_R) cand.push({ key: `${T}:${i},${j}`, i, j, km, bb: { s: i * T, w: j * T, n: (i + 1) * T, e: (j + 1) * T } });
        }
      cand.sort((a, b) => a.km - b.km);
    }
    // もう持っているマスのとなり（少しだけ持ってるマスもふくむ）だけを取る＝持ってる所から少しずつ外へ
    const nextTo = x => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (touched.has(`${T}:${x.i + a},${x.j + b}`)) return true; return false; };
    // 1年より古いマスの取りなおしが先（いちばん古いものから）。なければ持ってる所のとなりを広げる
    let t = null;
    while (old.length && !t) {
      const k = old[0], [i, j] = k.split(":")[1].split(",").map(Number);
      if (failed.get(k) > Date.now()) { old.push(old.shift()); if (old.every(x => failed.get(x) > Date.now())) break; continue; }
      t = { key: k, i, j, km: hav(c[0], c[1], (i + 0.5) * T, (j + 0.5) * T) / 1000, bb: { s: i * T, w: j * T, n: (i + 1) * T, e: (j + 1) * T }, refresh: true };
    }
    if (!t) t = cand.find(x => !have.has(x.key) && !(failed.get(x.key) > Date.now()) && nextTo(x));
    if (!t && Date.now() - reloadAt > 60000) { reload = true; continue; }   // 念のため読みなおしてから「ぜんぶたまった」にする
    if (!t) { post({ msg: `いつものあたりから${PF_R}kmまでぜんぶたまってるよ`, haveN: have.size }); await sleep(5000); continue; }
    const url = OVERPASS_URLS[srv % OVERPASS_URLS.length], host = new URL(url).host, t0 = Date.now();
    curKey = t.key;
    pfAc = new AbortController(); const ac = pfAc, to = setTimeout(() => { ac.timedOut = true; ac.abort(); }, 60000);
    post({ msg: t.refresh ? `${host} から古いマスを取りなおし中（のこり ${old.length}マス）` : `${host} から取得中（いつものあたりから${t.km.toFixed(1)}km）`, haveN: have.size });
    try {
      const fromPack = await packHas(t.key) && (!t.refresh || Date.now() - packV < MAX_AGE);
      let size;
      if (fromPack) size = (await packTile(t.key)).bytes;   // 配布データにあればそこから（Overpass を使わない）
      else {
        const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(overpassQuery(t.bb)), signal: ac.signal, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text(), json = JSON.parse(text);
        if (json.remark && /error|timed out|memory/i.test(json.remark)) throw new Error(json.remark.slice(0, 60));
        await putTile(t.key, text); size = text.length;
      }
      have.add(t.key); touched.add(t.key); got++; bytes += size; fail = 0; if (t.refresh) old.shift();
      log(`${t.refresh ? "自動で取りなおした" : "自動でためた"} ${t.key} ${fromPack ? "配布データ" : host} ${kb(size)}（${((Date.now() - t0) / 1000).toFixed(1)}秒・まん中から${t.km.toFixed(1)}km）`, "ok");
      post({ tile: t.key, got, bytes, haveN: have.size, pack: fromPack });
      for (let s = fromPack ? 500 : PF_GAP; s > 0 && !pfStop && !routing; s -= 500) await sleep(500);   // サーバーにやさしく
    } catch (e) {
      if (pfStop) break;
      if (routing && !ac.timedOut) { log(`自動でためる：ルート計算が始まったので中断 [${t.key}]`); continue; }
      fail++; srv++;
      if (fail >= OVERPASS_URLS.length) failed.set(t.key, Date.now() + 10 * 60000);   // このマスはしばらく後回し
      const w = fail >= OVERPASS_URLS.length ? 120 : 20;
      log(`自動でためる 失敗 ${host}: ${ac.timedOut ? "時間切れ" : e.message}。${w}秒お休み`, "w");
      for (let s = w; s > 0 && !pfStop; s--) { if (!routing) post({ msg: `サーバーが混んでるので ${s}秒お休み` }); await sleep(1000); }
    } finally { clearTimeout(to); pfAc = null; curKey = null; post({}); }
  }
  log(`自動でためる：止めました（新しく ${got}マス）`);
  post({ msg: "止めてるよ", fin: true });
  prune();
}
// ==== ためたデータを書き出す / 読みこむ（ほかの端末や人にわたせる） ====
// 形式: "HOSOMICHI1\n" + 見出しの長さ(10けた)+"\n" + 見出しJSON + 各マスのデータを順番に
async function exportTiles() {
  const st = await store("readonly"); if (!st) throw new Error("保存データが使えません");
  const recs = await req(st.getAll());
  const head = new TextEncoder().encode(JSON.stringify(recs.map(r => ({ k: r.key, t: r.savedAt, z: r.gz, n: r.blob.size }))));
  return { blob: new Blob(["HOSOMICHI1\n", String(head.length).padStart(10, "0") + "\n", head, ...recs.map(r => r.blob)], { type: "application/octet-stream" }), n: recs.length };
}
async function importTiles(file) {
  const top = await file.slice(0, 22).text();
  if (!top.startsWith("HOSOMICHI1\n")) throw new Error("細道ルートナビの道路データのファイルではないみたい");
  const hl = parseInt(top.slice(11, 21)), head = JSON.parse(await file.slice(22, 22 + hl).text());
  let pos = 22 + hl, added = 0, same = 0;
  for (const h of head) {
    const blob = file.slice(pos, pos + h.n); pos += h.n;
    const st = await store("readonly"), old = st ? await req(st.get(h.k)) : null;
    if (old && old.savedAt >= h.t) { same++; continue; }   // 自分のほうが新しいならそのまま
    const w = await store("readwrite"); if (!w) break;
    await req(w.put({ key: h.k, savedAt: h.t, gz: h.z, blob, size: h.n })); mem.delete(h.k); added++;
  }
  log(`道路データを読みこんだ: 新しく ${added}マス・もう持ってた ${same}マス`, "ok");
  return { added, same, n: head.length };
}
async function putTile(key, text) {
  try {
    const { gz, blob } = await pack(text);
    const st = await store("readwrite"); if (!st) return;
    await req(st.put({ key, savedAt: Date.now(), gz, blob, size: blob.size }));
  } catch (e) { console.warn("保存できませんでした", e); }
}
async function prune() {
  try {
    const st = await store("readonly"); if (!st) return;
    const recs = (await req(st.getAll())).sort((a, b) => b.savedAt - a.savedAt);
    const now = Date.now(), del = recs.filter((r, i) => i >= MAX_TILES || now - r.savedAt > MAX_AGE * 3);
    if (del.length) { const w = await store("readwrite"); for (const r of del) await req(w.delete(r.key)); }
  } catch {}
}
async function stats() {
  const st = await store("readonly"); if (!st) return { n: 0, bytes: 0, keys: [] };
  const recs = await req(st.getAll());
  return { n: recs.length, bytes: recs.reduce((a, r) => a + (r.size || 0), 0), keys: recs.map(r => r.key) };   // keys＝地図に色をぬる用
}
async function clearAll() { const st = await store("readwrite"); if (st) await req(st.clear()); mem.clear(); }

// 出発→到着の線のまわり（帯）にかかるマスだけ選ぶ
function tilesFor(s, g, pad, TILE = tileFor(s, g)) {
  const c = Math.cos(s[0] * RAD);
  const P = q => [q[1] * c, q[0]];
  const [ax, ay] = P(s), [bx, by] = P(g), dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
  // マス（長方形）と線のきょり：線がマスを通る→0、それ以外は角と端点で近い方
  const segPt = (x, y) => { let t = ((x - ax) * dx + (y - ay) * dy) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(x - ax - t * dx, y - ay - t * dy); };
  const rectDist = (x0, y0, x1, y1) => {
    const inR = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    if (inR(ax, ay) || inR(bx, by)) return 0;
    const cr = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const hit = (x2, y2, x3, y3) => cr(ax, ay, bx, by, x2, y2) * cr(ax, ay, bx, by, x3, y3) <= 0 && cr(x2, y2, x3, y3, ax, ay) * cr(x2, y2, x3, y3, bx, by) <= 0;
    if (hit(x0, y0, x1, y0) || hit(x1, y0, x1, y1) || hit(x1, y1, x0, y1) || hit(x0, y1, x0, y0)) return 0;
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    return Math.min(segPt(x0, y0), segPt(x1, y0), segPt(x0, y1), segPt(x1, y1),
      Math.hypot(ax - cl(ax, x0, x1), ay - cl(ay, y0, y1)), Math.hypot(bx - cl(bx, x0, x1), by - cl(by, y0, y1)));
  };
  const out = [];
  for (let i = Math.floor((Math.min(s[0], g[0]) - pad) / TILE); i <= Math.floor((Math.max(s[0], g[0]) + pad) / TILE); i++)
    for (let j = Math.floor((Math.min(s[1], g[1]) - pad) / TILE); j <= Math.floor((Math.max(s[1], g[1]) + pad) / TILE); j++) {
      if (rectDist(j * TILE * c, i * TILE, (j + 1) * TILE * c, (i + 1) * TILE) <= pad) out.push({ key: TILE + ":" + i + "," + j, bb: { s: i * TILE, w: j * TILE, n: (i + 1) * TILE, e: (j + 1) * TILE } });
    }
  return out;
}

// 回り道の余地（度）。せまいほど早いけど、遠回りが必要な場所でルートが見つからないことも
function padFor(s, g, area) {
  const d = Math.abs(s[0] - g[0]) + Math.abs(s[1] - g[1]);
  if (area === "narrow") return 0.002;                                  // 約200m
  if (area === "wide") return Math.min(0.04, Math.max(0.018, d * 0.15)); // 2km〜4.4km（データが手元にあることが多いので広めに）
  return Math.min(0.01, Math.max(0.004, d * 0.05));                     // 400m〜1km
}
const pendingSaves = [];
async function flushSaves() {
  const list = pendingSaves.splice(0);
  if (!list.length) return;
  const t0 = Date.now();
  await Promise.all(list.map(([k, t]) => putTile(k, t)));
  log(`端末に保存: ${list.length}マス（${kb(list.reduce((a, x) => a + x[1].length, 0))} をちぢめて保存・${Date.now() - t0}ms）`, "ok");
  prune();
}

// ==== スタートから順番に確定していくルート計算 ====
// マスを「スタートからの進み具合」の順に取得して、取れたところまでで途中のルートを決める。
// 先っぽ（まだ変わるかもしれない所）は点線＝仮のルートとして出す。
const FIRST_BAND = 700, BAND = 1500, TENTATIVE = 500, BACK = 600;
// ==== 駅の一覧（配布データの stations.json）：駅の中の通路を見分ける ====
let stationGrid = null;
async function loadStations() {
  if (stationGrid || !packBase) return;
  try {
    const res = await fetch(packBase + "stations.json"); if (!res.ok) return;
    const g = new Map();
    for (const [, la, lo] of await res.json()) { const k = Math.floor(lo / 0.002) + "," + Math.floor(la / 0.002); if (!g.has(k)) g.set(k, []); g.get(k).push([la, lo]); }
    stationGrid = g; log(`駅の一覧: ${g.size}か所のまわりを「駅の通路」として見るよ`);
  } catch {}
}
// ==== 霊園・墓地／公園のはんい（配布データの areas.json）====
let areaGrids = null, areaTried = false;   // { cemetery: Map, park: Map }
const BIG_HW = new Set(["tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link", "trunk", "trunk_link"]);
async function loadAreas() {
  if (areaGrids || areaTried || !packBase) return;
  areaTried = true;
  try {
    const res = await fetch(packBase + "areas.json"); if (!res.ok) { areaTried = false; return; }
    const j = await res.json(), out = {}, cnt = [];
    for (const kind of ["cemetery", "park"]) {
      const g = new Map(); let n = 0;
      for (const pts of j[kind] || []) {
        let s = 90, w = 180, nn = -90, e = -180;
        for (const [a, b] of pts) { s = Math.min(s, a); nn = Math.max(nn, a); w = Math.min(w, b); e = Math.max(e, b); }
        const P = { pts, s, w, n: nn, e }; n++;
        for (let i = Math.floor(s * 100); i <= Math.floor(nn * 100); i++) for (let k = Math.floor(w * 100); k <= Math.floor(e * 100); k++) {
          const key = i + "," + k; if (!g.has(key)) g.set(key, []); g.get(key).push(P);
        }
      }
      if (n) out[kind] = g;
      cnt.push(`${kind === "park" ? "公園" : "霊園・墓地"} ${n}か所`);
    }
    areaGrids = out; log(`はんいのデータ: ${cnt.join("・")}`);
  } catch { areaTried = false; }
}
function areaHas(kind, la, lo) {
  const g = areaGrids && areaGrids[kind]; if (!g) return false;
  for (const P of g.get(Math.floor(la * 100) + "," + Math.floor(lo * 100)) || []) {
    if (la < P.s || la > P.n || lo < P.w || lo > P.e) continue;
    let inside = false; const p = P.pts;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++)
      if ((p[i][0] > la) !== (p[j][0] > la) && lo < (p[j][1] - p[i][1]) * (la - p[i][0]) / (p[j][0] - p[i][0]) + p[i][1]) inside = !inside;
    if (inside) return true;
  }
  return false;
}
// ==== 坂道：国土地理院の標高タイル（dem_png・ズーム14・10mメッシュ）で、のぼりをきらう ====
const DEMZ = 14, demCache = new Map();
async function demTile(x, y) {
  const k = x + "/" + y;
  if (demCache.has(k)) return demCache.get(k);
  let h = null;
  try {
    const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/${DEMZ}/${x}/${y}.png`);
    if (res.ok) {
      const bmp = await createImageBitmap(await res.blob()), cv = new OffscreenCanvas(256, 256), cx = cv.getContext("2d");
      cx.drawImage(bmp, 0, 0); const d = cx.getImageData(0, 0, 256, 256).data; h = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) {
        const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2], v = R * 65536 + G * 256 + B;
        h[i] = (R === 128 && G === 0 && B === 0) ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;   // 128,0,0 は「データなし」
      }
    }
  } catch {}
  demCache.set(k, h);
  if (demCache.size > 3000) demCache.delete(demCache.keys().next().value);
  return h;
}
const demXY = (la, lo) => { const n = 2 ** DEMZ * 256, r = la * RAD;
  return [(lo + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n]; };
async function loadDem(s, g, pad) {   // ルートの帯ぶんの標高タイルを読んでおく
  const la0 = Math.min(s[0], g[0]) - pad, la1 = Math.max(s[0], g[0]) + pad, lo0 = Math.min(s[1], g[1]) - pad * 1.25, lo1 = Math.max(s[1], g[1]) + pad * 1.25;
  const [x0, y0] = demXY(la1, lo0).map(v => Math.floor(v / 256)), [x1, y1] = demXY(la0, lo1).map(v => Math.floor(v / 256));
  const list = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (!demCache.has(x + "/" + y)) list.push([x, y]);
  if (list.length > 1500) { log(`坂道：範囲が広すぎるので、坂は見ないよ（標高タイル ${list.length}枚）`, "w"); return false; }
  const t0 = Date.now(); let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (i < list.length) { const [x, y] = list[i++]; await demTile(x, y); } }));
  if (list.length) log(`坂道：標高タイル ${list.length}枚（${((Date.now() - t0) / 1000).toFixed(1)}秒）`);
  return true;
}
function heightAt(la, lo) {
  const [px, py] = demXY(la, lo), x = Math.floor(px / 256), y = Math.floor(py / 256), h = demCache.get(x + "/" + y);
  if (!h) return NaN;
  return h[Math.min(255, Math.floor(py - y * 256)) * 256 + Math.min(255, Math.floor(px - x * 256))];
}
// のぼり 1m を k m 分と数える。8% をこえる急な所はその2倍。標高のゆれ（橋・切り通し）に強くするため 15% で頭打ち
function applySlope(G, k) {
  if (!k || typeof OffscreenCanvas === "undefined") return G;
  const n = G.lat.length, h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = G.inGraph[i] ? heightAt(G.lat[i], G.lon[i]) : NaN;
  let up = 0;
  for (let u = 0; u < n; u++) for (const e of G.adj[u]) {
    let dh = h[e.v] - h[u];
    if (!(dh > 0) || e.L < 3) continue;
    dh = Math.min(dh, e.L * 0.15);
    e.c += dh * k * (dh / e.L > 0.08 ? 2 : 1); up++;
  }
  return G;
}
// 道がつながらないとき（大きい川の橋が範囲の外にある、など）：データが手元にあれば範囲を広げてやりなおす
const PAD_STEPS = [0.05, 0.1];   // 約5.5km → 約11km
async function route(req, prog, partial) {
  let pad = null;
  for (let k = 0; ; k++) {
    try { return await routeOnce({ ...req, pad }, prog, partial); }
    catch (e) {
      if (!e.noLink || k >= PAD_STEPS.length || e.usedPad >= PAD_STEPS[k]) throw e;
      const tiles = tilesFor(req.s, req.g, PAD_STEPS[k]);
      if (!(await allLocalTiles(tiles))) throw e;   // ダウンロードが必要なら広げない（サーバーにやさしく）
      pad = PAD_STEPS[k];
      log(`道がつながらなかったので、まわり ${Math.round(pad * 111)}km まで広げてやりなおすよ（大きい川の橋などをさがす）`, "w");
    }
  }
}
async function allLocalTiles(ts) {   // そのマスがぜんぶ手元（端末か配布データ）にあるか
  try {
    const p = await packIndex(), st = await store("readonly"), have = new Set(st ? (await idbReq(st.getAllKeys())).map(String) : []);
    return ts.every(t => have.has(t.key) || have.has(bigOf(t.key)) || (p && (p.has(packName(bigOf(t.key))) || packEmptyHas(bigOf(t.key)))));
  } catch { return false; }
}
async function routeOnce(req, prog, partial) {
  const { s, g, cfg } = req;
  const T0 = Date.now();
  // 「おまかせ」：ひろい範囲の道路データがぜんぶ手元（端末か配布データ）にあれば ひろい、なければ ダウンロードが少ない せまい
  let area = cfg && cfg.area;
  let missN = 0;
  const allLocal = async ts => {   // そのマスがぜんぶ手元（端末か配布データ）にあるか
    try {
      const p = await packIndex(), st = await store("readonly"), have = new Set(st ? (await idbReq(st.getAllKeys())).map(String) : []);
      const miss = ts.filter(t => !(have.has(t.key) || have.has(bigOf(t.key)) || (p && (p.has(packName(bigOf(t.key))) || packEmptyHas(bigOf(t.key))))));
      missN = miss.length;
      if (miss.length) log(`手元にないマス: ${miss.length}/${ts.length}（${miss.slice(0, 5).map(t => t.key).join(" ")}${miss.length > 5 ? " …" : ""}）`);
      return !miss.length;
    } catch (e) { log("手元のデータをたしかめられなかった: " + e.message, "w"); return false; }
  };
  if (area === "auto") {
    const ok = await allLocal(tilesFor(s, g, padFor(s, g, "wide")));
    area = ok ? "wide" : "narrow";
    log(`地図データを取る広さ: おまかせ → ${ok ? "ひろい（データがぜんぶ手元にある）" : "せまい（ダウンロードが必要なので）"}`);
  }
  const pad = req.pad || padFor(s, g, area);
  const slopeK = +(cfg && cfg.slope) || 0;
  if (cfg && cfg.station !== 1) await loadStations();
  if (cfg && (cfg.cemetery !== 1 || cfg.park !== 1)) await loadAreas();
  const demP = slopeK ? loadDem(s, g, pad + 0.005).catch(() => false) : Promise.resolve(false);
  const noLink = msg => Object.assign(new Error(msg), { noLink: true, usedPad: pad });
  // 長さの上限：道路データがぜんぶ手元にあれば 150km、ダウンロードが必要なら 30km（サーバーにやさしく・待たせすぎない）
  { const km = hav(s[0], s[1], g[0], g[1]) / 1000;
    if (km > 30 && !(await allLocal(tilesFor(s, g, pad))))
      throw new Error(`出発と到着が ${km.toFixed(1)}km はなれてるよ。道路データのダウンロードが必要な所（${missN}マス）があるので、30km以内にしてね（配布データのある関東の中なら150kmまでOK）`); }
  const tiles = tilesFor(s, g, pad), N = tiles.length;
  log(`==== ルート計算スタート ====`, "h");
  log(`出発 ${s[0].toFixed(5)},${s[1].toFixed(5)} → 到着 ${g[0].toFixed(5)},${g[1].toFixed(5)}（まっすぐ ${(hav(s[0], s[1], g[0], g[1]) / 1000).toFixed(2)}km）`);
  log(`設定: 計算=${cfg?.mode || "quick"} 広さ=${area || "normal"}（余白 ${Math.round(pad * 111000)}m） 曲がる=${cfg?.turn ?? 0} 階段=${cfg?.steps} 4車線=${cfg?.wideCross} 県道国道=${cfg?.bigCross} 2車線=${cfg?.midCross} 一方通行逆向き=${cfg?.oneway}`);
  log(`道の倍率: ${Object.entries(cfg?.pen || {}).map(([k, v]) => k + "=" + v).join(" ")}`);
  log(`マス: ${N}個（1マス ${tiles[0] ? tiles[0].key.split(":")[0] : "?"}°）`);
  // スタート→ゴールの線にそった進み具合（m）
  const c0 = Math.cos(s[0] * RAD), ux = (g[1] - s[1]) * c0 * 111320, uy = (g[0] - s[0]) * 111320, D = Math.hypot(ux, uy) || 1;
  const along = (la, lo) => (((lo - s[1]) * c0 * 111320) * ux + ((la - s[0]) * 111320) * uy) / D;
  for (const t of tiles) t.tc = Math.max(0, along((t.bb.s + t.bb.n) / 2, (t.bb.w + t.bb.e) / 2));
  tiles.sort((a, b) => a.tc - b.tc);
  const tileHalf = hav(tiles[0].bb.s, tiles[0].bb.w, tiles[0].bb.n, tiles[0].bb.e) / 2;

  // --- 取得：保存データ → 足りないマスをスタート側から順にダウンロード ---
  const got = new Map(), waiters = new Map();
  const ready = key => got.has(key) ? Promise.resolve() : new Promise(r => {
    if (!waiters.has(key)) waiters.set(key, []);
    const w = () => { stopWaiters.delete(w); r(); };
    waiters.get(key).push(w); stopWaiters.add(w);
  });
  let lastTileAt = Date.now();
  const setTile = (key, el) => { lastTileAt = Date.now(); got.set(key, el); mem.set(key, el); (waiters.get(key) || []).forEach(r => r()); waiters.delete(key); };
  prog({ stage: 1, msg: `保存したデータをさがし中（${N}マス）`, done: 0, total: N, area: tiles.map(t => t.key) });   // 計算する範囲（地図に枠を出す）
  const stale = new Map(); let oldPack = 0;
  await packIndex();
  await Promise.all(tiles.map(async t => {
    if (mem.has(t.key)) return setTile(t.key, mem.get(t.key));
    const r = await getTileAny(t.key);
    // 配布データが新しくなっていたら、そのマスは配布データから取りなおす（すぐ取れる）
    if (r && packIdx && packIdx.has(packName(bigOf(t.key))) && r.pv !== packId) { oldPack++; return; }
    if (r) { setTile(t.key, r.el); if (r.stale) stale.set(t.key, 1); }   // 1年より古くても待たずに使う（取りなおしは「自動でためる」がゆっくりやる）
  }));
  // 配布データにあるマスは、そこから取る（Overpass にアクセスしない）
  if (await packIndex() && packIdx.size) {
    const want = new Map(); let empty = 0;
    for (const t of tiles) if (!got.has(t.key) || (stale.has(t.key) && Date.now() - packV < MAX_AGE)) {
      const b = bigOf(t.key);
      if (packIdx.has(packName(b))) { if (!want.has(b)) want.set(b, []); want.get(b).push(t.key); }
      else if (!got.has(t.key) && packEmptyHas(b)) { setTile(t.key, []); empty++; }   // 道がないマス：取らなくていい
    }
    if (empty) log(`道がないマス（川・湖など）: ${empty}マス`);
    if (want.size) {
      const bigs = [...want.keys()], tp = Date.now(); let n = 0, nb = 0, bad = 0;
      const run = async () => { while (bigs.length) { const b = bigs.shift();
        try { const r = await packTile(b); nb += r.bytes; for (const k of want.get(b)) { setTile(k, r.el); stale.delete(k); } }
        catch (e) { bad++; }
        n++; prog({ stage: 1, msg: `配布データから取得 ${n}/${want.size}マス`, done: n, total: want.size }); } };
      await Promise.all([run(), run(), run(), run(), run(), run()]);
      log(`配布データから取得: ${want.size - bad}マス（${kb(nb)}・${((Date.now() - tp) / 1000).toFixed(1)}秒）${bad ? `・取れなかった ${bad}マス` : ""}`, bad ? "w" : "ok");
    }
  }
  const demOK = await demP;   // 坂道のデータ（あとで道に坂の重みをつける）
  const BG = (osm, c, p) => { const G0 = buildGraph(osm, c, p); return demOK ? applySlope(G0, slopeK) : G0; };
  const saved = got.size - stale.size, need = tiles.filter(t => !got.has(t.key));
  if (oldPack) log(`配布データが新しくなったので、${oldPack}マスを配布データから取りなおすよ`);
  log(`端末の保存データ: 使える ${saved}マス / 1年より古いけど使う ${stale.size}マス / ダウンロードが必要 ${need.length}マス（同時 ${Math.min(PARALLEL, need.length)}本）`, saved === N ? "ok" : "i");
  let done = 0, bytes = 0, fetchErr = null, stage = 1, stageMsg = "";
  const active = new Map(), tf0 = Date.now(), fetchingKeys = new Set();   // fetchingKeys＝いま取っているマス（地図で光らせる）
  const report = () => {
    const el = (Date.now() - tf0) / 1000;
    let eta = "";
    if (done > 0 && done < need.length) {
      const sec = el / done * (need.length - done);
      eta = sec > 90 ? `あと約${Math.ceil(sec / 60)}分` : `あと約${Math.ceil(sec / 10) * 10}秒`;
    }
    const cur = [...active.values()].join(" / ");
    prog({ stage, msg: (stageMsg ? stageMsg + "\n" : "") + `道路データ ${saved + done}/${N}マス` + (saved ? `（保存済み ${saved}）` : "") + (eta ? `  ${eta}` : "") + (cur ? `\n${cur}` : ""),
      done: saved + done, total: N, bytes, fetching: [...fetchingKeys] });
  };
  const timer = setInterval(report, 1000);
  let next = 0;
  const runner = async w => {
    while (next < need.length && !fetchErr && !stopReq) {
      const t = need[next++];
      active.set(w, "取得中…"); fetchingKeys.add(t.key); report();
      try {
        const r = await fetchOSM(t.bb, p => { active.set(w, p.msg); }, w, stale.has(t.key), `${t.key.split(":")[1]} 進み${Math.round(t.tc)}m`);
        bytes += r.text.length; pendingSaves.push([t.key, r.text]);
        done++; active.delete(w); fetchingKeys.delete(t.key); setTile(t.key, r.json.elements); report();
      } catch (e) {
        if (!e.stopped && stale.has(t.key)) {   // 取れなかったけど、1年より前のデータがあるならそれを使う
          log(`取れなかったので古いデータを使う [${t.key}]`, "w");
          setTile(t.key, stale.get(t.key)); done++; active.delete(w); report(); continue;
        }
        fetchingKeys.delete(t.key);
        if (!e.stopped) fetchErr = e; active.delete(w); [...waiters.values()].flat().forEach(r => r()); if (e.stopped) return; }
    }
  };
  const fetching = Promise.all(Array.from({ length: Math.min(PARALLEL, need.length) }, (_, w) => runner(w)));
  // 「ぜんぶ計算してから」でも、待っているあいだは取れた所までの仮のルートを出す（4秒に1回・新しいマスが来たときだけ）
  let pvAt = 0, pvN = -1;
  const preview = () => {
    if (got.size === pvN || Date.now() - pvAt < 4000) return;
    pvAt = Date.now(); pvN = got.size;
    try {
      let tEdge = -1;   // スタートからすきまなくそろっている所まで
      for (const t of tiles) { if (!got.has(t.key)) break; tEdge = t.tc; }
      if (tEdge < 300) return;
      const seen = new Set(), elements = [];
      for (const t of tiles) if (t.tc <= tEdge && got.has(t.key))
        for (const e of got.get(t.key)) { const k = e.type[0] + e.id; if (!seen.has(k)) { seen.add(k); elements.push(e); } }
      const G = BG({ elements }, cfg), q = nearestGood(G, s[0], s[1]);
      if (q.n < 0 || q.d > 400) return;
      const r = search(G, q.n, -1, g, false);
      let bestSt = -1, bestF = Infinity;
      for (let st = 0; st < r.closed.length; st++) {
        if (!r.closed[st]) continue;
        const u = (st / 3) | 0;
        if (along(G.lat[u], G.lon[u]) < tEdge - tileHalf - 400) continue;
        const f = r.best[st] + r.H(u);
        if (f < bestF) { bestF = f; bestSt = st; }
      }
      if (bestSt < 0) return;
      const pts = pathTo(r.prev, bestSt).map(u => [+G.lat[u].toFixed(6), +G.lon[u].toFixed(6)]);
      log(`仮のルート（取れた所まで）: ${pts.length}点・スタートから約${(tEdge / 1000).toFixed(1)}km`);
      prog({ preview: pts });
    } catch (e) { log("仮のルートを出せなかった: " + e.message, "w"); }
  };
  // tEnd までのマスを待つ。soft=true なら、8割以上そろって25秒新しいマスが来ないときは「そろってないまま」返す
  const SOFT_WAIT = 25000;
  const waitUpTo = async (tEnd, soft) => {
    const list = tiles.filter(t => t.tc <= tEnd);
    for (;;) {
      checkStop(); if (fetchErr) throw fetchErr;
      const miss = list.filter(t => !got.has(t.key));
      if (!miss.length) return true;
      if (tEnd === Infinity && cfg && cfg.mode === "full") preview();
      if (soft && (list.length - miss.length) / list.length >= 0.8 && Date.now() - lastTileAt > SOFT_WAIT) {
        log(`${miss.length}マスがなかなか来ないので、手元の ${list.length - miss.length}マスで先に計算してみる`, "w");
        return false;
      }
      await sleep(300);
    }
  };

  // --- 順番に確定 ---
  const conf = [], kinds = {}, ok = [], xw = [], ng = [], ek = [];
  let turns = 0, confLen = 0, confEnd = null /* OSMの点id */, tConf = 0, tBuild = 0, tSearch = 0, nNodes = 0;
  // mode "full"：ぜんぶ取ってから一度に計算（いちばん良いルート）／ それ以外：スタートから順番に確定（すぐ走り出せる）
  let bandEnd = cfg && cfg.mode === "full" ? D : Math.min(D, FIRST_BAND), lastGraph = null;
  const addKinds = k => { for (const [n, m] of Object.entries(k)) kinds[n] = (kinds[n] || 0) + m; };
  try {
    for (;;) {
      const final = bandEnd >= D;
      await sleep(0); checkStop();   // 「止める」を受けとれるように
      log(final ? `--- 最後の区間（ゴールまで）を待っています ---` : `--- 区間: スタートから ${(bandEnd / 1000).toFixed(1)}km 先まで（確定ずみ ${(confLen / 1000).toFixed(2)}km） ---`, "h");
      stageMsg = final ? "ゴールまでのルートを計算中" : `スタートから ${(bandEnd / 1000).toFixed(1)}km 先まで計算中`;
      report();
      const complete = await waitUpTo(final ? Infinity : bandEnd + tileHalf, true);
      stage = 2; report();
      // 確定したところの少し手前から先だけで道のつながりを作る（スマホでも軽く）。
      // 信号のない横断などルール外になったら、取ってある範囲ぜんぶでやりなおす
      let path, r, G, sn, gn = -1, wide = false;
      for (;;) {
        const lo = wide ? -Infinity : Math.max(0, tConf - BACK), seen = new Set(), elements = [];
        for (const t of tiles) if (t.tc >= lo - tileHalf && (final || t.tc <= bandEnd + tileHalf) && got.has(t.key))
          for (const e of got.get(t.key)) { const k = e.type[0] + e.id; if (!seen.has(k)) { seen.add(k); elements.push(e); } }
        const tb = Date.now();
        G = BG({ elements }, cfg);
        tBuild += (Date.now() - tb) / 1000; nNodes = Math.max(nNodes, G.nNodes);
        { let ne = 0; for (const a of G.adj) ne += a.length;
          log(`道のつながり: データ ${elements.length}件 → 点 ${G.nNodes}個・道のつなぎ ${ne}本（${Date.now() - tb}ms）${G.swLen ? `・歩道のある道 ${(G.swLen / 1000).toFixed(1)}km` : ""}${G.nBlk ? `・🚫⚠印で変えた所 ${G.nBlk}か所` : ""}${wide ? "【範囲を広げてやりなおし】" : ""}`); }
        sn = confEnd != null ? G.idx.get(confEnd) : undefined;
        if (sn === undefined) {
          const q = nearestGood(G, s[0], s[1]);
          log(`出発の点: ${Math.round(q.d)}m先の道（つながり ${q.size}点）` + (q.n !== q.nearestAny ? `｜いちばん近い点 ${Math.round(q.dAny)}m はつながり ${q.anySize}点しかないので使わない` : ""));
          if (q.n < 0 || q.d > 400) throw new Error("出発地のそばに、ほかとつながっている道が見つかりませんでした");
          sn = q.n;
        }
        stage = 3; report();
        const ts = Date.now();
        if (final) {
          // 出発とおなじ「つながりのかたまり」にある点だけをゴールにする（駅の中の通路などをさける）
          const q = nearestGood(G, g[0], g[1], sn);
          log(`到着の点: ${Math.round(q.d)}m先の道（出発とつながっている）` + (q.n !== q.nearestAny ? `｜いちばん近い点 ${Math.round(q.dAny)}m は出発とつながってないので使わない（つながり ${q.anySize}点）` : ""), q.d > 300 ? "w" : "i");
          if (q.n < 0 || q.d > 600) {
            if (!wide && lo > 0) { log("到着地のそばにつながる道がないので、範囲を広げて探しなおし", "w"); wide = true; continue; }
            throw noLink("到着地まで道がつながりませんでした。⚙ 設定の「地図データを取る広さ」を「ひろい」にするか、設定で「通らない」にしている道（階段・歩道橋など）をゆるめてみてね");
          }
          gn = q.n;
        }
        r = search(G, sn, gn, g, false);
        log(`探索: 調べた点 ${r.pops}個（${Date.now() - ts}ms）${final ? (r.goal >= 0 ? " ゴールに到着" : " ゴールに届かない") : ""}`, final && r.goal < 0 ? "w" : "i");
        path = null;
        if (final) {
          if (r.goal >= 0) path = pathTo(r.prev, r.goal);
        } else {
          // 先っぽ（まだ取ってない所との境目あたり）で、ゴールにいちばん近づけそうな点をえらぶ
          let bestSt = -1, bestF = Infinity;
          const edge0 = bandEnd - 400;
          for (let st = 0; st < r.closed.length; st++) {
            if (!r.closed[st]) continue;
            const u = (st / 3) | 0;
            if (along(G.lat[u], G.lon[u]) < edge0) continue;
            const f = r.best[st] + r.H(u);
            if (f < bestF) { bestF = f; bestSt = st; }
          }
          if (bestSt >= 0) path = pathTo(r.prev, bestSt);
        }
        tSearch += (Date.now() - ts) / 1000;
        const bad = !path || analyze(G, path).ng.length > 0;
        if (bad && !wide && lo > 0) { log(path ? "ルール外の横断があるので、取ってある範囲ぜんぶで探しなおし" : "先に進める道がないので、範囲を広げて探しなおし", "w"); wide = true; continue; }
        break;
      }
      if (!path && !complete) {   // そろってないデータでは見つからなかった：全部そろうまで待ってやりなおし
        log("手元のデータではつながらなかったので、残りのマスを待ってやりなおし", "w");
        await waitUpTo(final ? Infinity : bandEnd + tileHalf, false); continue;
      }
      if (!path) {
        if (final) throw noLink("ルートが見つかりませんでした" + (area !== "wide" ? "。⚙ 設定の「地図データを取る広さ」を広くするとつながるかも" : "（設定で通れない道が多すぎるかも）"));
        log("この範囲では先に進めないので、もっと先のデータを待つ", "w");
        bandEnd = Math.min(D, bandEnd + BAND); continue;   // 先に進める道がない：もっと先まで取ってから
      }
      // どこまで確定するか（最後は全部、それ以外は先っぽ TENTATIVE m を仮のまま残す）
      let k = path.length - 1;
      if (!final) {
        const lim = bandEnd - TENTATIVE;
        k = 0; for (let i = 0; i < path.length; i++) if (along(G.lat[path[i]], G.lon[path[i]]) <= lim) k = i; else if (i > 0 && along(G.lat[path[i]], G.lon[path[i]]) > lim + 300) break;
        // ルール外の横断がある所は、先のデータで信号が見つかるかもしれないので確定しない（少し手前まで）
        const bi = analyze(G, path).ngIdx[0];
        if (bi !== undefined && k >= bi - 1) {
          let j = bi - 1, back = 0;
          while (j > 0 && back < 150) { back += hav(G.lat[path[j]], G.lon[path[j]], G.lat[path[j - 1]], G.lon[path[j - 1]]); j--; }
          k = Math.max(0, j);
        }
      }
      const confPart = path.slice(0, k + 1), tent = path.slice(k);
      if (confPart.length > 1) {
        const a = analyze(G, confPart);
        addKinds(a.kinds); ok.push(...a.ok); xw.push(...a.xw); ng.push(...a.ng); ek.push(...a.ek); turns += a.turns; confLen += a.len;
        const pts = confPart.map(i => [G.lat[i], G.lon[i]]);
        conf.push(...(conf.length ? pts.slice(1) : pts));
        confEnd = G.ids[confPart[confPart.length - 1]];
        tConf = along(G.lat[confPart[confPart.length - 1]], G.lon[confPart[confPart.length - 1]]);
        log(`確定: +${(a.len / 1000).toFixed(2)}km（合計 ${(confLen / 1000).toFixed(2)}km）曲がる ${a.turns}回・信号 ${a.ok.length}・横断歩道 ${a.xw.length}・ルール外 ${a.ng.length}`, a.ng.length ? "w" : "ok");
      } else if (!final) log("今回は確定できる所がなかった（先のデータ待ち）");
      lastGraph = { G, sn: G.idx.get(G.ids[path[0]]) };
      if (final) break;
      const tentPts = tent.map(i => [G.lat[i], G.lon[i]]);
      partial({ route: conf.slice(), ek: ek.slice(), tent: tentPts, ok: ok.slice(), xw: xw.slice(), ng: ng.slice(), kinds: { ...kinds }, turns, len: confLen,
        progress: Math.min(1, tConf / D), restAir: hav(tentPts[tentPts.length - 1][0], tentPts[tentPts.length - 1][1], g[0], g[1]) });
      bandEnd = Math.min(D, bandEnd + BAND);
    }
  } finally {
    clearInterval(timer); fetchErr = fetchErr || new Error("stop");
    cancelFetch = true; for (const ac of aborts) ac.abort();   // もういらない取得はやめる
  }
  await fetching.catch(() => {});
  cancelFetch = false;
  { const miss = tiles.filter(t => !got.has(t.key)).length; if (miss) log(`取れなかったマス ${miss}個（なくてもルートはできたよ）`, "w"); }
  // 第2・第3のルート：グーグルみたいに「ちがう道すじ」を出したいので、
  //  ① まん中あたりを左右にずらした地点を通るルート（道すじがちがう）
  //  ② 使った道を通りにくくしてさがしなおしたルート（近くの別の道）
  // を作って、メインと半分以上かぶらないものを2本までえらぶ。データが手元にあれば少し広い範囲で考える
  let alts = [];
  if (!need.length && conf.length > 1 && !(cfg && cfg.alts === false)) prog({ stage: 4, msg: "ほかのルート（第2・第3）を計算中" });
  if (need.length && conf.length > 1 && !(cfg && cfg.alts === false))   // ダウンロードしたときは1本だけ（サーバーにやさしく・早く）
    log(`第2・第3のルートは出さないよ（道路データを ${need.length}マス ダウンロードしたので）`);
  else if (conf.length > 1 && !(cfg && cfg.alts === false)) {
    try {
      const ta = Date.now(), Dkm = hav(s[0], s[1], g[0], g[1]) / 1000;
      const offKm = Math.min(6, Math.max(1, Dkm * 0.15));          // 左右にずらす量
      let altTiles = tiles;
      const wpad = Math.max(pad, offKm / 111 + 0.01), wt = tilesFor(s, g, wpad, tiles[0].key.startsWith("0.01") ? 0.01 : 0.005);
      if (wt.length > tiles.length && wt.length <= 1500) {          // 広げた所のデータを手元から集める（ダウンロードはしない）
        let ok = true;
        for (const t of wt) {
          if (got.has(t.key)) continue;
          if (mem.has(t.key)) { got.set(t.key, mem.get(t.key)); continue; }
          const r = await getTileAny(t.key);
          if (r && !(packIdx && packIdx.has(packName(bigOf(t.key))) && r.pv !== packId)) { got.set(t.key, r.el); continue; }
          const b = bigOf(t.key);
          if (packIdx && packIdx.has(packName(b))) { try { got.set(t.key, (await packTile(b)).el); continue; } catch {} }
          if (packIdx && packEmptyHas(b)) { got.set(t.key, []); continue; }
          ok = false; break;
        }
        if (ok) altTiles = wt;
      }
      const seen = new Set(), elements = [];
      for (const t of altTiles) if (got.has(t.key)) for (const e of got.get(t.key)) { const k = e.type[0] + e.id; if (!seen.has(k)) { seen.add(k); elements.push(e); } }
      const G = BG({ elements }, cfg), qs = nearestGood(G, s[0], s[1]), qg = nearestGood(G, g[0], g[1], qs.n);
      if (qs.n >= 0 && qg.n >= 0) {
        const r0 = search(G, qs.n, qg.n, g, false), p0 = r0.goal >= 0 ? pathTo(r0.prev, r0.goal) : null;
        if (p0) {
          const ek2 = (u, v) => u < v ? u + "," + v : v + "," + u, eLen = (u, v) => hav(G.lat[u], G.lon[u], G.lat[v], G.lon[v]);
          const setOf = p => { const st = new Set(); for (let i = 1; i < p.length; i++) st.add(ek2(p[i - 1], p[i])); return st; };
          const shared = (p, st) => { let m = 0, L = 0; for (let i = 1; i < p.length; i++) { const l = eLen(p[i - 1], p[i]); L += l; if (st.has(ek2(p[i - 1], p[i]))) m += l; } return L ? m / L : 1; };
          const mainLen = analyze(G, p0).len, picked = [setOf(p0)], cands = [];
          const tryPath = (p, how) => {
            if (!p || p.length < 2) return;
            const a = analyze(G, p);
            if (a.len > mainLen * 1.35) return;                                        // 遠回りすぎ
            if (picked.some(st => shared(p, st) > 0.5)) return;                         // 半分以上同じ道
            picked.push(setOf(p)); cands.push({ p, a, how });
          };
          // ① まん中を左右にずらした地点を通る
          const c0 = Math.cos(s[0] * RAD), ex = (g[1] - s[1]) * c0 * 111.32, ny = (g[0] - s[0]) * 111.32, Lk = Math.hypot(ex, ny) || 1;
          const px = -ny / Lk, py = ex / Lk, mla = (s[0] + g[0]) / 2, mlo = (s[1] + g[1]) / 2;
          for (const sg of [1, -1]) {
            const vla = mla + sg * py * offKm / 111.32, vlo = mlo + sg * px * offKm / (111.32 * c0);
            const qv = nearestGood(G, vla, vlo, qs.n); if (qv.n < 0 || qv.d > 1500) continue;
            const ra = search(G, qs.n, qv.n, [G.lat[qv.n], G.lon[qv.n]], false); if (ra.goal < 0) continue;
            const rb = search(G, qv.n, qg.n, g, false); if (rb.goal < 0) continue;
            const p1 = pathTo(ra.prev, ra.goal), p2 = pathTo(rb.prev, rb.goal);
            let k = 0; while (k + 1 < p2.length && p1.length - 2 - k >= 0 && p1[p1.length - 2 - k] === p2[1 + k]) k++;   // 行って戻るムダをけずる
            tryPath(p1.slice(0, p1.length - k).concat(p2.slice(1 + k)), sg > 0 ? "左まわり" : "右まわり");
          }
          // ② 使った道を通りにくくしてさがしなおす
          const penal = p => { for (let i = 1; i < p.length; i++) { const u = p[i - 1], v = p[i];
            for (const e of G.adj[u]) if (e.v === v) e.c *= 3; for (const e of G.adj[v]) if (e.v === u) e.c *= 3; } };
          let last = p0;
          for (let tries = 0; tries < 4 && cands.length < 4; tries++) {
            penal(last);
            const r1 = search(G, qs.n, qg.n, g, false); if (r1.goal < 0) break;
            last = pathTo(r1.prev, r1.goal); tryPath(last, "べつの道");
          }
          cands.sort((a, b) => a.a.len - b.a.len);
          for (const { p, a } of cands.slice(0, 2))
            alts.push({ route: p.map(u => [G.lat[u], G.lon[u]]), ek: a.ek, ok: a.ok, xw: a.xw, ng: a.ng, kinds: a.kinds, turns: a.turns, len: a.len });
          log(`ほかのルート: 候補 ${cands.length}本（${cands.map(c => c.how + " " + (c.a.len / 1000).toFixed(1) + "km").join("・") || "なし"}）`);
        }
      }
      log(`ほかのルート: ${alts.length}本（${alts.map(a => (a.len / 1000).toFixed(2) + "km").join("・") || "ちがう道が見つからなかった"}・考えた範囲 まわり${(wpad * 111).toFixed(1)}km${altTiles === tiles ? "（広げられなかった）" : ""}・${Date.now() - ta}ms）`);
    } catch (e) { log("ほかのルートを出せなかった: " + e.message, "w"); alts = []; }
  }
  const T = (Date.now() - T0) / 1000;
  log(`==== 完了 ${(confLen / 1000).toFixed(2)}km・${T.toFixed(1)}秒（ダウンロード ${done}マス ${kb(bytes)}・つながり ${tBuild.toFixed(1)}秒・探索 ${tSearch.toFixed(1)}秒） ====`, "ok");
  return { route: conf, ek, ok, xw, ng, kinds, turns, len: confLen, nNodes, sec: T, tiles: N, saved, bytes, alts,
    tLoad: Math.max(0, T - tBuild - tSearch), tBuild, tSearch };
}
// 「ただの最短」はくらべる用。順番に確定する方式では出さない
function shortest() { return null; }

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof module === "undefined") {
  logFn = m => self.postMessage({ type: "log", ...m });
  self.onmessage = async ev => {
    const d = ev.data;
    try {
      if (d.cmd === "stats") return self.postMessage({ type: "stats", ...(await stats()) });
      if (d.cmd === "clear") { await clearAll(); return self.postMessage({ type: "stats", ...(await stats()) }); }
      if (d.cmd === "pack") {   // 配布データの場所。一覧を読んで、地図に「すぐ使える所」を出せるように画面に送る
        packBase = d.base; packIdx = null;
        const p = await packIndex();
        if (p && p.size) self.postMessage({ type: "packinfo", keys: [...p], empty: packEmpty ? [...packEmpty] : [] });
        return;
      }
      if (d.cmd === "packAll") { pkStop = false; await packAll(p => self.postMessage({ type: "pk", ...p })); return self.postMessage({ type: "stats", ...(await stats()) }); }
      if (d.cmd === "packStop") { pkStop = true; return; }
      if (d.cmd === "autoPf") {
        pfStop = false;
        if (pfRun) return; pfRun = true;
        try { await autoPrefetch(p => self.postMessage({ type: "pf", ...p })); } finally { pfRun = false; }
        return self.postMessage({ type: "stats", ...(await stats()) });
      }
      if (d.cmd === "prefetchStop") { pfStop = true; if (pfAc) pfAc.abort(); return; }
      if (d.cmd === "export") { const r = await exportTiles(); return self.postMessage({ type: "export", ...r }); }
      if (d.cmd === "import") {
        try { const r = await importTiles(d.file); self.postMessage({ type: "imported", ...r }); }
        catch (e) { self.postMessage({ type: "imported", err: e.message }); }
        return self.postMessage({ type: "stats", ...(await stats()) });
      }
      if (d.cmd === "stop") {   // 計算中の「止める」
        log("■ 止めるボタンが押されました", "w");
        stopReq = true; for (const ac of aborts) ac.abort(); aborts.clear();
        for (const ws of stopWaiters) ws(); return;
      }
      stopReq = false; cancelFetch = false; routing = true; if (pfAc) pfAc.abort();   // 自動でためてる途中なら中断
      blockPts = Array.isArray(d.blocks) ? d.blocks : [];
      avoidPts = Array.isArray(d.avoids) ? d.avoids : [];
      const pr = p => self.postMessage({ type: "prog", ...p, frac: p.frac !== undefined ? p.frac : stageFrac(p) ?? undefined });
      const r = d.loop ? await loopRoute(d, pr) : await route(d, pr, p => self.postMessage({ type: "partial", ...p }));
      self.postMessage({ type: "done", ...r });
      const sh = shortest(); if (sh) self.postMessage({ type: "short", ...sh });
      routing = false;
      await flushSaves();
      self.postMessage({ type: "stats", ...(await stats()) });
    } catch (e) {
      routing = false;
      if (e && e.stopped) { log("■ 止めました", "w"); self.postMessage({ type: "stopped" }); await flushSaves().catch(() => {}); self.postMessage({ type: "stats", ...(await stats()) }); }
      else { log("エラー: " + e.message, "e"); self.postMessage({ type: "error", msg: e.message }); }
    }
  };
}
if (typeof module !== "undefined") module.exports = { shortest, padFor, buildGraph, dijkstra, analyze, nearest, route, isWide, wayCost, overpassQuery, tilesFor, DEFAULT_CFG };
