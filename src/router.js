// ==== 細道ルート計算エンジン（Web Worker / Node 両用） ====
// 設定（cfg）はページ側から渡される。DEFAULT_CFG がおすすめ値
const DEFAULT_CFG = {
  pen: {                 // 1m を何m分と数えるか（大きいほど避ける）。"no" は通らない
    living_street: 0.4, residential: 0.4, service: 1, unclassified: 0.4, cycleway: 0.4,
    tertiary: 1.5, secondary: 3, primary: 3, trunk: 3,
    footway: 1.5, pedestrian: 10, path: 1, track: 1,   // 歩道は 11/21 に ×5→×3、歩行者天国・広場は ×1.5→×3。小道・農道は 11/24 に ×1.5→×1（路面は 🪨砂利・土の設定で見る）
  },
  bkLane: 1, bkNavi: 1,   // 🚲 自転車専用通行帯・ナビライン：倍率（1=気にしない・小さいほど通りたい）。自転車歩行者道は 11/25 から 自転車道（pen.cycleway）と同じあつかい。🐢30km制限は 11/25 に設定からなくした（細い道を好むなら自然とそうなるので）
  steps: "no",           // 階段: "no"=通らない / "ramp"=自転車スロープ付きなら / "yes"=通る
  bridge: 1.5,           // 歩道橋（歩行者用）: 倍率 or "no"（11/21 に地下道と分けた）
  tunnel: 1.5,           // 地下道（歩行者用）: 倍率 or "no"
  unpaved: "no",         // 砂利・土の道: 倍率 or "no"（1=気にしない）
  crossRule: "on",       // 大きい道を渡るルール: いつも "on"（安全のため、アプリから「使わない」はえらべない。"off" は分析用だけ）
  wideCross: "crosswalk", // 4車線以上の横断: "signal" / "crosswalk" / "any"
  bigCross: "mid",       // 県道・国道を渡る: "mid"=2車線と同じ / "wide"=4車線と同じ（アプリではえらべない・分析用）
  park: 10,              // 公園の中の道（園路など）（11/24 から はじめは 通らない。〰川べりの道は のぞく）："no"=通らない / 倍率 / 1=気にしない
  cemetery: "no",         // 霊園・墓地の中の道："no"=通らない / 倍率 / 1=気にしない
  station: 10,            // 駅の中の通路（自由通路・コンコース）："no"=通らない / 倍率 / 1=気にしない
  slope: 5,              // 坂道：のぼり 1m を何m分と数えるか（0＝気にしない）
  stepsGuess: 10,        // 🪜 階段？（標高で見つけた、印のない階段かも）：倍率 or "no"（1＝気にしない）
  steep: 3,              // ⛰ 急坂？（標高で10%より急な短い道）：倍率（1＝気にしない）
  sidewalk: 3,           // 歩道（段差・柵）のある道の倍率。1＝気にしない
  kodo: 1,               // 旧街道の倍率（1＝気にしない / 0.6 なら 1m を 0.6m 分と数える）。「○○旧道」はその半分くらいの効き目
  oneway: 1,             // 11/25 から 数（距離×◯・足し算）。前の "bike"＝×1.3・"avoid"＝×3 も読める。 一方通行の逆向き: "bike"=自転車可の一方通行（警察のデータ・OSMの oneway:bicycle=no）だけ走る（少し避ける） / "no"=走らない
  midCross: 100,         // 2車線の道を横断歩道以外で渡るときの追加コスト(m相当)。旧: "must"/"prefer"/"any"
  allWide: "off",        // 2車線の道も4車線としてあつかう: "off"（デフォルト）/ "on"（信号・横断歩道でしか渡らない）
  jarUse: "on",          // 警察の交通規制（JARTIC）を使う: "on"（デフォルト）/ "off"。いまは 歩行者等横断禁止の道を4車線あつかいにするだけ
  fastCross: "mid",      // 最高速度50km以上の2車線道路: "mid"=2車線と同じ（11/20 からいつも。アプリではえらべない）/ "wide"=4車線と同じ（分析用）
  brSteps: "ramp",      // 🌉 橋の歩道の出入り口の階段（br:ramp）: "ramp"=自転車スロープつきとみなす（デフォルト）/ "steps"=ふつうの階段と同じ
  xDet: 30,              // 4車線の道：この m 以内の（同じ道の上の）信号・横断歩道まで行って渡る。0＝しない（交差点の その場で渡れる所だけ）
};
const BASE = { tertiary_link: "tertiary", secondary_link: "secondary", primary_link: "primary", trunk_link: "trunk" };
const CAR_ROADS = new Set(["residential", "unclassified", "living_street", "service", "tertiary", "secondary", "primary", "trunk"]);   // 車の道（🚓 一方通行を見る道）
const OTHER_PENALTY = 2.0;
const EXCLUDE = new Set(["motorway", "motorway_link", "construction", "proposed", "raceway", "bus_guideway",
  "elevator", "corridor", "platform", "bus_stop"]);
const UNPAVED = new Set(["gravel", "fine_gravel", "pebblestone", "unpaved", "dirt", "earth", "ground", "grass",
  "sand", "mud", "compacted", "woodchips", "rock", "grass_paver"]);
const HARD = 3000, SOFT = 500;    // 横断ルールを守れないときの追加コスト(m相当)
// 2車線の横断コスト。数字(m)か、むかしの設定の文字
const ONEWAY_REV = 1.3, ONEWAY_REV_AVOID = 3;           // 自転車可の一方通行を逆向きに走るときは少しだけ避ける
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
  if (MID_ROADS.has(b) || lanesOf(t) >= 2) return (cfg && cfg.allWide === "on") || (t["jar:nx"] && (!cfg || cfg.jarUse !== "off")) || (cfg && cfg.fastCross === "wide" && parseInt(t.maxspeed) >= 50) ? 2 : 1;   // allWide="on"：2車線の道も4車線と同じ（より安全に）   // 最高速度50km以上は 車が速くて危ないので 4車線と同じ扱い（設定 fastCross="mid" なら2車線と同じ）
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
// wayCost が null（通らない）だった理由（🧪 道のデータ用）
function wayNoWhy(t, cfg) {
  const hw = t.highway, b = BASE[hw] || hw;
  const stairy = FOOTLIKE.has(hw) && hw !== "steps" && (t.step_count || t["ramp:bicycle"] || t["ramp:stroller"] || /階段|石段/.test(t.name || ""));
  if (hw === "steps" || stairy) return cfg.steps === "ramp" ? "スロープのない階段（設定：スロープ付きだけ）" : t["br:ramp"] ? "橋の出入り口の階段（設定：ふつうの階段と同じ・通らない）" : "階段（設定：通らない）";
  if (FOOTLIKE.has(hw) && yes(t.bridge) && cfg.bridge === "no") return "歩道橋（設定：通らない）";
  if (FOOTLIKE.has(hw) && !yes(t.bridge) && yes(t.tunnel) && (cfg.tunnel ?? cfg.bridge) === "no") return "地下道（設定：通らない）";
  if (isUnpaved(t) && cfg.unpaved === "no") return "砂利・土の道（設定：通らない）";
  return `${KIND_JA[b] || b}（設定：通らない）`;
}
// 倍率の数えかた（11/24・ユーザーと決めた）：「なぜいやか／なぜ通りたいか」の理由ごとに分けて、
//   同じ理由の中は いちばん大きいのだけ（Math.max）、ちがう理由どうしは 足し算：倍率 ＝ 1 ＋ Σ（理由ごとの倍率 − 1）
//   足し算にする基準：その道じたいのタグでわかる性質（道の種類・路面・自転車インフラなど）は、いくつも重なりがちなので足し算
//   🚶 ppl 人が多い：歩く道（歩道・歩行者天国）・公園の中・駅の通路・霊園・団地
//   🚗 car 車が多い：車の道（細い車道・駐車場・一般道・県道・国道。4車線以上は ×1.5）
//   🪨 rgh 走りにくい：小道・農道・階段・砂利・舗装不明・歩道橋・地下道・🪜階段？・⛰急坂？・🚧段差柵（歩道がとなりにある車道。11/25 から 同じ理由に統合）
//   🏠 prv 入りにくい：私道・家の前・駐車場の中
//   🚲 bik 自転車道の倍率（自転車道そのもの・自転車専用通行帯・ナビライン・30km制限。11/25 から 同じ理由に統合。いくつも当てはまっても いちばん効くの1つだけ）
// （前は かけ算で、歩道×3 × 公園×5 ＝ ×15 みたいに 同じ理由を2回数えて きつすぎた）
// 足し算にしないもの（道そのもののタグではなく、場所の文脈・ユーザーの操作でかかる、別レイヤーの倍率）は これまでどおり 最後に かけ算：
//   旧街道（kodo）・〰川べり（riv）・👍通りたい／⚠通りたくない（地図に印をつける）・👣もう塗った道（paintPen）
const HW_WHY = { footway: "ppl", pedestrian: "ppl", corridor: "ppl", path: "rgh", track: "rgh", bridleway: "rgh", steps: "rgh", cycleway: "bik" };
// 🚲 自転車道のなかま（道の好み・11/24）。いくつも当てはまるときは 専用通行帯 → ナビライン → 30km制限 の順に 1つだけ。
// 11/25：自転車道そのもの（pen.cycleway）と同じ「bik」の理由にまとめた（前は ここだけ別あつかいの かけ算だった）
// bicycle=designated の歩道・小道（自転車歩行者道。大河川ぞいでCRの印がとぎれた所をつなぐ、CRと同じ存在）は、
//   wayCost 本体ですでに「自転車道」（pen.cycleway）としてあつかっているので、ここでは もう数えない（前は二重に効いていた）
const BL_KEYS_R = ["cycleway", "cycleway:both", "cycleway:left", "cycleway:right"];
function bikeClassK(t, hw, cfg) {
  if (hw === "cycleway" || hw === "steps" || (CYCLE_OK.has(hw) && t.bicycle === "designated")) return null;   // 自転車道そのものは 「自転車道」の設定（pen.cycleway）
  const v = BL_KEYS_R.map(k => t[k]).filter(Boolean), K = k => { const x = +cfg[k]; return x > 0 ? x : 1; };
  if (v.some(x => ["lane", "track", "opposite_lane", "opposite_track"].includes(x))) return K("bkLane") !== 1 ? [K("bkLane"), "自転車専用通行帯"] : null;
  if (v.some(x => ["shared_lane", "share_busway", "shoulder"].includes(x))) return K("bkNavi") !== 1 ? [K("bkNavi"), "ナビライン"] : null;
  return null;
}
// 🎨 デバッグの「道のデータ」と同じ道の種類（app.html の dbgKind と同じ。ルートの線の色に使う）
const DBG_FT = ["footway", "pedestrian", "path", "track", "bridleway", "corridor"], dbgYes = v => v && v !== "no";
function dbgKindR(t) {
  const hw = t.highway;
  if (hw === "steps") return t["ramp:bicycle"] === "yes" ? "rsteps" : t["br:ramp"] ? "bsteps" : "steps";
  if (t["jar:nbside"]) return "nbside";
  if (t["br:side"]) return t["br:bike"] ? "bsideb" : "bside";
  if (hw === "cycleway" || (DBG_FT.includes(hw) && t.bicycle === "designated")) return "cycle";
  if (["footway", "pedestrian", "path", "corridor"].includes(hw) && (dbgYes(t.bridge) || dbgYes(t.tunnel))) return dbgYes(t.bridge) ? "fbridge" : "ftunnel";
  if (hw === "footway" || hw === "pedestrian" || hw === "corridor") return t.footway === "sidewalk" ? "sidewalk" : t.footway === "crossing" ? "crossing" : "foot";
  if (DBG_FT.includes(hw)) return "path";
  if (hw === "service") return "service";
  return "road";
}
// 11/25：bik（自転車道）も 足し算に入ったので、「細い車道 ×0.4（どんどん通る）」＋「自転車専用通行帯 ×0.4」みたいに
//   へらすほうが2つ重なると 0 を下回りかねない → 下げすぎないように 0.1 で止める
const whySum = r => { let s = 1; for (const k in r) s += r[k] - 1; return Math.max(0.1, s); };
const whyAdd = (r, k, v) => { v = +v || 1; if (!(r[k] >= v)) r[k] = v; return r; };
// → [倍率, 名前, 理由ごとの倍率 {ppl,car,…}, かけ算の分（旧街道）] か null（通らない）
function wayCost(t, cfg) {
  const hw = t.highway, b = BASE[hw] || hw, r = {};
  let name = KIND_JA[b] || b, kd = 0, km = 1;
  // 「歩道」「小道」なのに階段っぽい印（段の数・自転車やベビーカーのスロープ・名前に階段）があるものは階段あつかい
  const stairy = FOOTLIKE.has(hw) && hw !== "steps" && (t.step_count || t["ramp:bicycle"] || t["ramp:stroller"] || /階段|石段/.test(t.name || ""));
  if (hw === "steps" || stairy) {
    const brR = t["br:ramp"] && t["ramp:bicycle"] !== "no" && (cfg.brSteps ?? "ramp") === "ramp";   // 🌉 橋の歩道の出入り口の階段：スロープつきとみなす
    if (cfg.steps === "no" && !brR) return null;
    if (cfg.steps === "ramp" && t["ramp:bicycle"] !== "yes" && !brR) return null;
    whyAdd(r, "rgh", cfg.steps === "yes" ? 5 : 8);
    name = cfg.steps === "yes" ? "階段" : t["ramp:bicycle"] === "yes" ? "自転車スロープ付き階段" : "橋の出入り口の階段（スロープつき？）";
  } else if (CYCLE_OK.has(hw) && t.bicycle === "designated") {
    // 自転車の通行指定がある歩道・小道・農道（川べりのサイクリングロードに多い）＝自転車道あつかい
    const p = cfg.pen.cycleway ?? 1; name = "自転車道";
    if (p === "no") return null;
    whyAdd(r, "bik", p);
  } else {
    let p = cfg.pen[b] ?? OTHER_PENALTY;
    if (p === "no" && b === "pedestrian" && ["yes", "permissive"].includes(t.bicycle)) p = cfg.pen.footway ?? 3;   // 🚶 歩行者天国・広場：自転車OKの印がある所は 歩く道と同じ
    if (p === "no") return null;
    if (lanesOf(t) >= 2 && p > 1) p *= 1.5;
    whyAdd(r, HW_WHY[b] || "car", p);
    kd = kodoOf(t);
  }
  if (FOOTLIKE.has(hw) && t.bicycle !== "designated" && !t["jar:nbside"] && !t["br:side"] && (yes(t.bridge) || yes(t.tunnel))) {   // jar:nbside：自転車通行止めの橋の歩道・br:side：車の橋にそう歩道（どちらも歩道橋ではない）
    const bm = yes(t.bridge) ? cfg.bridge : (cfg.tunnel ?? cfg.bridge);
    if (bm === "no") return null;
    whyAdd(r, "rgh", bm); name = yes(t.bridge) ? "歩道橋" : "地下道";
  }
  const u = isUnpaved(t);
  if (u === "sure") {
    if (cfg.unpaved === "no") return null;
    whyAdd(r, "rgh", cfg.unpaved);
    name = "砂利・土の道";
  } else if (u) {   // 舗装不明の小道・農道（surface がない）：11/24 から 砂利・土とは別の設定（はじめは 少し避ける ×1.5）
    const m = cfg.unkSurf ?? 3;
    if (m === "no") return null;
    whyAdd(r, "rgh", m);
    name = "舗装不明の小道";
  }
  if (kd) {   // 旧街道は へらすほうなので 最後にかけ算
    km = Math.min(1, +cfg.kodo || 1); km = kd === 2 ? km : Math.sqrt(km);
    name += kd === 2 ? "・旧街道" : "・旧道";
  }
  const bk = bikeClassK(t, hw, cfg);   // 🚲 自転車道のなかま（ナビライン・専用通行帯・30km制限）：11/25 から 自転車道（bik）と同じ理由の足し算に
  if (bk) { whyAdd(r, "bik", bk[0]); name += `・${bk[1]}` + (bk[0] !== 1 ? ` ×${bk[0]}` : ""); }
  return [whySum(r) * km, name, r, km];
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
let wanderG = null, wanderJ = [], wanderHash = null;   // 🧭 ためし走行：いちばん新しいルートの道のつながり（Worker に残す）・分かれ道の一覧・点→番号
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
  cfg = { ...cfg, privy: "no", danchi: "no", cemetery: "no" };   // 私道・駐車場・団地・霊園の中は いつも 通らない（設定の項目はなくした。古い設定・共有URLが来ても そろえる）
  cfg = { ...DEFAULT_CFG, ...cfg, pen: { ...DEFAULT_CFG.pen, ...(cfg && cfg.pen) } };
  const idx = new Map(), lat = [], lon = [], ntags = new Map(), ids = [];
  for (const e of osm.elements) if (e.type === "node") {
    idx.set(e.id, lat.length); ids.push(e.id); if (e.tags) ntags.set(lat.length, e.tags); lat.push(e.lat); lon.push(e.lon);
  }
  const N = lat.length, adj = Array.from({ length: N }, () => []);
  const lvl = new Uint8Array(N), inGraph = new Uint8Array(N);
  // 地図データに 階段と書いてある道（と 階段っぽい歩道）の点：標高の 階段？・急坂？は ここでは見ない（もう わかっているので）
  const stepN = new Uint8Array(N);
  for (const e of osm.elements) {
    if (e.type !== "way" || !e.tags) continue;
    const t = e.tags, hw = t.highway;
    if (hw === "steps" || (FOOTLIKE.has(hw) && (t.step_count || t["ramp:bicycle"] || t["ramp:stroller"] || /階段|石段/.test(t.name || "")))) for (const id of e.nodes) { const i = idx.get(id); if (i !== undefined) stepN[i] = 1; }
  }
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
  const WG = cfg._warp, warpOn = cfg.warp != null && cfg.warp !== "off", warpD = warpOn ? Math.min(1, +cfg.warp || 1) - 1 : 0;   // ➡️ シンプルパス：倍率の足し算（自転車道のなかま）
  const rivOn = cfg.riv != null && cfg.riv !== "off", rivK = rivOn ? Math.min(1, +cfg.riv || 1) : 1, RG = cfg._riv;   // RG：ルートのはんいの 川の線（rivPrep）   // 〰 川べりの車の来ない道：1m を何m分と数えるか（1＝気にしない・へらすほう）
  const danPen = (cfg.danchi ?? "no") === "no" ? null : (+cfg.danchi || 1);   // 🏢 団地の中の道（11/24 から はじめは 通らない）
  const prvPen = (cfg.privy ?? "no") === "no" ? null : (+cfg.privy || 1);     // 🏠 私道・家の前の道・駐車場の中（11/24 から はじめは 通らない）
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
    if (t["br:side"] || t["jar:nbside"]) return false;   // 🌉 車の橋・たもとの坂ぞいの歩道は 駅の通路ではない（船堀橋の中川の上：東大島駅のとなり）
    const inside = yes(t.bridge) || yes(t.tunnel) || t.tunnel === "building_passage" || yes(t.covered) || yes(t.indoor) || t.level != null
      || (t.layer && t.layer !== "0") || /通路|コンコース|改札|駅/.test(t.name || "");
    const m = nd[nd.length >> 1], ends = [nd[0], m, nd[nd.length - 1]];
    if (inside) return ends.some(i => nearSta(lat[i], lon[i], STA_R));
    // 印のない歩道でも、駅のすぐそば（60m）で歩道（sidewalk）・横断歩道でなければ、駅の中の通路とみる
    if (t.highway !== "footway" && t.highway !== "corridor") return false;
    if (t.footway === "sidewalk" || t.footway === "crossing") return false;
    return ends.every(i => nearSta(lat[i], lon[i], 60));
  };
  // 🧪 道のデータ（dbgView）用：道ごとに「通る（計算での名前・倍率）／通らない（理由）」をメモ（cfg._dbg のときだけ）
  const DBGW = cfg._dbg ? new Map() : null;
  for (const e of osm.elements) {
    if (onProg && (++ei & 0x3fff) === 0) onProg(ei / NE * 0.9);
    if (e.type !== "way") continue;
    const t = e.tags || {}, hw = t.highway;
    const no = r => { if (DBGW) DBGW.set(e.uid || e.id, { use: false, r }); };
    if (!hw) continue;
    if (EXCLUDE.has(hw)) { no("自転車が走れない種類の道（高速道路・工事中など）"); continue; }
    if (t.access === "no" || t.access === "private") { no(`立ち入り禁止・私道（access=${t.access}）`); continue; }
    if (t.bicycle === "no") { no("自転車禁止（bicycle=no）"); continue; }
    const nd = e.nodes.map(id => idx.get(id)).filter(x => x !== undefined);
    if (nd.length < 2) continue;
    const L0 = levelOf(t, cfg);
    if (L0) { mainWays.push([nd, L0, t.name || t.ref || "w" + e.id, isOneway(t)]); for (const i of nd) if (L0 > lvl[i]) lvl[i] = L0; }   // 通らない道でも「横断する道」としては数える（名前：同じ道かを見る・一方通行：上下線が別の道か）
    if (t["jar:nb"] === "1" || t["jar:nb"] === "ta") { no((t["jar:nbk"] === "pw" ? "🚶 歩行者用道路" : "🚳 自転車通行止め") + (t["jar:nb"] === "ta" ? "（警察のデータ・いまは規制の時間）" : "（警察のデータ）")); continue; }   // 🚳 自転車通行止め（警察のデータ・一日中）：通らない（「横断する道」としては上で数えている）
    const wc = wayCost(t, cfg);
    if (!wc) { if (DBGW) no(wayNoWhy(t, cfg)); continue; }
    let [pen, name, why, km] = wc;
    // 〰 川べりの車の来ない道：区間ごとに見分ける（rv）。長さの半分以上が川べりなら 公園の中でも 公園あつかいにしない（ユーザー：川べりの公園の中の 川ぞいの道だけ通れる）
    let rv = null, rvHalf = false;
    if (RG && RG.n && rivOK(t)) { const r = rivWay(RG, nd.map(i => [lat[i], lon[i]]));
      if (r) { rv = r.rv; let a = 0, b = 0; for (let q = 1; q < nd.length; q++) { const l = hav(lat[nd[q - 1]], lon[nd[q - 1]], lat[nd[q]], lon[nd[q]]); b += l; if (rv[q - 1]) a += l; } rvHalf = a * 2 >= b; } }
    let wv = null;   // ➡️ シンプルパス：区間ごとに 0/1
    if (WG && WG.n && warpOn && WARP_HW.has(t.highway)) { const r = rivWay(WG, nd.map(i => [lat[i], lon[i]]), WARP_NEAR); if (r) wv = r.rv; }
    const whyUp = (k, v) => { whyAdd(why, k, v); pen = whySum(why) * km; };   // 理由をふやして 倍率を数えなおす
    if (t["jar:nb"] === "t") name += t["jar:nbk"] === "pw" ? "・歩行者用道路（いまは時間外）" : "・自転車通行止め（いまは時間外）";   // 時間つきで いまは時間外：ふつうに通る
    if (stationGrid && cfg.station !== 1 && isStaPath(t, nd)) {   // 駅の中の通路
      if (stPen === null) { no("駅の中の通路（設定：通らない）"); continue; }
      whyAdd(why, "ppl", +cfg.pen.footway || 1); whyUp("ppl", stPen); name = "駅の通路";
    }
    // 🏫 学校・病院・工場などの敷地の中の通路は通らない（ふつうの道路と、自転車OKの印がある道はのぞく）
    if (areaGrids && areaGrids.closed && !BIG_HW.has(hw) && !["residential", "unclassified", "living_street"].includes(hw)
      && !["yes", "permissive", "designated"].includes(t.access) && !["yes", "permissive", "designated"].includes(t.bicycle) && inArea("closed", nd)) { no("学校・病院・工場などの敷地の中"); continue; }
    if (areaGrids && cfg.cemetery !== 1 && !BIG_HW.has(hw) && inArea("cemetery", nd)) {   // 霊園・墓地の中の道
      if (cemPen === null) { no("霊園・墓地の中（設定：通らない）"); continue; }
      whyUp("ppl", cemPen); name = "霊園の中";
    }
    // 公園の中の道（園路・交通公園のコースなど）。川ぞいのサイクリングロードみたいな
    // 長い（400m以上）自転車道と、ふつうの道（住宅街の道など）は、公園の中でもそのまま通る
    else if (areaGrids && areaGrids.park && cfg.park !== 1 && !rvHalf && !BIG_HW.has(hw) && !t["br:side"] && !t["jar:nbside"] && !["yes", "designated"].includes(t.bicycle) && inArea("park", nd)   // 🌉 橋の歩道は 下が河川敷の公園でも 公園の道ではない（木根川橋）。🚲 自転車OKの道（bicycle=yes・designated）も 園路ではない（千住新橋の千住がわ：橋から土手へおりる 417623838 が 河川敷の公園の囲みに入っていた）
      && !(["residential", "unclassified", "living_street"].includes(hw) || (hw === "cycleway" && wayLen(nd) >= 400))) {
      if (parkPen === null) { no("公園の中（設定：通らない）"); continue; }
      whyUp("ppl", parkPen); name = "公園の中";
    }
    // 🏠 私道っぽい道：家の敷地に入る道（service=driveway）・「住んでいる人と用事のある人だけ」（access=destination など）・駐車場の中の道
    if (prvPen !== 1 && !BIG_HW.has(hw) && (t.service === "driveway" || ["destination", "customers", "delivery"].includes(t.access) || ["destination", "customers", "delivery"].includes(t.vehicle)
      || (hw === "service" && areaGrids && areaGrids.parking && inArea("parking", nd)))) {
      if (prvPen === null) { no("私道・駐車場（設定：通らない）"); continue; }
      whyUp("prv", prvPen); name = "私道・駐車場";
    }
    // 🏢 団地の中の道（棟のあいだの通路・駐車場の道など）。団地の中を通りぬける ふつうの道路（住宅街の道など）は そのまま
    if (areaGrids && areaGrids.danchi && danPen !== 1 && !BIG_HW.has(hw) && !["residential", "unclassified", "tertiary", "tertiary_link"].includes(hw)
      && !(hw === "cycleway" && wayLen(nd) >= 400) && inArea("danchi", nd)) {
      if (danPen === null) { no("団地の中（設定：通らない）"); continue; }
      whyUp("ppl", danPen); name = "団地の中";
    }
    if (["footway", "path", "pedestrian", "cycleway", "track"].includes(hw) && nd.some(i => ntags.get(i)?.railway === "crossing")) {
      let wl = 0; for (let i = 1; i < nd.length; i++) wl += d(nd[i - 1], nd[i]);
      if (wl < 200) { pen = 1.0; for (const k in why) delete why[k]; km = 1; name = "歩行者・自転車用踏切"; }
    }
    // 一方通行：🚓 警察のデータ（jarApply の jar:ow・jar:owb）があれば それを優先（向き・自転車は除くか）。なければ OSM
    let ow = t.oneway;
    if (t["jar:ow"]) ow = t["jar:ow"] === "-1" ? "-1" : "yes";
    const bikeOK = t["jar:ow"] ? t["jar:owb"] === "1" : t["oneway:bicycle"] === "no";   // 自転車は逆向きも走ってよい（自転車を除く）
    let fwd = ow !== "-1", back = !["yes", "1", "true"].includes(ow);
    // 一方通行の逆向き：自転車可（自転車を除く）とわかっている道だけ（少しだけ避ける）。設定「走らない」なら走らない。自転車も一方通行の道・わからない道は走らない
    // ⛔ 逆走も ほかと同じ「理由ごとに足し算」のルールに入れた（11/25）：前は 最後にかけ算で、30km制限 ×0.4 × 逆走1.3 ＝ ×0.52 と ふつうの道（×1）より安くなり 逆走ばかりしていた
    //   逆向き ＝（理由の足し算 ＋（逆走の倍率 − 1））×（へらすほうの倍率。ただし ×1より下げない）。自転車レーン・ナビライン・30km などの「通りたい」は 逆向きには効かない
    let rvK = 0, rname = name;
    if (fwd !== back && bikeOK && cfg.oneway !== "no") {
      fwd = back = true; rvK = (cfg.oneway === "avoid" ? ONEWAY_REV_AVOID : cfg.oneway === "bike" || !(+cfg.oneway > 0) ? ONEWAY_REV : +cfg.oneway) - 1; rname = name.replace(/ ×0\.\d+/g, "") + "（一方通行を逆向き）";
    }
    const rp = rvK ? (whySum(why) + rvK) * Math.max(1, km) : pen;
    if (DBGW) DBGW.set(e.uid || e.id, { use: true, r: `${name} ×${+pen.toFixed(2)}` + (rv ? (rvHalf ? "・〰川べり" : "・〰ところどころ川べり") + (rivK !== 1 ? `（川べりの所 ×${rivK}）` : "") : "") + (fwd !== back ? "・一方通行" : rvK ? `・一方通行（自転車は逆向きOK・逆向き ×${+rp.toFixed(2)}）` : "") });
    const dk = dbgKindR(t), rev = ow === "-1";   // dk：ルートの線の色（デバッグの道の種類）   // 逆向き一方通行なら「正方向」が逆走
    const swRoad = swPen > 1 && SW_ROADS.has(hw), swAll = swRoad && swTag(t);
    const lift = yes(t.bridge) || yes(t.tunnel) || t.tunnel === "building_passage" || (t.layer && t.layer !== "0") || t["br:side"] ? 1 : 0;   // 橋・トンネル・🌉 橋のたもとの坂ぞいの歩道（標高のデータと高さが合わない。新四つ木橋のたもとが ⛰/🪜 になっていた）
    for (let i = 1; i < nd.length; i++) {
      const u = nd[i - 1], v = nd[i], L = d(u, v);
      inGraph[u] = 1; inGraph[v] = 1;
      const m = swRoad && (swAll || hasSW(u, v)) ? swPen : 1;   // 歩道のある道は避ける（道の倍率と くらべて 大きいほう）
      if (m > 1) swLen += L;
      // 🚧 段差・柵は 🪨走りにくい と同じ理由あつかいにした（11/25）：重なったら 大きいほうだけ（足し算ではなく）
      const rgBase = why.rgh || 1, rg = Math.max(rgBase, m), pm = (whySum(why) - rgBase + rg) * km;
      const rpm = rvK ? (whySum(why) - rgBase + rg + rvK) * Math.max(1, km) : pm;
      // sm：足し算した倍率（旧街道の分の前）・rg：🪨 走りにくい の倍率（あとで 🪜階段？・⛰急坂？ と くらべる）
      // 〰 川べり（設定がオンのとき）：🚶人が多い（歩く道）の分を数えないで、かわりに ×rivK（へらすほう）。歩道×3 だと ×0.6 しても 住宅街の道（×1）に勝てなかったので
      const isW = wv && wv[i - 1] && warpD < 0;   // 🌀 倍率は 足し算（×1の道が ×0.6 など）。0.1 より下げない
      const pmW = isW ? Math.max(0.1, pm / km + warpD) * km : pm, rpmW = isW ? Math.max(0.1, rpm / km + warpD) * km : rpm;
      const isR = rv && rv[i - 1], rk = isR && rivOn ? (whySum(why) - ((why.ppl || 1) - 1) + (m > 1 ? m - 1 : 0)) * km * rivK / pm : 1, rn = (isR ? "・川べり" : "") + (isW ? "・➡️シンプルパス" : "");
      if (fwd) adj[u].push({ v, c: L * (rev ? rpmW : pmW) * rk, sm: pmW / km, rg, L, l: L0, k: (rev ? rname : name) + rn, w: e.id, b: lift, hw, dk });
      if (back) adj[v].push({ v: u, c: L * (rev ? pmW : rpmW) * rk, sm: pmW / km, rg, L, l: L0, k: (rev ? name : rname) + rn, w: e.id, b: lift, hw, dk });
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
    if (t.highway === "traffic_signals" || t.crossing === "traffic_signals" || t["crossing:signals"] === "yes" || t["jar:sig"]) put(gSig, i);
    else if ((t.highway === "crossing" && !["no", "unmarked", "informal"].includes(t.crossing)) || t["jar:xw"]) put(gXw, i);
  }
  const cands = (g, i, r) => {   // r m 以内の点 [番号, きょり]
    const a = Math.round(lat[i] * 2000), b = Math.round(lon[i] * 2000), out = [];
    const K = Math.max(2, Math.ceil(r / 45));   // 1マス 約55m（たて）× 約45m（よこ）
    for (let x = -K; x <= K; x++) for (let y = -K; y <= K; y++)
      for (const j of g.get((a + x) + "," + (b + y)) || []) { const dd = d(i, j); if (dd <= r) out.push([j, dd]); }
    return out;
  };
  // 道の名前（同じ道の上の 信号・横断歩道かを見る）
  const rk = new Map();
  for (const [nd, , k] of mainWays) for (const i of nd) { let s = rk.get(i); if (!s) rk.set(i, s = new Set()); s.add(k); }
  const sameRoad = (i, j) => { const a = rk.get(i), b = rk.get(j); if (!a || !b) return false; for (const k of a) if (b.has(k)) return true; return false; };
  // 上り・下りが別の線になっている道（中央分離帯）：一方通行の大きい道で、同じ名前の反対向きの線が 35m 以内にある
  const divided = new Uint8Array(N), oseg = new Map(), OG = 0.0005;
  for (const [nd, , k, ow] of mainWays) if (ow) for (let q = 1; q < nd.length; q++) {
    const u = nd[q - 1], v = nd[q], c = Math.floor((lat[u] + lat[v]) / 2 / OG) + "," + Math.floor((lon[u] + lon[v]) / 2 / OG);
    if (!oseg.has(c)) oseg.set(c, []); oseg.get(c).push([u, v, k]);
  }
  for (const [nd, , k, ow] of mainWays) if (ow) for (let q = 0; q < nd.length; q++) {
    const i = nd[q], a = nd[Math.max(0, q - 1)], b = nd[Math.min(nd.length - 1, q + 1)]; if (a === b || divided[i]) continue;
    const dx = (lon[b] - lon[a]) * cosl0, dy = lat[b] - lat[a], cy = Math.floor(lat[i] / OG), cx = Math.floor(lon[i] / OG);
    for (let p = -1; p <= 1 && !divided[i]; p++) for (let r = -1; r <= 1 && !divided[i]; r++) for (const [u, v, k2] of oseg.get((cy + p) + "," + (cx + r)) || []) {
      if (k2 !== k || u === i || v === i) continue;
      const ex = (lon[v] - lon[u]) * cosl0, ey = lat[v] - lat[u], dot = (dx * ex + dy * ey) / (Math.hypot(dx, dy) * Math.hypot(ex, ey) || 1);
      if (dot < -0.8 && Math.min(d(i, u), d(i, v)) < 35) { divided[i] = 1; break; }
    }
  }
  // 横断の追加コスト（その点で lvl の道を横切るとき）と種類 1=信号 2=横断歩道 3=なし
  // ・信号のある交差点（交差点から15m以内に信号の点。どの道の上でも）：車の信号に したがって渡れる → その場でOK
  // ・信号のない交差点：その大きい道の上の 12m以内の横断歩道だけ（わき道を渡る横断歩道は数えない）
  // ・どちらもない 4車線・上下別の道：cfg.xDet m 以内の、その大きい道の上の 信号・横断歩道まで行って渡る（2×きょり を足す。0＝しない）
  const HERE_R = 12, SIG_R = 15, DET_R = +cfg.xDet || 0;   // DET_R：はなれた信号・横断歩道まで行って渡る（m・0＝しない）
  const xcost = new Float32Array(N), xkind = new Uint8Array(N), xref = new Int32Array(N).fill(-1), xdet = new Float32Array(N);   // xref：渡ってよいことにした 信号・横断歩道の点（🧪 道のデータを見る で出す）
  let nNodes = 0, nDiv = 0, nDet = 0;
  for (let i = 0; i < N; i++) {
    if (inGraph[i]) nNodes++;
    if (!lvl[i] || !inGraph[i] || cfg.crossRule === "off") continue;   // ルールを使わないときは どこでも渡る（コスト0）
    const L = lvl[i], anyOK = L === 2 && cfg.wideCross === "any";
    const none = L === 2 ? HARD : divided[i] ? HARD : midPen(cfg.midCross);
    let bc = anyOK ? 0 : none, bk = 3, bj = -1, bd = 0;
    const tryJ = (j, dd, kind, ok) => {
      if (!ok) return;
      const c = dd <= HERE_R ? 0 : 2 * dd;
      if (c < bc || (c === bc && bk === 3)) { bc = c; bk = kind; bj = j; bd = dd <= HERE_R ? 0 : dd; }
    };
    for (const [j, dd] of cands(gSig, i, SIG_R)) tryJ(j, 0, 1, true);   // 信号のある交差点（車の信号でも 歩行者信号でも）
    if (L === 1 || cfg.wideCross === "crosswalk" || anyOK)
      for (const [j, dd] of cands(gXw, i, HERE_R)) tryJ(j, 0, 2, sameRoad(i, j) && lvl[j] >= L);   // 信号のない交差点：その大きい道の上の横断歩道だけ
    // 🚸 渡れない交差点（4車線・上下別の道）：その大きい道の上の DET_R m 以内の 信号・横断歩道まで行って渡る（行って もどる分 2×きょり）。
    //    ルートの線は交差点でまたぐ形のまま。アプリが「左の横断歩道で道路を横断してください」と言って、自機の横に 🚸/🚦 を出す
    if (DET_R > 0 && bk === 3 && (L === 2 || divided[i])) {
      for (const [j, dd] of cands(gSig, i, DET_R)) if (dd > SIG_R) tryJ(j, dd, 1, sameRoad(i, j) && lvl[j] >= L);
      if (cfg.wideCross === "crosswalk" || L === 1) for (const [j, dd] of cands(gXw, i, DET_R)) if (dd > HERE_R) tryJ(j, dd, 2, sameRoad(i, j) && lvl[j] >= L);
    }
    xcost[i] = bc; xkind[i] = bk; xref[i] = bj; xdet[i] = bd;
    if (divided[i]) nDiv++; if (bd) nDet++;
  }
  log(`横断：上下線が別の道の点 ${nDiv}・近くの信号/横断歩道まで行って渡る点 ${nDet}`);
  const nBlk = applyBlocks(lat, lon, adj, N);
  if (paintedSet && paintedSet.size && PAINT_PEN > 1) {   // 👣 まだ塗っていない道を通りたい：もう塗った区間を ×PAINT_PEN
    let np = 0;
    for (let u = 0; u < N; u++) for (const e of adj[u] || []) { const a = ids[u], b = ids[e.v]; if (paintedSet.has(a < b ? a + "-" + b : b + "-" + a)) { e.c *= PAINT_PEN; np++; } }
    if (np) log(`👣 もう塗った道 ${np}区間を ×${PAINT_PEN}（まだ塗っていない道を通るように）`);
  }
  // 1周の帰り道：通った所を通りにくくしたぶん、道を渡るルールも同じだけ重くする（でないと「遠回りより国道を信号なしで渡る」になる）
  if (usedNodes && usedNodes.size) for (let i = 0; i < N; i++) if (xcost[i]) xcost[i] *= USED_PEN;
  return { dbgW: DBGW, lat, lon, adj, lvl, xcost, xkind, xref, xdet, divided, ntags, inGraph, nNodes, cfg, nBlk, dirX, dirY, cosl, idx, ids, turn: +(cfg.turn || 0), swLen, stepN,
    hk: Math.min(1, +cfg.kodo || 1) * Math.max(0.1, Math.min(1, ...Object.values(cfg.pen || {}).map(v => +v > 0 ? +v : 1)) + Math.min(1, ...["bkLane", "bkNavi"].map(k => +cfg[k] > 0 ? +cfg[k] : 1)) - 1 + (cfg.warp != null && cfg.warp !== "off" ? Math.min(1, +cfg.warp || 1) - 1 : 0)) * (cfg.riv != null && cfg.riv !== "off" ? Math.min(1, +cfg.riv || 1) : 1) * (preferPts.length ? PREFER_K : 1) };   // 〰 川べりも 1m＜1m なので   // 👍 通りたい道も 1m＜1m なので、見こみを同じだけ小さく   // 旧街道を 1m＜1m と数えるときは、A* の見こみもそのぶん小さくする（でないと良いルートを見のがす）。道の倍率と自転車道のなかまは 11/25 から足し算なので、見こみも足し算（whySum と同じ 0.1 で止める）
}

// 🚫 通れない印（自分でつけた印。画面から毎回もらう）：印から12m以内を通る道のつながりを切る
let blockPts = [], avoidPts = [], preferPts = [], okPts = [];   // okPts：[緯度, 経度, 種類]　n＝🪜✕ 階段じゃない（🪜を ⛰急坂？にする）・y＝🪜✓ 階段だった（⛰を 🪜階段？にする）   // 🚫 通れない（道を切る）／ ⚠ 通りたくない（その道を ×AVOID_PEN）／ 👍 通りたい（その道を ×PREFER_K）
let PREFER_K = 0.5;   // 👍 通りたい道の重み（設定 preferK：0.7・0.5・0.3）
let AVOID_PEN = 5;   // ⚠ 通りたくない道の重み（設定 avoidPen：2・5・10・30）
let paintedSet = null, PAINT_PEN = 1;   // 👣 もう塗った道（区間の名前「小さい点の番号-大きい点の番号」）と、その道の重み（設定 paintPen：1＝気にしない）
const BLOCK_R = 12;
let usedNodes = null;   // ぐるっと1周：前の区間で通ったあたり（約180mのマス）。同じ道も、となりの平行な道も通りにくくする
const USED_PEN = 2;
let otherUsed = null;   // 🔄 ちがう道で：前のルートが通ったあたり（約180mのマス）。同じ道・となりの平行な道を 通りにくくする
const OTHER_PEN = 3;
const usedKey = (la, lo) => Math.round(la * 600) + "," + Math.round(lo * 490);   // 約180mのマス
function markUsed(route) {
  for (let i = 0; i < route.length; i++) {
    const [a, b] = route[i]; usedNodes.add(usedKey(a, b));
    if (i + 1 < route.length) { const [c, d] = route[i + 1], n = Math.floor(hav(a, b, c, d) / 40);
      for (let k = 1; k <= n; k++) usedNodes.add(usedKey(a + (c - a) * k / (n + 1), b + (d - b) * k / (n + 1))); }
  }
}
function applyBlocks(lat, lon, adj, N) {
  if (otherUsed && otherUsed.size) {
    const u8 = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (adj[i] && adj[i].length && otherUsed.has(usedKey(lat[i], lon[i]))) u8[i] = 1;
    for (let u = 0; u < N; u++) if (u8[u]) for (const e of adj[u]) if (u8[e.v]) e.c *= OTHER_PEN;
  }
  if (usedNodes && usedNodes.size) {
    const u8 = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (adj[i] && adj[i].length && usedNodes.has(usedKey(lat[i], lon[i]))) u8[i] = 1;
    for (let u = 0; u < N; u++) if (u8[u]) for (const e of adj[u]) if (u8[e.v]) e.c *= USED_PEN;
  }
  if (!blockPts.length && !avoidPts.length && !preferPts.length) return 0;
  const allPts = [...blockPts.map(p => [p[0], p[1], 0]), ...avoidPts.map(p => [p[0], p[1], 1]), ...preferPts.map(p => [p[0], p[1], 2])];
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
  let n = 0; const avoidW = new Set(), preferW = new Set();
  for (const [u, v, p, d] of hits) {
    if (d > dmin.get(p) + 4) continue;
    if (p[2]) { const e = adj[u].find(x => x.v === v); if (e) (p[2] === 2 ? preferW : avoidW).add(e.w); continue; }   // ⚠ 通りたくない／👍 通りたい：その道（OSMの1本）をまるごと
    const before = adj[u].length;
    adj[u] = adj[u].filter(x => x.v !== v); adj[v] = adj[v].filter(x => x.v !== u);
    if (adj[u].length < before) n++;
  }
  if (avoidW.size) { for (let u = 0; u < N; u++) if (adj[u]) for (const e of adj[u]) if (avoidW.has(e.w)) e.c *= AVOID_PEN; n += avoidW.size; }
  if (preferW.size) { for (let u = 0; u < N; u++) if (adj[u]) for (const e of adj[u]) if (preferW.has(e.w)) e.c *= PREFER_K; n += preferW.size; }
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
    const L = joinLegs(parts, pts.map(p => !!p.via));   // 経由地（🎯寄り道スポット）へは、行って同じ道でもどる所もけずらない
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
      // 三角形は「遠まわりして経由地 → まっすぐ帰る」の順（経由地が 半分より後ろ に来るように。着いてひと休みしたら帰るだけ）
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
          await runCand(k === "L" ? "左まわりで経由地へ行って帰る" : "右まわりで経由地へ行って帰る", [W, Vp], ci, plan.length);
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
function joinLegs(parts, keepSpur) {   // keepSpur：行って同じ道で戻る所も消さない（🏁 ぜんぶ回る は駅の前まで行きたいので）。配列なら つなぎ目ごと（[i-1] が i番目のつなぎ目）
  let route = parts[0].route.slice(), ek = (parts[0].ek || []).slice();
  const res = { ok: [], xw: [], ng: [], xvia: [], tp: [], kinds: {}, turns: 0, len: 0 };
  const same = (p, q) => p && q && p[0] === q[0] && p[1] === q[1];
  for (let i = 0; i < parts.length; i++) {
    const P = parts[i];
    if (i) {
      const R2 = P.route, E2 = P.ek || []; let k = 0;
      const keep = Array.isArray(keepSpur) ? keepSpur[i - 1] : keepSpur;
      while (!keep && k + 1 < R2.length && route.length - 2 - k >= 0 && same(route[route.length - 2 - k], R2[1 + k])) k++;
      for (let j = 0; j < k; j++) res.len -= 2 * hav(R2[j][0], R2[j][1], R2[j + 1][0], R2[j + 1][1]);
      route = route.slice(0, route.length - k).concat(R2.slice(1 + k));
      ek = ek.slice(0, ek.length - k).concat(E2.slice(k));
    }
    res.ok.push(...(P.ok || [])); res.xw.push(...(P.xw || [])); res.ng.push(...(P.ng || [])); res.xvia.push(...(P.xvia || [])); if (res.tp && P.tp) res.tp.push(...P.tp); else res.tp = null;
    for (const [k, v] of Object.entries(P.kinds || {})) res.kinds[k] = (res.kinds[k] || 0) + v;
    res.turns += P.turns || 0; res.len += P.len || 0;
  }
  return { ...res, route, ek: ek.length === route.length - 1 ? ek : undefined };
}
// 🏁 ぜんぶ回る：出発 → 点1 → 点2 → … （→ 出発）。順番は画面側で決めてわたす。区間ごとに細道ルートを作ってつなぐ
async function tourRoute(req, prog) {
  const s = req.s, P = req.tour || [], back = !!req.back, cfg = { ...(req.cfg || {}), alts: false }, T0 = Date.now();
  const way = [s, ...P.map(p => [p[0], p[1]])].concat(back ? [s] : []), nl = way.length - 1, parts = [], skip = [];
  log(`==== 🏁 ぜんぶ回る ${P.length}か所${back ? "（出発にもどる）" : ""} ====`, "h");
  usedNodes = new Set();
  try {
    let from = s;
    for (let li = 0; li < nl; li++) {
      const nm = li < P.length ? P[li][2] : "出発";
      log(`--- 区間 ${li + 1}/${nl}：→ ${nm} ---`, "h");
      prog({ msg: `🏁 ${li + 1}/${nl}区間（→ ${nm}）`, frac: li / nl });
      try {
        const r = await route({ ...req, s: from, g: way[li + 1], cfg, loop: undefined, via: undefined, tour: undefined },
          p => { const f = stageFrac(p); prog({ ...p, stage: undefined, msg: `🏁 ${li + 1}/${nl}区間（→ ${nm}）\n` + (p.msg || ""), frac: f == null ? undefined : (li + f) / nl }); }, () => {});
        const e = r.route[r.route.length - 1], dd = hav(e[0], e[1], way[li + 1][0], way[li + 1][1]);
        log(`区間 ${li + 1}：${(r.len / 1000).toFixed(1)}km・${nm}から ${Math.round(dd)}m の道まで`, dd > 150 ? "w" : "ok");
        markUsed(r.route); parts.push(r); from = e;
      } catch (e) { if (stopReq) throw e; log(`区間 ${li + 1}（→ ${nm}）は作れなかったので、とばすよ: ${e.message}`, "w"); skip.push(nm); }
    }
  } finally { usedNodes = null; }
  if (!parts.length) throw new Error("ルートが1区間も作れなかったよ");
  const L = joinLegs(parts, true), sec = (Date.now() - T0) / 1000;
  log(`==== 🏁 完了 ${(L.len / 1000).toFixed(1)}km（${sec.toFixed(1)}秒）${skip.length ? `・とばした所: ${skip.join("、")}` : ""} ====`, "ok");
  return { ...L, stops: P.map((p, i) => ({ p: [p[0], p[1]], kind: "via", name: `${i + 1}. ${p[2]}` })), tour: P.length, skip, sec };
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
// 11/22：点だけでなく 線（点と点のあいだ）までの きょりで いちばん近い道を えらび、その線の 近いほうのはしの点を使う
//   （点の少ない まっすぐな道＝江戸川サイクリングロードなど の上に 出発を置いても、点の多い となりの車道に 吸いよせられていた）
function nearestGood(G, la, lo, sameAs = -1) {
  const C = components(G), min = Math.min(C.big, Math.max(30, C.big * 0.05));
  const kx = Math.cos(la * Math.PI / 180) * 111320, ky = 110540, X = i => (G.lon[i] - lo) * kx, Y = i => (G.lat[i] - la) * ky;
  const okN = i => sameAs >= 0 ? C.root[i] === C.root[sameAs] : C.size.get(C.root[i]) >= min;
  let best = -1, bd = Infinity, any = -1, ad = Infinity;
  for (let i = 0; i < G.lat.length; i++) {
    if (!G.inGraph[i]) continue;
    const d = hav(la, lo, G.lat[i], G.lon[i]);
    if (d < ad) { ad = d; any = i; }
    if (okN(i) && d < bd) { bd = d; best = i; }
  }
  // 線までの きょり（点より 近い線があれば、その線の はしの点にする）
  const R = Math.min(bd, 200); let sb = R, sn = -1;
  for (let u = 0; u < G.lat.length; u++) {
    if (!G.inGraph[u] || !okN(u)) continue;
    const ux = X(u), uy = Y(u); if (Math.abs(ux) > 2000 || Math.abs(uy) > 2000) continue;
    for (const e of G.adj[u]) {
      const v = e.v; if (v < u && G.adj[v].some(f => f.v === u)) continue;   // 両向きの線は 1回だけ
      const vx = X(v), vy = Y(v), dx = vx - ux, dy = vy - uy, L2 = dx * dx + dy * dy; if (!L2) continue;
      const t = Math.max(0, Math.min(1, -(ux * dx + uy * dy) / L2)), px = ux + dx * t, py = uy + dy * t, d = Math.hypot(px, py);
      if (d < sb - 3) { sb = d; sn = t < 0.5 ? u : v; }   // 3m 以上 近いときだけ（ほとんど同じなら 点のほう）
    }
  }
  let seg = 0; if (sn >= 0 && sn !== best) { best = sn; bd = hav(la, lo, G.lat[sn], G.lon[sn]); seg = Math.round(sb); }
  return { seg, n: best, d: bd, nearestAny: any, dAny: ad, size: best >= 0 ? C.size.get(C.root[best]) : 0, anySize: any >= 0 ? C.size.get(C.root[any]) : 0 };
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
      if (e.v === pu) continue;   // その場でUターンしない（大きい道に入って すぐもどると、横断の判定をすりぬけて 4車線を信号なしで渡れてしまう）
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

// 🗣 音声ナビで案内する曲がり角：[lat, lon, 曲がる角度（+右・-左）]
// 道なり（ほかに曲がれる道がない／ルートの道がいちばんまっすぐ）は案内しない
function guideAt(G, path, i) {
  const u = path[i], c = G.cosl, X = j => [(G.lon[path[j]] - G.lon[u]) * c * 111320, (G.lat[path[j]] - G.lat[u]) * 111320];
  const far = (step) => { let j = i, d = 0; while (j + step >= 0 && j + step < path.length && d < 12) { j += step; const [x, y] = X(j); d = Math.hypot(x, y); } return X(j); };
  const [bx, by] = far(-1), [fx, fy] = far(1);   // 12mくらい前・先の点（道の点がこまかくても向きがぶれないように）
  const ix = -bx, iy = -by;                       // 入ってきた向き
  const ang = (x, y) => Math.atan2(ix * y - iy * x, ix * x + iy * y) * -180 / Math.PI;   // +が右
  const a = ang(fx, fy); if (Math.abs(a) < 40) return null;
  const alts = new Set(); for (const e of G.adj[u]) if (e.v !== path[i - 1] && e.v !== path[i + 1]) alts.add(e.v);
  if (!alts.size) return null;                    // 1本道のカーブ
  let straighter = false;
  for (const w of alts) { const b = ang((G.lon[w] - G.lon[u]) * c * 111320, (G.lat[w] - G.lat[u]) * 111320); if (Math.abs(b) < Math.abs(a) + 30) straighter = true; }
  if (!straighter) return null;                   // ルートの道がいちばんまっすぐ＝道なり
  return [G.lat[u], G.lon[u], Math.round(a)];
}

function analyze(G, path) {
  const ok = [], xw = [], ng = [], ngIdx = [], xvia = [], kinds = {}, ek = [], tp = []; let len = 0, turns = 0;
  for (let i = 1; i < path.length; i++) {
    const e = edge(G, path[i - 1], path[i]); len += e.L; kinds[e.k] = (kinds[e.k] || 0) + e.L; ek.push(e.dk ? e.k + "\u0001" + e.dk : e.k);
  }
  for (let i = 1; i < path.length - 1; i++) {
    if (edge(G, path[i - 1], path[i]).w !== edge(G, path[i], path[i + 1]).w && isTurn(G, path[i - 1], path[i], path[i + 1])) turns++;
    { const g = guideAt(G, path, i); if (g) tp.push(g); }
    const u = path[i], L = G.lvl[u]; if (!L || G.cfg.crossRule === "off") continue;   // 渡るルールを使わないときは 横断の印も出さない
    if (path[i - 1] === path[i + 1] || isCrossing(G, path[i - 1], u, path[i + 1], edge(G, path[i - 1], u).l, edge(G, u, path[i + 1]).l, L)) {   // 大きい道の上の Uターンも 渡るのと同じ
      const p = [G.lat[u], G.lon[u]], k = G.xkind[u];
      if (k === 1) ok.push(p); else if (k === 2) xw.push(p);
      else if (G.xcost[u] > 0 || L === 2) { ng.push(p); ngIdx.push(i); }   // ルール違反（または4車線を信号なし）
      if ((k === 1 || k === 2) && G.xdet && G.xdet[u] > 0) { const j = G.xref[u]; xvia.push([G.lat[u], G.lon[u], G.lat[j], G.lon[j], k, Math.round(G.xdet[u])]); }   // 近くの 信号・横断歩道まで行って渡る：[交差点の緯度, 経度, 渡る所の緯度, 経度, 種類 1🚦/2🚸, きょり m]
    }
  }
  return { ok, xw, ng, ngIdx, xvia, kinds, len, ek, turns, tp };
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
// 配布データ v2（小さい形・tools/make_pack.py の enc_v2）→ もとの形（Overpass と同じ elements）。v1 はそのまま
// OSM番号がない点（マスの中だけの点）は -((i*20000+j)*100000+番号)。道は マスごとに きってあるので uid（道の番号~マス）で見分ける
function tileEls(o) {
  if (!o || o.v !== 2) return o ? o.elements : [];
  const [ti, tj] = o.t, base = (ti * 20000 + tj) * 100000, n = o.n.length >> 1, ids = new Array(n), el = [];
  for (let q = 0, k = 0, id = 0; q < o.g.length; q += 2) { k += o.g[q]; id += o.g[q + 1]; ids[k] = id; }
  const nt = new Map(); for (let q = 0, k = 0; q < o.nt.length; q += 2) { k += o.nt[q]; nt.set(k, o.tg[o.nt[q + 1]]); }
  let la = ti * 100000, lo = tj * 100000;   // 1e-7度（マスの左下）
  for (let x = 0; x < n; x++) {
    if (ids[x] === undefined) ids[x] = -(base + x);
    la += o.n[2 * x]; lo += o.n[2 * x + 1];
    const e = { type: "node", id: ids[x], lat: la / 1e7, lon: lo / 1e7 }; const t = nt.get(x); if (t) e.tags = t; el.push(e);
  }
  o.w.forEach((w, wi) => {   // 1本の道が マスの中で何切れかに分かれることもあるので、uid は 何番目かまで入れる
    const nd = new Array(w[2]); let r = w[3]; nd[0] = ids[r];
    for (let k = 4; k < w.length; k++) { r += w[k]; nd[k - 3] = ids[r]; }
    el.push({ type: "way", id: w[0], uid: w[0] + "~" + ti + "_" + tj + "~" + wi, nodes: nd, tags: o.tg[w[1]] });
  });
  return el;
}
const elKey = e => e.type[0] + (e.uid || e.id);   // 同じもの（v2 の道は マスごとに べつ）
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
    const el = tileEls(await unpack(r));
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
// ==== 🚓 警察の交通規制（JARTIC オープンデータ・hosomichi-data/j/。tools/jartic_pack.py で作る） ====
// いまは「歩行者等横断禁止」の線だけ使う：その線にそって走る 2車線の道を 4車線あつかいにする（信号・横断歩道でしか渡らない）
// 端末には保存しない（メモリだけ）。取れないとき（オフラインなど）は 使わない＝前と同じ動き
const jarMem = new Map();   // マスの名前 → { nx: 横断禁止の線 [[[lat, lon], …], …], ow: 一方通行 [{ p: 通ってよい向きの線, b: 1＝自転車は除く, h: 時間 }] }
// 端末にも保存する（道路データとは別の保存場所 hosomichi_jar。オフラインでも使える）。30日より古ければ取りなおす（取れなければ古いのを使う）
const JAR_AGE = 30 * 864e5;
let jarDbp = null;
function jarDB() {
  if (jarDbp) return jarDbp;
  jarDbp = new Promise(ok => {
    if (typeof indexedDB === "undefined") return ok(null);
    try {
      const r = indexedDB.open("hosomichi_jar", 1);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains("j")) db.createObjectStore("j", { keyPath: "key" }); };
      r.onsuccess = () => ok(r.result); r.onerror = () => ok(null);
    } catch { ok(null); }
  });
  return jarDbp;
}
async function jarStore(mode) { const db = await jarDB(); return db ? db.transaction("j", mode).objectStore("j") : null; }
async function jarClear() { try { const st = await jarStore("readwrite"); if (st) await idbReq(st.clear()); } catch {} jarMem.clear(); }
// 時間つき（"0700-0900"）：いまが その時間か（日をまたぐ "2200-0600" も）
let jarHol = new Set();   // 🎌 祝日（アプリが holidays.txt を読んで送ってくる）。祝日は日曜あつかい
function jarNbActive(h, w) {   // w：規制する曜日（"12345" など・getDay の数字）。なければ毎日
  const d = new Date(), ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (w && !w.includes(String(jarHol.has(ymd) ? 0 : d.getDay()))) return false;
  const m = /^(\d{4})-(\d{4})$/.exec(h || ""); if (!m) return true;
  const n = d.getHours() * 100 + d.getMinutes(), a = +m[1], b = +m[2];
  return a <= b ? n >= a && n < b : n >= a || n < b;
}
// JARTIC データの版（hosomichi-data/j/ver.json・jartic_pack.py が作る）。端末に保存したものと版がちがえば 取りなおす（取れなければ ""＝くらべない）
let jarVerP = null;
function jarVer() {
  if (!jarVerP) jarVerP = fetch(`${packBase}j/ver.json`, { cache: "no-cache" }).then(r => r.ok ? r.json() : null).then(j => j && j.v ? String(j.v) : "").catch(() => "");
  return jarVerP;
}
async function jarLoad(names) {   // そのマスたちの JARTIC を読む（メモリ → 端末 → GitHub）→ 取れなかった数
  let bad = 0;
  const ver = await jarVer();
  await Promise.all(names.filter(n => !jarMem.has(n)).map(async n => {
    let old = null;
    try { const st = await jarStore("readonly"); old = st ? await idbReq(st.get(n)) : null; } catch {}
    if (old && old.d && old.d.sig && old.d.xw && old.d.nb && old.d.sw && Date.now() - old.savedAt < JAR_AGE && (!ver || old.ver === ver)) { jarMem.set(n, old.d); return; }   // sig・xw・nb がない＝信号・横断歩道・自転車通行止めを保存する前の古い形 → 取りなおす
    try {
      const res = await fetch(`${packBase}j/${n}.json.gz`, { cache: "no-cache" });   // ブラウザの古いキャッシュを使わない（変わっていなければ すぐ返る）
      let d;
      if (res.status === 404) d = { nx: [], ow: [], sig: [], xw: [], nb: [], sw: [] };
      else {
        if (!res.ok) throw new Error("HTTP " + res.status);
        const b = await res.blob(), h = new Uint8Array(await b.slice(0, 2).arrayBuffer());
        const t = h[0] === 0x1f && h[1] === 0x8b ? await new Response(b.stream().pipeThrough(new DecompressionStream("gzip"))).text() : await b.text();
        const j = JSON.parse(t); d = { nx: j.nx || [], ow: j.ow || [], sig: j.sig || [], xw: j.xw || [], nb: j.nb || [], sw: j.sw || [] };
      }
      jarMem.set(n, d);
      try { const st = await jarStore("readwrite"); if (st) await idbReq(st.put({ key: n, savedAt: Date.now(), ver, d })); } catch {}
    } catch { if (old) jarMem.set(n, old.d); else bad++; }   // 取れない（オフラインなど）：古いのがあれば それを使う
  }));
  return bad;
}
async function jarPrep(bigs, cfg) {   // → そのはんいの { nx: 横断禁止の線, ow: 一方通行 }
  const jarLines = [], jow = [], jsig = [], jxw = [], jnb = [], jsw = [];
  if (!packBase || (cfg && cfg.jarUse === "off")) return { nx: jarLines, ow: jow, sig: jsig, xw: jxw, nb: jnb, sw: jsw };
  const names = [...new Set(bigs.map(packName))], bad = await jarLoad(names);
  const seen = new Set();
  for (const n of names) for (const l of (jarMem.get(n) || {}).nx || []) { const k = JSON.stringify(l[0].concat(l[l.length - 1])); if (!seen.has(k)) { seen.add(k); jarLines.push(l); } }
  for (const n of names) for (const o of (jarMem.get(n) || {}).ow || []) { const k = "o" + JSON.stringify(o.p[0].concat(o.p[o.p.length - 1])); if (!seen.has(k)) { seen.add(k); jow.push(o); } }
  for (const n of names) for (const p of (jarMem.get(n) || {}).sig || []) { const k = "s" + p.join(); if (!seen.has(k)) { seen.add(k); jsig.push(p); } }
  for (const n of names) for (const p of (jarMem.get(n) || {}).xw || []) { const k = "x" + p.join(); if (!seen.has(k)) { seen.add(k); jxw.push(p); } }
  for (const n of names) for (const o of (jarMem.get(n) || {}).nb || []) { if (o.q) continue; const k = "b" + JSON.stringify(o.p[0].concat(o.p[o.p.length - 1])); if (!seen.has(k)) { seen.add(k); jnb.push(o); } }   // q＝たぶん（コードが空っぽ）はまだ使わない
  for (const n of names) for (const o of (jarMem.get(n) || {}).sw || []) { const k = "w" + JSON.stringify(o.p[0].concat(o.p[o.p.length - 1])); if (!seen.has(k)) { seen.add(k); jsw.push(o); } }   // 自転車も通れる歩道（🌉 橋の歩道の判定に使う）
  if (jarLines.length || jow.length || bad) log(`🚓 警察の交通規制：歩行者等横断禁止 ${jarLines.length}本・一方通行 ${jow.length}本${bad ? `（取れなかったマス ${bad}）` : ""}`, bad ? "w" : "ok");
  return { nx: jarLines, ow: jow, sig: jsig, xw: jxw, nb: jnb, sw: jsw };
}
function jarApply(osm, cfg, J) { return sideGap(brApply(jarApply1(osm, cfg, J), J)); }   // 🚓 警察のデータ → 🌉 橋の歩道・出入り口の階段
// 📍 出発・目的地のピンのそばの道の線に、ピンにいちばん近い所の点を足す。
// 道の線は 交差点や曲がる所にしか点がないので、長くまっすぐな線（橋の歩道 約450m など）だと
// 「線の はしの点」まで何百mも飛んでいた。ピンから PIN_R m 以内の線ぜんぶに足す（いちばん近い線が 通れない道でも大丈夫なように）
// 足した点は その道だけの点（ほかの道とは つながらない）なので、ルートの形・交差点は 変わらない
const PIN_R = 40, PIN_END = 3;
let pinId = -8e15;
// 🚶 とぎれた歩道をつなぐ（手で決めた所だけ）：歩道の線の はしが どこにもつながっていない所から、
// となり（15m以内・向きがそろう）の車道ぞいに 次の交差点（SWG_MAX m まで）まで「歩道」の線を足す。車道が 🚳 でも 歩道は通れる。
// 決まりにすると ほかの所のルートも たくさん変わるので、地図に描けない理由がはっきりしている所だけ SWG_AT に書く
const SWG_NEAR = 15, SWG_MAX = 100, SWG_JCT = 30, SWG_CAR = /^(primary|secondary|tertiary|trunk|unclassified|residential|living_street|service)(_link)?$/;
const SWG_AT = [
  [35.745269, 139.823221],   // 堀切小橋（綾瀬川）の歩道 → 堀切がわの信号（約70m）。首都高の真下で 航空写真にもストリートビューにも写らない（ユーザーがいつも通る・11/23）
];
let swgId = -8.5e15;
function sideGap(osm) {
  const pos = new Map(), deg = new Map(), roads = [], grid = new Map();
  for (const e of osm.elements) if (e.type === "node") pos.set(e.id, e);
  for (const e of osm.elements) if (e.type === "way" && e.tags && e.tags.highway && e.nodes) {
    for (const id of e.nodes) deg.set(id, (deg.get(id) || 0) + 1);
    if (SWG_CAR.test(e.tags.highway)) roads.push(e);
  }
  const gk = (la, lo) => Math.floor(la * 2000) + "," + Math.floor(lo * 2000);   // 約55m×45m
  for (const r of roads) for (let i = 1; i < r.nodes.length; i++) {
    const a = pos.get(r.nodes[i - 1]), b = pos.get(r.nodes[i]); if (!a || !b) continue;
    const y0 = Math.floor(Math.min(a.lat, b.lat) * 2000), y1 = Math.floor(Math.max(a.lat, b.lat) * 2000);
    const x0 = Math.floor(Math.min(a.lon, b.lon) * 2000), x1 = Math.floor(Math.max(a.lon, b.lon) * 2000);
    if ((y1 - y0 + 1) * (x1 - x0 + 1) > 400) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = y + "," + x; if (!grid.has(k)) grid.set(k, []); grid.get(k).push([r, i]); }
  }
  const add = [];
  for (const w of osm.elements) {
    if (w.type !== "way" || !w.tags || !w.nodes || w.nodes.length < 2) continue;
    if (!(w.tags.footway === "sidewalk" || w.tags["br:side"])) continue;
    for (const end of [0, 1]) {
      const id = end ? w.nodes[w.nodes.length - 1] : w.nodes[0];
      if ((deg.get(id) || 0) > 1) continue;
      const p = pos.get(id), q = pos.get(end ? w.nodes[w.nodes.length - 2] : w.nodes[1]); if (!p || !q) continue;
      if (!(yes(w.tags.bridge) && w.tags["br:side"]) && !SWG_AT.some(a => hav(a[0], a[1], p.lat, p.lon) < 3)) continue;   // 🌉 橋の上の歩道は 橋のとちゅうで行き止まりにならない（木根川橋）
      const kx = 111320 * Math.cos(p.lat * RAD), ky = 111320;
      const dir = Math.atan2((p.lon - q.lon) * kx, (p.lat - q.lat) * ky);   // 歩道が とぎれる向き
      let best = null;
      const cy = Math.floor(p.lat * 2000), cx = Math.floor(p.lon * 2000), seen = new Set();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const [r, i] of grid.get((cy + dy) + "," + (cx + dx)) || []) {
        const sk = r.id + ":" + i; if (seen.has(sk)) continue; seen.add(sk);
        const a = pos.get(r.nodes[i - 1]), b = pos.get(r.nodes[i]);
        const bx = (b.lon - a.lon) * kx, by = (b.lat - a.lat) * ky, px = (p.lon - a.lon) * kx, py = (p.lat - a.lat) * ky, L2 = bx * bx + by * by;
        if (!L2) continue;
        const t = (px * bx + py * by) / L2; if (t < 0 || t > 1) continue;
        const d = Math.hypot(px - t * bx, py - t * by); if (d > SWG_NEAR) continue;
        const ang = Math.abs(((Math.atan2(bx, by) - dir) * 180 / Math.PI + 540) % 360 - 180);
        if (ang > 30 && ang < 150) continue;                                            // 車道と 向きがそろっていない
        if (!best || d < best.d) best = { d, r, i, fw: ang <= 30 };
      }
      if (!best) {
        // 🌉 橋の歩道で、はしが 交差点のかどに向かって曲がっている所（木根川橋の東のはし）：
        // 車道と向きがそろわないので、SWG_JCT m 以内の 車道の交差点の点（ほかの道とつながる点）に まっすぐつなぐ
        if (!(yes(w.tags.bridge) && w.tags["br:side"])) continue;
        let bj = null, bd = SWG_JCT;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const [r, i] of grid.get((cy + dy) + "," + (cx + dx)) || [])
          for (const nid of [r.nodes[i - 1], r.nodes[i]]) {
            if ((deg.get(nid) || 0) < 2) continue;
            const n = pos.get(nid), d = hav(p.lat, p.lon, n.lat, n.lon);
            if (d < bd) { bd = d; bj = nid; }
          }
        if (bj == null) continue;
        add.push({ type: "way", id: swgId--, nodes: [id, bj], tags: { highway: "footway", footway: "sidewalk", "sw:gap": "1" } });
        continue;
      }
      // 車道ぞいに 歩道が進む向きへ たどって、次の交差点（ほかの道とつながる点）まで
      const r = best.r, step = best.fw ? 1 : -1, nodes = [id];
      let k = best.fw ? best.i : best.i - 1, prev = p, L = 0, ok = false;
      while (k >= 0 && k < r.nodes.length) {
        const n = pos.get(r.nodes[k]); if (!n) break;
        L += hav(prev.lat, prev.lon, n.lat, n.lon); prev = n;
        if (L > SWG_MAX) break;
        if ((deg.get(r.nodes[k]) || 0) > 1) { nodes.push(r.nodes[k]); ok = true; break; }
        const sid = swgId--; add.push({ type: "node", id: sid, lat: n.lat, lon: n.lon }); nodes.push(sid);   // 車道の点とは つながない
        k += step;
      }
      if (!ok) { add.length -= nodes.length - 1; continue; }
      const tg = { highway: "footway", footway: "sidewalk", "sw:gap": "1" };
      if (w.tags["br:side"] && r.tags.bridge) { tg.bridge = r.tags.bridge; tg["br:side"] = "1"; }
      add.push({ type: "way", id: swgId--, nodes, tags: tg });
    }
  }
  return add.length ? { ...osm, elements: osm.elements.concat(add) } : osm;
}
function addPins(osm, pts) {
  pts = (pts || []).filter(p => p && isFinite(p[0]) && isFinite(p[1]));
  if (!pts.length) return osm;
  const pos = new Map();
  for (const e of osm.elements) if (e.type === "node") pos.set(e.id, e);
  const add = [];
  let changed = false;
  const els = osm.elements.map(e => {
    if (e.type !== "way" || !e.tags || !e.tags.highway || !e.nodes || e.nodes.length < 2) return e;
    let nn = null;
    for (let i = 1; i < e.nodes.length; i++) {
      const a = pos.get(e.nodes[i - 1]), b = pos.get(e.nodes[i]);
      if (a && b) {
        const ky = 111320, kx = 111320 * Math.cos(a.lat * RAD);
        const bx = (b.lon - a.lon) * kx, by = (b.lat - a.lat) * ky, L2 = bx * bx + by * by, L = Math.sqrt(L2);
        const ins = [];
        if (L > 2 * PIN_END) for (const p of pts) {
          const px = (p[1] - a.lon) * kx, py = (p[0] - a.lat) * ky;
          const t = (px * bx + py * by) / L2;
          if (t * L < PIN_END || (1 - t) * L < PIN_END) continue;               // はしの点のすぐそばなら はしの点でいい
          if (Math.hypot(px - t * bx, py - t * by) > PIN_R) continue;
          ins.push(t);
        }
        if (ins.length) {
          if (!nn) nn = e.nodes.slice(0, i);
          ins.sort((x, y) => x - y);
          for (const t of ins) { const id = pinId--; add.push({ type: "node", id, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t }); nn.push(id); }
        }
      }
      if (nn) nn.push(e.nodes[i]);
    }
    if (!nn) return e;
    changed = true;
    return { ...e, nodes: nn };
  });
  return changed ? { ...osm, elements: add.concat(els) } : osm;
}
// 🌉 橋の歩道と、その出入り口の階段（11/22）。OSM では 橋の歩道が「歩道橋」と同じ形で、出入り口の階段に スロープの印がないことが多い
// ・車の橋（車の道で bridge）に そって走る（20m以内・同じ向き）歩道・小道の橋 → "br:side"＝橋の歩道（歩道橋あつかいにしない）
// ・橋の歩道が 自転車も走れる（OSM の bicycle=yes/designated/permissive・自転車道・警察のデータの「自転車も通れる歩道」に20m以内でそう）→ "br:bike"
//   自転車可になっていない橋の歩道は、出入り口の階段にスロープがないことが多い（ユーザー）→ 階段のほうは br:bike の歩道からだけ
//   つながった橋の歩道（橋の上・たもとの坂）は どこかが自転車OKなら ぜんぶ・同じ橋の 反対がわの歩道（br:bike の歩道から 50m以内に そって走る）も br:bike にする（船堀橋：北がわだけ bicycle=yes・船堀がわの階段は南がわ）
// ・br:bike の橋の歩道が つながって 合わせて50m以上なら、そこから 歩道・小道・階段を 30m以内で たどって着く 階段（長さは気にしない：土手にそって長いもの・折りかえしもある。階段は きょりに数えずに その先も たどる） → "br:ramp"＝自転車スロープつきとみなす（設定 brSteps。ramp:bicycle=no ははずす）
//   （上葛飾橋・船堀橋・環七の新中川の橋など。じっさいは 自転車を押して上がれるスロープつきが多い）
const BR_HEAD = 40, BR_APPROACH = 600, BR_SIDE_R = 20, BR_PAIR_R = 50, BR_SIDE_MIN = 50, BR_REACH = 30;
function brApproach(els, carBr, ptsOf) {   // → 橋のつづきの坂の線 [[緯度,経度]...] の配列
  const car = els.filter(e => e.type === "way" && e.tags && CAR_ROADS.has(BASE[e.tags.highway] || e.tags.highway));
  const at = new Map(); for (const e of car) for (const id of e.nodes) { if (!at.has(id)) at.set(id, []); at.get(id).push(e); }
  const key = t => t.name || t.ref || "#" + (BASE[t.highway] || t.highway), same = (a, b) => a.tags.name && a.tags.name === b.tags.name || a.tags.ref && a.tags.ref === b.tags.ref || (!a.tags.name && !a.tags.ref && key(a.tags) === key(b.tags));
  const pos = new Map(); for (const e of els) if (e.type === "node") pos.set(e.id, [e.lat, e.lon]);
  const out = [], done = new Set();
  for (const b of carBr) for (const end of [b.nodes[0], b.nodes[b.nodes.length - 1]]) {
    let id = end, L = 0, guard = 0;
    while (guard++ < 20) {
      const here = at.get(id) || [];
      if (L >= BR_HEAD && here.some(w => !same(w, b))) break;   // 交差点（ほかの道とまじわる）。橋のすぐ はし（40m）は 土手の上の道が つながるので 見ない
      const nx = here.filter(w => !yes(w.tags.bridge) && same(w, b) && !done.has(w.id + ":" + id));
      if (nx.length !== 1) break;
      const w = nx[0]; done.add(w.id + ":" + id);
      const ns = w.nodes[0] === id ? w.nodes : w.nodes[w.nodes.length - 1] === id ? w.nodes.slice().reverse() : null; if (!ns) break;
      const line = [pos.get(ns[0])]; let stop = false;
      for (let i = 1; i < ns.length; i++) {
        const a = pos.get(ns[i - 1]), c = pos.get(ns[i]); if (!a || !c) { stop = true; break; }
        L += hav(a[0], a[1], c[0], c[1]); line.push(c);
        if (L > BR_APPROACH || (L >= BR_HEAD && (at.get(ns[i]) || []).some(x => !same(x, b)))) { stop = true; break; }   // 長すぎ・とちゅうの交差点
      }
      if (line.length > 1 && line.every(Boolean)) out.push(line);
      if (stop) break;
      id = ns[ns.length - 1]; done.add(w.id + ":" + id);
    }
  }
  return out;
}
function brApply(osm, J) {
  const els = osm.elements, pos = new Map(); for (const e of els) if (e.type === "node") pos.set(e.id, e);
  const ptsOf = e => e.nodes.map(i => pos.get(i)).filter(Boolean).map(q => [q.lat, q.lon]);
  const carBr = els.filter(e => e.type === "way" && e.tags && CAR_ROADS.has(BASE[e.tags.highway] || e.tags.highway) && yes(e.tags.bridge));
  if (!carBr.length) return osm;
  const p0 = ptsOf(carBr[0])[0]; if (!p0) return osm;
  const M = jarOwMatcher(carBr.map(e => ({ p: ptsOf(e) })).filter(o => o.p.length > 1), p0[0], BR_SIDE_R);
  const isFoot = t => FOOTLIKE.has(t.highway) || t.highway === "cycleway";
  // 🌉 橋のつづきの坂（たもと・11/22）：橋の はしから 同じ道（名前か番号が同じ。どちらもなければ 同じ種類）を、ほかの車の道と まじわる点（交差点）まで たどる（600mまで）。
  //   盛り土・高架の坂には bridge の印がないが、交差点がなく 階段・スロープでしか 下の道と つながらないので 実質 橋（ユーザー）
  const appr = brApproach(els, carBr, ptsOf);
  const MA = appr.length ? jarOwMatcher(appr.map(p => ({ p })), p0[0], BR_SIDE_R) : null;
  const side = new Map();   // 要素の番号 → 長さ（橋の歩道：橋の上 ＋ たもとの坂ぞい）
  for (let k = 0; k < els.length; k++) {
    const e = els[k], t = e.tags;
    if (e.type !== "way" || !t || !isFoot(t) || t.highway === "steps" || t.footway === "crossing" || t.crossing) continue;
    const onBr = yes(t.bridge), onAp = !onBr && MA && (t.footway === "sidewalk" || +t.layer > 0);   // 坂ぞいは 歩道の印か 上の階（下の道ぞいの小道を まちがえないように）
    if (!onBr && !onAp) continue;
    const pts = ptsOf(e); if (pts.length < 2 || !(onBr ? M(pts) : MA(pts))) continue;
    let L = 0; for (let i = 1; i < pts.length; i++) L += hav(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    side.set(k, L);
  }
  if (!side.size) return osm;
  const SW = J && J.sw && J.sw.length ? jarOwMatcher(J.sw, p0[0], BR_SIDE_R) : null, bike = new Set();
  for (const k of side.keys()) { const t = els[k].tags; if (["yes", "designated", "permissive"].includes(t.bicycle) || t.highway === "cycleway" || (SW && SW(ptsOf(els[k])))) bike.add(k); }
  // つながった 橋の歩道（橋の上と たもと）は どこかが 自転車OKなら ぜんぶ（流山橋の南の歩道 28436334 ← たもとの 290530184）
  const spread = () => { const nb = new Map(); for (const k of side.keys()) for (const id of els[k].nodes) { if (!nb.has(id)) nb.set(id, []); nb.get(id).push(k); }
    const st = [...bike]; while (st.length) { const k = st.pop(); for (const id of els[k].nodes) for (const j of nb.get(id)) if (!bike.has(j) && els[j].tags.bicycle !== "no") { bike.add(j); st.push(j); } } };
  spread();
  // 同じ橋の 反対がわの歩道も（標識は たいてい両がわにある）：自転車も走れる 橋の歩道から 50m以内に そって走る 橋の歩道
  if (bike.size && bike.size < side.size) {
    const BM = jarOwMatcher([...bike].map(k => ({ p: ptsOf(els[k]) })), p0[0], BR_PAIR_R);
    for (const k of side.keys()) if (!bike.has(k) && els[k].tags.bicycle !== "no" && BM(ptsOf(els[k]))) bike.add(k);
    spread();
  }
  // つながった 橋の歩道の まとまりの長さ
  const par = new Map(), find = x => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  const nodeW = new Map();
  for (const k of bike) { par.set(k, k); for (const id of els[k].nodes) { if (nodeW.has(id)) par.set(find(k), find(nodeW.get(id))); else nodeW.set(id, k); } }
  const grpL = new Map(); for (const k of bike) { const L = side.get(k); grpL.set(find(k), (grpL.get(find(k)) || 0) + L); }
  // 歩道・小道・階段のつながり（点 → [道の番号]）
  const adj = new Map();
  for (let k = 0; k < els.length; k++) { const e = els[k]; if (e.type !== "way" || !e.tags || !isFoot(e.tags) || e.tags.bicycle === "no") continue; for (const id of e.nodes) { if (!adj.has(id)) adj.set(id, []); adj.get(id).push(k); } }
  const wayLenK = k => { const p = ptsOf(els[k]); let L = 0; for (let i = 1; i < p.length; i++) L += hav(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]); return L; };
  const dist = new Map(), q = [], ramp = new Set();
  for (const k of bike) if (grpL.get(find(k)) >= BR_SIDE_MIN) for (const id of els[k].nodes) if (!dist.has(id)) { dist.set(id, 0); q.push(id); }
  while (q.length) {   // 小さい数なので ふつうの列で（きょりが へったら 入れなおす）
    const id = q.shift(), d0 = dist.get(id);
    for (const k of adj.get(id) || []) {
      if (side.has(k)) continue;
      const e = els[k], st = e.tags.highway === "steps", L = wayLenK(k);
      if (d0 + L > BR_REACH && !st) continue;
      if (st) ramp.add(k);
      const d1 = st ? d0 : d0 + L;   // 階段は きょりに数えない（折りかえしの階段・マスの さかいで 切れた 階段の つづきも たどれるように：船堀橋の船堀がわ）
      for (const j of [e.nodes[0], e.nodes[e.nodes.length - 1]]) if (!dist.has(j) || dist.get(j) > d1) { dist.set(j, d1); q.push(j); }
    }
  }
  { const rid = new Set([...ramp].map(k => els[k].id)); els.forEach((e, k) => { if (e.type === "way" && rid.has(e.id) && e.tags && e.tags.highway === "steps") ramp.add(k); }); }   // マスの さかいで 切れた 同じ階段（同じ番号）は ぜんぶ
  const out = els.slice();
  for (const k of side.keys()) out[k] = { ...out[k], tags: { ...out[k].tags, "br:side": "1", ...(bike.has(k) ? { "br:bike": "1" } : {}) } };
  for (const k of ramp) if (out[k].tags["ramp:bicycle"] !== "no") out[k] = { ...out[k], tags: { ...out[k].tags, "br:ramp": "1" } };
  log(`🌉 橋の歩道 ${side.size}本（自転車も走れる ${bike.size}本）・出入り口の階段 ${ramp.size}本`);
  return { ...osm, elements: out };
}
function jarApply1(osm, cfg, J) {
  const o = jarApply0(osm, cfg, J);
  if (!J || (cfg && cfg.jarUse === "off") || !((J.sig && J.sig.length) || (J.xw && J.xw.length))) return o;
  const add = new Map(), n = { snap: 0, amb: 0, btn: 0, mid: 0 };   // 点の番号 → { "jar:sig": …, "jar:xw": … }
  const mark = (r, key) => { for (const x of r) if (x.tag && x.tag.length) { n[x.t]++; for (const id of x.tag) add.set(id, { ...(add.get(id) || {}), [key]: x.t }); } };
  if (J.sig && J.sig.length) mark(jarSigClassify(o.elements, J.sig, cfg), "jar:sig");
  if (J.xw && J.xw.length) mark(jarXwClassify(o.elements, J.xw, cfg), "jar:xw");
  if (!add.size) return o;
  log(`🚦 警察の信号を足す：交差点 ${n.snap + n.amb}（近いほうにつけた ${n.amb}）・押しボタンなど ${n.btn}／🚸 道のとちゅうの横断歩道 ${n.mid}`);
  return { ...o, elements: o.elements.map(e => e.type === "node" && add.has(e.id) ? { ...e, tags: { ...(e.tags || {}), ...add.get(e.id) } } : e) };
}
// 🚓 一方通行の線にあてる関数を作る：pts（道の点）→ { dir: +1 同じ向き / -1 反対, b: 1 自転車は除く } か null
// 10mおきの点が 12m以内・同じ向き（±30°）か反対向きの線にあたり、長さの半分以上あたれば「この道」
function jarOwMatcher(jow, lat0, RR = 12) {
  if (!jow || !jow.length) return null;
  const c0 = Math.cos((lat0 || 35) * RAD), XY = (la, lo) => [lo * c0 * 111320, la * 111320], GS = 25, jg = new Map();
  for (const o of jow) for (let k = 1; k < o.p.length; k++) {
    const A = XY(...o.p[k - 1]), B = XY(...o.p[k]), sg = [A, B, o];
    for (let x = Math.floor(Math.min(A[0], B[0]) / GS) - 1; x <= Math.floor(Math.max(A[0], B[0]) / GS) + 1; x++)
      for (let y = Math.floor(Math.min(A[1], B[1]) / GS) - 1; y <= Math.floor(Math.max(A[1], B[1]) / GS) + 1; y++) { const q = x + "," + y; if (!jg.has(q)) jg.set(q, []); jg.get(q).push(sg); }
  }
  return pts => {
    let all = 0, hit = 0, dir = 0, bk = 0;
    for (let k = 1; k < pts.length; k++) {
      const A = XY(...pts[k - 1]), B = XY(...pts[k]), len = Math.hypot(B[0] - A[0], B[1] - A[1]), ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
      for (let dd = Math.min(5, len / 2); dd < len; dd += 10) {
        const u = dd / len, x = A[0] + (B[0] - A[0]) * u, y = A[1] + (B[1] - A[1]) * u; all++;
        let best = null, bd = RR;
        for (const [P, Q, o] of jg.get(Math.floor(x / GS) + "," + Math.floor(y / GS)) || []) {
          const dx = Q[0] - P[0], dy = Q[1] - P[1], L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - P[0]) * dx + (y - P[1]) * dy) / L)), d = Math.hypot(P[0] + t * dx - x, P[1] + t * dy - y);
          if (d > bd) continue;
          const da = Math.abs(((ang - Math.atan2(dy, dx)) / RAD + 540) % 360 - 180);
          if (da < 30) { bd = d; best = [1, o]; } else if (da > 150) { bd = d; best = [-1, o]; }
        }
        if (best) { hit++; dir += best[0]; if (best[1].b) bk++; }
      }
    }
    return all && hit >= all * 0.5 ? { dir: dir >= 0 ? 1 : -1, b: bk * 2 >= hit ? 1 : 0 } : null;
  };
}
// 横断禁止の線にそって走る 2車線（レベル1）の道に "jar:nx" の印（もとの道は書きかえない。印をつけた道だけ 新しく作る）
// 一方通行の線にあう 車の道に "jar:ow"（"1"＝道の向き / "-1"＝反対の向き）と "jar:owb"（"1"＝自転車は除く）
function jarApply0(osm, cfg, J) {
  const jnb = J && J.nb || [];
  if (!J || (!J.nx.length && !J.ow.length && !jnb.length) || (cfg && cfg.jarUse === "off")) return osm;
  const jarLines = J.nx;
  const lat0 = J.nx.length ? J.nx[0][0][0] : J.ow.length ? J.ow[0].p[0][0] : jnb[0].p[0][0], owM = jarOwMatcher(J.ow, lat0);
  // 🚳 自転車通行止め（JARTIC の 通行止め・車両通行止め で 自転車にかかるもの）：線にそう 車の道に "jar:nb"
  //    "1"＝一日中・"ta"＝時間つきで いま（ルートを作るとき）規制中 → 通らない / "t"＝時間つきで いまは時間外 → ふつうに通る（走っているあいだにアプリが知らせる）。
  //    歩道（footway・path など）には つけない＝となりの歩道は ふつうに通れる（上葛飾橋など）
  // 🚶 歩行者用道路（k=1）も同じ（自転車も入れない）。b に k を入れて、あたった道に "jar:nbk"="pw"
  const kb = o => ({ p: o.p, b: o.k === 1 ? 1 : 0 }), tm = o => o.h || o.w;
  const nbAll = jarOwMatcher(jnb.filter(o => !tm(o)).map(kb), lat0), nbNow = jarOwMatcher(jnb.filter(o => tm(o) && jarNbActive(o.h, o.w)).map(kb), lat0), nbTime = jarOwMatcher(jnb.filter(o => tm(o) && !jarNbActive(o.h, o.w)).map(kb), lat0);
  const c0 = Math.cos((lat0 || 35) * RAD), XY = (la, lo) => [lo * c0 * 111320, la * 111320], GS = 25, grid = new Map();
  for (const l of jarLines) for (let k = 1; k < l.length; k++) {
    const A = XY(l[k - 1][0], l[k - 1][1]), B = XY(l[k][0], l[k][1]), sg = [A, B];
    for (let x = Math.floor(Math.min(A[0], B[0]) / GS) - 1; x <= Math.floor(Math.max(A[0], B[0]) / GS) + 1; x++)
      for (let y = Math.floor(Math.min(A[1], B[1]) / GS) - 1; y <= Math.floor(Math.max(A[1], B[1]) / GS) + 1; y++) { const key = x + "," + y; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(sg); }
  }
  const hit = (x, y, ang) => {
    for (const [A, B] of grid.get(Math.floor(x / GS) + "," + Math.floor(y / GS)) || []) {
      const dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - A[0]) * dx + (y - A[1]) * dy) / L));
      if (Math.hypot(A[0] + t * dx - x, A[1] + t * dy - y) > 15) continue;
      const da = Math.abs(((ang - Math.atan2(dy, dx)) / RAD + 540) % 360 - 180);
      if (da < 30 || da > 150) return true;   // 同じ向き（そっている）
    }
    return false;
  };
  const pos = new Map(); for (const e of osm.elements) if (e.type === "node") pos.set(e.id, e);
  let n = 0, nOw = 0, nOwB = 0;
  const els0 = !owM ? osm.elements : osm.elements.map(e => {   // 一方通行
    if (e.type !== "way" || !e.tags || !e.tags.highway || e.tags["jar:ow"] || !CAR_ROADS.has(BASE[e.tags.highway] || e.tags.highway)) return e;
    const pts = e.nodes.map(i => pos.get(i)).filter(Boolean).map(q => [q.lat, q.lon]); if (pts.length < 2) return e;
    const m = owM(pts); if (!m) return e;
    nOw++; if (m.b) nOwB++;
    return { ...e, tags: { ...e.tags, "jar:ow": m.dir > 0 ? "1" : "-1", "jar:owb": m.b ? "1" : "0" } };
  });
  if (nOw) log(`🚓 一方通行を警察のデータで: ${nOw}本（自転車は除く ${nOwB}本）`);
  let nNb = 0, nNbT = 0;
  const els1 = !(nbAll || nbNow || nbTime) ? els0 : els0.map(e => {
    if (e.type !== "way" || !e.tags || !e.tags.highway || e.tags["jar:nb"] || !CAR_ROADS.has(BASE[e.tags.highway] || e.tags.highway)) return e;
    const pts = e.nodes.map(i => pos.get(i)).filter(Boolean).map(q => [q.lat, q.lon]); if (pts.length < 2) return e;
    const pk = m => m.b ? { "jar:nbk": "pw" } : {};
    let m;
    if (nbAll && (m = nbAll(pts))) { nNb++; return { ...e, tags: { ...e.tags, "jar:nb": "1", ...pk(m) } }; }
    if (nbNow && (m = nbNow(pts))) { nNb++; return { ...e, tags: { ...e.tags, "jar:nb": "ta", ...pk(m) } }; }
    if (nbTime && (m = nbTime(pts))) { nNbT++; return { ...e, tags: { ...e.tags, "jar:nb": "t", ...pk(m) } }; }
    return e;
  });
  // 線には高さがないので、橋のすぐ横・下を通る 格の低い道（側道など）にも あたってしまう →
  // あたった道どうしで、もっと格の高い道が すぐ横（15m以内）に そっていたら、低いほうの印は はずす
  if (nNb || nNbT) {
    const RK = { trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1, residential: 1 }, rk = t => RK[BASE[t.highway] || t.highway] || 0;
    const hitW = els1.filter(e => e.type === "way" && e.tags && e.tags["jar:nb"]);
    const segs = hitW.map(e => ({ e, r: rk(e.tags), p: e.nodes.map(i => pos.get(i)).filter(Boolean).map(q => XY(q.lat, q.lon)) }));
    const near = (P, w) => { for (let k = 1; k < w.p.length; k++) { const A = w.p[k - 1], B = w.p[k], dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L)); if (Math.hypot(A[0] + t * dx - P[0], A[1] + t * dy - P[1]) < 15) return true; } return false; };
    const drop = new Set();
    for (const w of segs) for (const v of segs) if (v.r > w.r && v.e !== w.e && w.p.filter(P => near(P, v)).length * 2 >= w.p.length) { drop.add(w.e); break; }
    if (drop.size) for (let k = 0; k < els1.length; k++) if (drop.has(els1[k])) { const { "jar:nb": _, "jar:nbk": _k, ...t } = els1[k].tags; els1[k] = { ...els1[k], tags: t }; if (_ === "t") nNbT--; else nNb--; }
  }
  // 🚳 自転車通行止めの橋・トンネルにそった 歩道（footway・path の橋）は「歩道橋」あつかいにしない（そこを通るのが きまり。上葛飾橋など）
  let nSide = 0;
  if (nNb) {
    const nbW = els1.filter(e => e.type === "way" && e.tags && (e.tags["jar:nb"] === "1" || e.tags["jar:nb"] === "ta") && (yes(e.tags.bridge) || yes(e.tags.tunnel)));
    const nbM = nbW.length ? jarOwMatcher(nbW.map(e => ({ p: e.nodes.map(i => pos.get(i)).filter(Boolean).map(q => [q.lat, q.lon]) })), lat0) : null;
    if (nbM) for (let k = 0; k < els1.length; k++) {
      const e = els1[k];
      if (e.type !== "way" || !e.tags || !FOOTLIKE.has(e.tags.highway) || e.tags.highway === "steps" || !(yes(e.tags.bridge) || yes(e.tags.tunnel))) continue;
      const pts = e.nodes.map(i => pos.get(i)).filter(Boolean).map(q => [q.lat, q.lon]);
      if (pts.length > 1 && nbM(pts)) { els1[k] = { ...e, tags: { ...e.tags, "jar:nbside": "1" } }; nSide++; }
    }
  }
  if (nNb || nNbT) log(`🚳 自転車通行止め（警察のデータ）: ${nNb}本（いま規制中）・時間外 ${nNbT}本${nSide ? `（となりの歩道 ${nSide}本）` : ""}`);
  if (!jarLines.length) return els1 === osm.elements ? osm : { ...osm, elements: els1 };
  const els = els1.map(e => {
    if (e.type !== "way" || !e.tags || !e.tags.highway || e.tags["jar:nx"] || levelOf(e.tags, { ...cfg, jarUse: "off" }) !== 1) return e;
    let all = 0, ok = 0;
    for (let k = 1; k < e.nodes.length; k++) {
      const a = pos.get(e.nodes[k - 1]), b = pos.get(e.nodes[k]); if (!a || !b) continue;
      const A = XY(a.lat, a.lon), B = XY(b.lat, b.lon), len = Math.hypot(B[0] - A[0], B[1] - A[1]), ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
      for (let dd = Math.min(5, len / 2); dd < len; dd += 10) { const u = dd / len; all++; if (hit(A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u, ang)) ok++; }
    }
    if (!all || ok < all * 0.5) return e;
    n++; return { ...e, tags: { ...e.tags, "jar:nx": "1" } };
  });
  if (n) log(`🚓 横断禁止の道を 4車線あつかいに: ${n}本`);
  return { ...osm, elements: els };
}
// ==== 配布データ（GitHub Pages に置いた道路データ。Overpass にアクセスしないですむ） ====
// 形式: <base>index.json（{v:日付, keys:["緯度番号_経度番号", ...]}）と <base>t/緯度番号_経度番号.json.gz（大きいマス 0.01°）
let packBase = null, packIdx = null, packV = 0, packAt = 0, packBytes = 0, packId = "", packEmpty = null, packAreas = [], packAreaE = [];
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
    packAreas = Object.values(j.areas || {}); packAreaE = Object.entries(j.areas || {});
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
  const el = tileEls(json);
  mem.set(big, el);
  return { el, bytes: blob.size };
}
// 📍 一方通行の矢印用：見えている範囲の一方通行の道（端末にある道路データか配布データだけ。サーバーには取りにいかない）
// 📍長押し「このあたりの🪜⛰を見る」：見えている範囲の道（端末か配布データにあるものだけ）と標高で、階段？・急坂？をさがす
async function slopeView(bb) {
  const [S, W, N, E] = bb, T = 0.01, keys = [];
  for (let i = Math.floor(S / T); i <= Math.floor(N / T); i++) for (let j = Math.floor(W / T); j <= Math.floor(E / T); j++) keys.push(`0.01:${i},${j}`);
  if (keys.length > 36) return { tooWide: true };
  const els = [], seen = new Set(), have = new Set(); let miss = 0;
  for (const k of keys) {
    let el = mem.get(k);
    if (!el) { const r = await getTileAny(k); if (r) el = r.el; }
    if (!el) { try { if (await packHas(k)) el = (await packTile(k)).el; } catch {} }
    if (!el) { miss++; continue; }
    for (const e of el) { const q = elKey(e); if (!seen.has(q)) { seen.add(q); els.push(e); } }
  }
  if (!els.length) return { st: 0, sl: 0, miss };
  const ok = await loadDem([S, W], [N, E], 0.002).catch(() => false);
  await loadStairsAI();
  if (!ok || isNaN(heightAt((S + N) / 2, (W + E) / 2))) return { noDem: true, miss };
  const G = buildGraph({ elements: els }, DEFAULT_CFG), r = applySlope(G, 0, 1, 1, true);
  return { st: r.st, sl: r.sl, miss };
}
// 🧪 道のデータを見る：保存してあるデータだけで、いま見ている範囲の 道（線）・信号/横断歩道（点）・大きい道を渡る判定 を返す
// 🌐 はんい（公園・団地・駐車場など）を 画面の中だけ（道のデータは いらない）
async function areasIn(S, W, N, E, max) {
  try { await loadAreas(); } catch {}
  const areas = [];
  if (areaGrids) for (const kind of Object.keys(areaGrids)) {
    const g = areaGrids[kind], got = new Set();
    for (let i = Math.floor(S * 100); i <= Math.floor(N * 100); i++) for (let k = Math.floor(W * 100); k <= Math.floor(E * 100); k++)
      for (const P of g.get(i + "," + k) || []) {
        if (got.has(P) || P.n < S || P.s > N || P.e < W || P.w > E) continue;
        got.add(P); if (areas.length < max) areas.push({ k: kind, pts: P.pts });
      }
  }
  return areas;
}
// opt.only：🚲🟩 だけ（道のデータ全部はいらない・自転車レーンの道だけ）／opt.wide：🔭 縮小しても出す（マスを 100 まで）
async function dbgView(bb, cfg, opt) {
  opt = opt || {};
  const [S, W, N, E] = bb, T = 0.01, keys = [];
  for (let i = Math.floor(S / T); i <= Math.floor(N / T); i++) for (let j = Math.floor(W / T); j <= Math.floor(E / T); j++) keys.push(`0.01:${i},${j}`);
  const maxK = opt.maxK || (opt.wide ? 100 : 9);   // opt.maxK：app が 「いつも」のとき（パソコンなら）大きくする
  if (opt.only) {   // 🚲 自転車レーン・ナビラインの道と 🟩 はんいだけ（判定の計算はしない）
    const areas = opt.area ? await areasIn(S, W, N, E, opt.wide ? 4000 : 800) : [];
    if (!opt.bike && !opt.riv) return { only: true, ways: [], pts: [], xs: [], areas };
    if (keys.length > maxK) return { only: true, ways: [], pts: [], xs: [], areas, bikeTooWide: true };
    const nd = new Map(), ws = [], seen = new Set(); let miss = 0;
    const RV = opt.riv ? await rivPrep(S, W, N, E) : null, rvOn = RV && RV.n > 0;   // 〰 小河川の川べりの 車の来ない道
    const BLK = ["cycleway", "cycleway:both", "cycleway:left", "cycleway:right"];
    for (const k of keys) {
      let el = mem.get(k);
      if (!el) { const r = await getTileAny(k); if (r) el = r.el; }
      if (!el) { try { if (await packHas(k)) el = (await packTile(k)).el; } catch {} }
      if (!el) { miss++; continue; }
      for (const e of el) {
        if (e.type === "node") nd.set(e.id, e);
        else if (e.type === "way" && e.tags && e.tags.highway) {
          const bk = opt.bike && (BLK.some(x => e.tags[x] && e.tags[x] !== "no" && e.tags[x] !== "separate")
            || e.tags.highway === "cycleway" || e.tags.bicycle === "designated" || (+e.tags.maxspeed > 0 && +e.tags.maxspeed <= 30));   // 🚲 自転車レーン・ナビライン・自転車道・30km制限
          const rq = rvOn && rivOK(e.tags);   // 🚓 警察のデータは このあと あてて もう一度見る
          if (bk || rq) { const q = elKey(e); if (!seen.has(q)) { seen.add(q); ws.push([e, bk, rq]); } }
        }
      }
    }
    if (rvOn && ws.some(w => w[2])) try {   // 🚓 警察のデータ（自転車通行止め・歩行者用道路）を 川べりの候補の道にあてる
      const J = await jarPrep(keys, cfg), cw = ws.filter(w => w[2]).map(w => w[0]), need = new Set(cw.flatMap(e => e.nodes));
      const o = jarApply0({ elements: [...[...need].map(id => nd.get(id)).filter(Boolean), ...cw] }, cfg, J), nt = new Map();
      for (const e of o.elements) if (e.type === "way") nt.set(elKey(e), e.tags || {});
      for (const w of ws) if (w[2]) w[2] = rivOK(nt.get(elKey(w[0])) || w[0].tags);
    } catch {}
    const r6 = x => +x.toFixed(6), ways = [];
    for (const [e, bk, rq] of ws) {
      const p = e.nodes.map(id => nd.get(id)).filter(Boolean); if (p.length < 2 || ways.length >= (opt.maxW || 8000)) continue;
      const pts = p.map(q => [r6(q.lat), r6(q.lon)]), r = rq ? rivWay(RV, pts) : null;
      if (!bk && !r) continue;
      ways.push({ id: e.id, pts, t: e.tags, lv: levelOf(e.tags, cfg), use: true, bk, ...(r ? { rv: r.rv, rn: r.rn } : {}) });
    }
    return { only: true, ways, pts: [], xs: [], areas, miss };
  }
  if (keys.length > maxK) return { tooWide: true };
  const els = [], seen = new Set(), have = new Set(); let miss = 0;
  for (const k of keys) {
    let el = mem.get(k);
    if (!el) { const r = await getTileAny(k); if (r) el = r.el; }
    if (!el) { try { if (await packHas(k)) el = (await packTile(k)).el; } catch {} }
    if (!el) { miss++; continue; }
    for (const e of el) { const q = elKey(e); if (!seen.has(q)) { seen.add(q); els.push(e); } }
  }
  const areas = opt.area ? await areasIn(S, W, N, E, 800) : [];   // 🟩 公園・団地・駐車場などの はんい
  if (!els.length) return { miss, ways: [], pts: [], xs: [], areas };
  cfg = { ...DEFAULT_CFG, ...(cfg || {}), pen: { ...DEFAULT_CFG.pen, ...((cfg && cfg.pen) || {}) } };
  try { const J = jarApply({ elements: els }, cfg, await jarPrep(keys, cfg)).elements; if (J !== els) { els.length = 0; for (const e of J) els.push(e); } } catch {}   // 🚓 横断禁止の道に印（印がないときは そのまま）
  let RVd = null; try { RVd = await rivPrep(S, W, N, E); } catch {}   // 〰 川べり（公園の中の判定も ルートと同じに）
  const G = buildGraph({ elements: els }, { ...cfg, _dbg: true, _riv: RVd });   // _dbg：道ごとの「通る／通らない（理由）」をメモしてもらう（ルートの計算と同じ判定）
  const m = 0.0004, inB = (a, o) => a > S - m && a < N + m && o > W - m && o < E + m, r6 = x => +x.toFixed(6);
  const ways = [], pts = [], xs = [];
  for (const e of els) {
    if (e.type !== "way" || !e.tags || !e.tags.highway) continue;
    const nd = e.nodes.map(id => G.idx.get(id)).filter(x => x !== undefined); if (nd.length < 2 || !nd.some(i => inB(G.lat[i], G.lon[i]))) continue;
    if (ways.length >= (opt.maxW || 1500)) break;   // opt.maxW：app が「いつも」のとき（パソコンなら）大きくする
        const u = G.dbgW && G.dbgW.get(e.uid || e.id) || { use: false, r: "道のつながりがない" };
    const mi = nd[nd.length >> 1], pk = areaHas("park", G.lat[mi], G.lon[mi]) || (nd.length > 2 && areaHas("park", G.lat[nd[0]], G.lon[nd[0]]) && areaHas("park", G.lat[nd[nd.length - 1]], G.lon[nd[nd.length - 1]]));   // pk：公園の囲みの中（河川敷の公園なら 川べり）
    ways.push({ id: e.id, pts: nd.map(i => [r6(G.lat[i]), r6(G.lon[i])]), t: e.tags, lv: levelOf(e.tags, cfg), use: u.use, why: u.r, up: isUnpaved(e.tags), pk });   // up：砂利・土 "sure"／舗装かわからない "maybe"
  }
  for (const [i, t] of G.ntags) {
    if (!inB(G.lat[i], G.lon[i])) continue;
    const sg = t.highway === "traffic_signals" || t.crossing === "traffic_signals" || t["crossing:signals"] === "yes" || t["jar:sig"], cw = t.highway === "crossing" || !!t["jar:xw"];
    const um = cw && ["unmarked", "informal", "no"].includes(t.crossing);   // しま模様のない渡る所（unmarked・informal）・渡れない所（no）：横断歩道としては数えない
    const k = um ? "um" : sg && cw ? "both" : sg ? "sig" : cw ? "xw" : null;   // both：信号つきの横断歩道（半分緑・半分青で描く）
    if (k && pts.length < (opt.maxP || 600)) pts.push({ id: G.ids[i], p: [r6(G.lat[i]), r6(G.lon[i])], t, k });
  }
  for (let i = 0; i < G.lat.length; i++) {
    if (G.cfg.crossRule === "off" || !G.lvl[i] || !G.inGraph[i] || !inB(G.lat[i], G.lon[i]) || new Set((G.adj[i] || []).map(e => e.v)).size < 3) continue;   // 大きい道の上の 交差点（ちがう3方向以上。同じ区間が重なった線は1つに数える）
    const j = G.xref[i];
    if (xs.length < 600) xs.push({ id: G.ids[i], p: [r6(G.lat[i]), r6(G.lon[i])], lv: G.lvl[i], k: G.xkind[i], c: Math.round(G.xcost[i]), dv: G.divided ? G.divided[i] : 0, det: G.xdet ? Math.round(G.xdet[i]) : 0, ref: j >= 0 ? [r6(G.lat[j]), r6(G.lon[j])] : null });
  }
  return { miss, ways, pts, xs, areas };
}
async function onewayIn(bb) {
  const [S, W, N, E] = bb, T = 0.01, keys = [];
  for (let i = Math.floor(S / T); i <= Math.floor(N / T); i++) for (let j = Math.floor(W / T); j <= Math.floor(E / T); j++) keys.push(`0.01:${i},${j}`);
  if (keys.length > 30) return { ways: [], tooWide: true };
  const nodes = new Map(), ways = [], seen = new Set(), cand = [];
  // 🚓 警察の一方通行（JARTIC）：線分を 25m マスに
  const jow = [];
  if (packBase && DEFAULT_CFG.jarUse !== "off") {
    try {
      const names = [...new Set(keys.map(packName))]; await jarLoad(names);
      const sk = new Set();
      for (const n of names) for (const o of (jarMem.get(n) || {}).ow || []) { const q = JSON.stringify(o.p[0].concat(o.p[o.p.length - 1])); if (!sk.has(q)) { sk.add(q); jow.push(o); } }
    } catch {}
  }
  const jarMatch = jarOwMatcher(jow, (S + N) / 2) || (() => null), jgN = jow.length;
  for (const k of keys) {
    let el = mem.get(k);
    if (!el) { const r = await getTileAny(k); if (r) el = r.el; }
    if (!el) { try { if (await packHas(k)) el = (await packTile(k)).el; } catch {} }
    if (!el) continue;
    for (const e of el) if (e.type === "node") nodes.set(e.id, [e.lat, e.lon]);
    for (const e of el) if (e.type === "way" && e.tags && e.tags.highway && !seen.has(e.uid || e.id)) { seen.add(e.uid || e.id); cand.push(e); }
  }
  let nJ = 0, nAdd = 0, nRev = 0;
  for (const e of cand) {
    const t = e.tags, ow = t.oneway, osmOw = ["yes", "1", "true", "-1"].includes(ow);
    if (!osmOw && (!jgN || ow === "no" || !CAR_ROADS.has(BASE[t.highway] || t.highway))) continue;   // OSMで一方通行でない道は、車の道だけ JARTIC を見る
    let pts = e.nodes.map(n => nodes.get(n)).filter(Boolean); if (pts.length < 2) continue;
    if (ow === "-1") pts = pts.reverse();
    if (!pts.some(p => p[0] > S && p[0] < N && p[1] > W && p[1] < E)) continue;
    let free = t["oneway:bicycle"] === "no" ? 1 : 0, src = 0;   // free 1 = 自転車は両方向OK / src 1 = 警察のデータで決めた
    const m = jarMatch(pts);
    if (m) {
      nJ++; src = 1; free = m.b;
      if (m.dir < 0) { pts = pts.reverse(); if (osmOw) nRev++; }   // 向きは 警察のデータを優先
      if (!osmOw) nAdd++;
    } else if (!osmOw) continue;
    ways.push([pts.map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]), free, src]);   // [線, 1 = 自転車は両方向OK, 1 = 警察のデータ]
  }
  return { ways, jar: { n: nJ, add: nAdd, rev: nRev } };
}
// 🚦 警察の信号（JARTIC）を OSM の道にあてる（tag の点に "jar:sig" をつける＝ルートで信号として使う）
// ・30m以内に OSM の信号がある → "osm"（もうある。何もしない）
// ・20m以内の 交差点（車の道が2本以上・1本は2車線以上）を 12mでまとめて 1かたまり → "snap"（そのかたまりの点につける）
// ・2かたまり以上 → "amb"（いちばん近いかたまりにつける）
// ・交差点がない → "btn"（押しボタン信号など。20m以内の 2車線以上の道の いちばん近い点につける）／ 道もない → "none"（使わない）
const JSIG_OSM = 30, JSIG_SNAP = 20, JSIG_CL = 12;
const JSIG_ROADS = new Set(["residential", "unclassified", "living_street", "tertiary", "secondary", "primary", "trunk"]);
function jarSigClassify(els, sigs, cfg) {
  const node = new Map(), cnt = new Map(), big = new Set(), osmSig = [];
  for (const e of els) if (e.type === "node") {
    node.set(e.id, e); const t = e.tags || {};
    if (t.highway === "traffic_signals" || t.crossing === "traffic_signals" || t["crossing:signals"] === "yes") osmSig.push(e);
  }
  for (const e of els) if (e.type === "way" && e.tags && JSIG_ROADS.has(BASE[e.tags.highway] || e.tags.highway)) {
    const lv = levelOf(e.tags, cfg);
    for (const n of new Set(e.nodes)) { cnt.set(n, (cnt.get(n) || 0) + 1); if (lv >= 1) big.add(n); }
  }
  const G = 0.0005, gJ = new Map(), gR = new Map(), gS = new Map(), K = (la, lo) => Math.floor(la / G) + "," + Math.floor(lo / G);
  const put = (m, e) => { const k = K(e.lat, e.lon); if (!m.has(k)) m.set(k, []); m.get(k).push(e); };
  for (const n of big) if (node.has(n)) { put(gR, node.get(n)); if (cnt.get(n) >= 2) put(gJ, node.get(n)); }
  osmSig.forEach(e => put(gS, e));
  const near = (m, p, r) => { const o = [], a = Math.floor(p[0] / G), b = Math.floor(p[1] / G);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const e of m.get((a + i) + "," + (b + j)) || []) { const d = hav(p[0], p[1], e.lat, e.lon); if (d <= r) o.push([e, d]); }
    return o.sort((x, y) => x[1] - y[1]); };
  const out = [];
  for (const p of sigs) {
    const s = near(gS, p, JSIG_OSM);
    if (s.length) { out.push({ p, t: "osm", d: Math.round(s[0][1]) }); continue; }
    const c = near(gJ, p, JSIG_SNAP);
    if (!c.length) {   // 交差点がない＝押しボタン信号など：いちばん近い 大きい道の点につける（その道を渡る信号）
      const r = near(gR, p, JSIG_SNAP);
      if (!r.length) { out.push({ p, t: "none" }); continue; }
      out.push({ p, t: "btn", d: Math.round(r[0][1]), n: [{ id: r[0][0].id, p: [r[0][0].lat, r[0][0].lon] }], tag: [r[0][0].id] }); continue;
    }
    const cl = [];
    for (const [e] of c) { const h = cl.find(g => g.some(x => hav(x.lat, x.lon, e.lat, e.lon) <= JSIG_CL)); if (h) h.push(e); else cl.push([e]); }
    const use = cl.find(g => g.includes(c[0][0]));   // いちばん近い交差点のかたまり
    out.push({ p, t: cl.length === 1 ? "snap" : "amb", d: Math.round(c[0][1]), n: use.map(e => ({ id: e.id, p: [e.lat, e.lon] })), k: cl.length, tag: use.map(e => e.id) });
  }
  return out;
}
// 🚸 警察の横断歩道（JARTIC）：交差点ごとの点なので どの道を渡るかわからない。交差点じゃない所（道のとちゅう）の横断歩道だけ使う
// ・20m以内に OSM の横断歩道か信号 → "osm"（何もしない）
// ・25m以内に 交差点（車の道が2本以上。細い道・service も数える）→ "jct"（どの道を渡るかわからないので使わない）
// ・それ以外で 15m以内に 2車線以上の道 → "mid"（その道のいちばん近い点に "jar:xw"＝横断歩道としてつける）／ なし → "none"
const JXW_OSM = 20, JXW_JCT = 25, JXW_ROAD = 15;
const JXW_ROADS = new Set(["residential", "unclassified", "living_street", "service", "tertiary", "secondary", "primary", "trunk"]);
function jarXwClassify(els, xws, cfg) {
  const node = new Map(), cnt = new Map(), big = new Set(), osm = [];
  for (const e of els) if (e.type === "node") {
    node.set(e.id, e); const t = e.tags || {};
    if ((t.highway === "crossing" && !["no", "unmarked", "informal"].includes(t.crossing)) || t.highway === "traffic_signals" || t.crossing === "traffic_signals" || t["crossing:signals"] === "yes") osm.push(e);
  }
  for (const e of els) if (e.type === "way" && e.tags && JXW_ROADS.has(BASE[e.tags.highway] || e.tags.highway)) {
    const lv = levelOf(e.tags, cfg);
    for (const n of new Set(e.nodes)) { cnt.set(n, (cnt.get(n) || 0) + 1); if (lv >= 1) big.add(n); }
  }
  const G = 0.0005, gJ = new Map(), gR = new Map(), gO = new Map(), K = (la, lo) => Math.floor(la / G) + "," + Math.floor(lo / G);
  const put = (m, e) => { const k = K(e.lat, e.lon); if (!m.has(k)) m.set(k, []); m.get(k).push(e); };
  for (const [n, c] of cnt) if (node.has(n)) { if (c >= 2) put(gJ, node.get(n)); if (big.has(n)) put(gR, node.get(n)); }
  osm.forEach(e => put(gO, e));
  const near = (m, p, r) => { const o = [], a = Math.floor(p[0] / G), b = Math.floor(p[1] / G);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const e of m.get((a + i) + "," + (b + j)) || []) { const d = hav(p[0], p[1], e.lat, e.lon); if (d <= r) o.push([e, d]); }
    return o.sort((x, y) => x[1] - y[1]); };
  const out = [];
  for (const p of xws) {
    const o = near(gO, p, JXW_OSM); if (o.length) { out.push({ p, t: "osm", d: Math.round(o[0][1]) }); continue; }
    const j = near(gJ, p, JXW_JCT); if (j.length) { out.push({ p, t: "jct", d: Math.round(j[0][1]) }); continue; }
    const r = near(gR, p, JXW_ROAD); if (!r.length) { out.push({ p, t: "none" }); continue; }
    out.push({ p, t: "mid", d: Math.round(r[0][1]), n: [{ id: r[0][0].id, p: [r[0][0].lat, r[0][0].lon] }], tag: [r[0][0].id] });
  }
  return out;
}
async function jarSigIn(bb, cfg) {
  const [S, W, N, E] = bb, T = 0.01, pad = 0.0004, keys = [];
  for (let i = Math.floor((S - pad) / T); i <= Math.floor((N + pad) / T); i++) for (let j = Math.floor((W - pad) / T); j <= Math.floor((E + pad) / T); j++) keys.push(`0.01:${i},${j}`);
  if (keys.length > 30) return { sigs: [], tooWide: true };
  if (!packBase) return { sigs: [] };
  const names = [...new Set(keys.map(packName))]; await jarLoad(names);
  const sigs = [], xws = [], sk = new Set();
  for (const n of names) for (const [key, arr] of [["sig", sigs], ["xw", xws]]) for (const p of (jarMem.get(n) || {})[key] || []) { const q = key + p.join(); if (!sk.has(q) && p[0] > S && p[0] < N && p[1] > W && p[1] < E) { sk.add(q); arr.push(p); } }
  const els = [], seen = new Set(), have = new Set(); let miss = 0;
  for (const k of keys) {
    let el = mem.get(k);
    if (!el) { const r = await getTileAny(k); if (r) el = r.el; }
    if (!el) { try { if (await packHas(k)) el = (await packTile(k)).el; } catch {} }
    if (!el) { miss++; continue; }
    have.add(k);
    for (const e of el) { const q = e.type[0] + (e.uid || e.id); if (!seen.has(q)) { seen.add(q); els.push(e); } }
  }
  const ok = p => have.has(`0.01:${Math.floor(p[0] / T)},${Math.floor(p[1] / T)}`);   // 道のデータがないマスの信号は 判定しない
  const c = { ...DEFAULT_CFG, ...(cfg || {}) };
  const E0 = jarApply0({ elements: els }, c, await jarPrep(keys, c).catch(() => ({ nx: [], ow: [] }))).elements;
  return { sigs: jarSigClassify(E0, sigs.filter(ok), c), xws: jarXwClassify(E0, xws.filter(ok), c), miss: sigs.filter(p => !ok(p)).length + xws.filter(p => !ok(p)).length };
}
// 🎨 足あと：走った線を道にあてはめて「通った道（way の何番目の区間か）」を出す（端末にある道路データか配布データだけ）
// 道の区間を 8m おきの点で見て、いちばん近い区間（15m 以内）に入れる。区間の6割（短い区間は少しでも）通ったら「通った」
const FOOT_CELL = 0.0005, footTiles = new Map();   // マス → { seg: [[way id, 何番目, 緯度1, 経度1, 緯度2, 経度2, 長さ]…], grid }
async function footTile(k) {
  if (footTiles.has(k)) return footTiles.get(k);
  let el = mem.get(k);
  if (!el) { const r = await getTileAny(k); if (r) el = r.el; }
  if (!el) { try { if (await packHas(k)) el = (await packTile(k)).el; } catch {} }
  const t = { seg: [], grid: new Map() };
  if (el) {
    const nd = new Map();
    for (const e of el) if (e.type === "node") nd.set(e.id, [e.lat, e.lon]);
    for (const e of el) if (e.type === "way" && e.nodes) for (let i = 0; i + 1 < e.nodes.length; i++) {
      const a = nd.get(e.nodes[i]), b = nd.get(e.nodes[i + 1]); if (!a || !b) continue;
      const u = e.nodes[i], v = e.nodes[i + 1], n = t.seg.length;   // 区間の名前＝両はしの点の番号（v2 で 道がマスごとに きれていても 同じになる）
      t.seg.push([u < v ? u + "-" + v : v + "-" + u, 0, a[0], a[1], b[0], b[1], hav(a[0], a[1], b[0], b[1])]);
      const i0 = Math.floor(Math.min(a[0], b[0]) / FOOT_CELL), i1 = Math.floor(Math.max(a[0], b[0]) / FOOT_CELL);
      const j0 = Math.floor(Math.min(a[1], b[1]) / FOOT_CELL), j1 = Math.floor(Math.max(a[1], b[1]) / FOOT_CELL);
      for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) { const g = ii + "," + jj; if (!t.grid.has(g)) t.grid.set(g, []); t.grid.get(g).push(n); }
    }
  }
  if (footTiles.size > 60) footTiles.delete(footTiles.keys().next().value);
  footTiles.set(k, t);
  return t;
}
function segDist(la, lo, s) {   // 点と区間のきょり（m・せまい所なので平らとみなす）
  const kx = 111320 * Math.cos(la * Math.PI / 180), ky = 110540;
  const ax = (s[3] - lo) * kx, ay = (s[2] - la) * ky, bx = (s[5] - lo) * kx, by = (s[4] - la) * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const u = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + u * dx, ay + u * dy);
}
async function footAccum(acc, runs) {   // 走った線を 8m おきに見て、いちばん近い区間（15m 以内）に きょりを足す
  const STEP = 8;
  for (const r of runs) for (let i = 1; i < r.length; i++) {
    const a = r[i - 1], b = r[i], d = hav(a[0], a[1], b[0], b[1]);
    if (d > 300) continue;   // GPS が飛んだ所
    const n = Math.max(1, Math.round(d / STEP));
    for (let s = 0; s < n; s++) {
      const la = a[0] + (b[0] - a[0]) * s / n, lo = a[1] + (b[1] - a[1]) * s / n;
      const t = await footTile(`0.01:${Math.floor(la / 0.01)},${Math.floor(lo / 0.01)}`);
      const gi = Math.floor(la / FOOT_CELL), gj = Math.floor(lo / FOOT_CELL);
      let best = null, bd = 15;
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (const n2 of t.grid.get((gi + x) + "," + (gj + y)) || []) {
        const sg = t.seg[n2], dd = segDist(la, lo, sg); if (dd < bd) { bd = dd; best = sg; }
      }
      if (!best) continue;
      const k = best[0], o = acc.get(k);
      if (o) o.m += d / n; else acc.set(k, { m: d / n, sg: best });
    }
  }
}
// 区間の6割（短い区間は少しでも）通ったら「塗れた」
const footOk = (m, L) => m + 8 >= Math.min(L * 0.6, L - 20);
const footRec = (k, sg) => [k, Math.round(sg[6] * 10) / 10, +((sg[2] + sg[4]) / 2).toFixed(5), +((sg[3] + sg[5]) / 2).toFixed(5), sg[2], sg[3], sg[4], sg[5]];   // 長さ・まん中（市を見る）・両はし（🛣塗れた道を描く）
async function footMatch(runs) {
  const acc = new Map(); await footAccum(acc, runs);
  const out = [];
  for (const [k, { m, sg }] of acc) if (footOk(m, sg[6])) out.push(footRec(k, sg));
  return out;
}
// 走っているとき：新しい点が来るたびに足して、いま塗れた区間だけ返す（ピッ！用）
let footLiveT0 = null, footLiveAcc = new Map(), footLiveDone = new Set();
async function footLive(t0, pair) {
  if (t0 !== footLiveT0) { footLiveT0 = t0; footLiveAcc = new Map(); footLiveDone = new Set(); }
  await footAccum(footLiveAcc, [pair]);
  const out = [];
  for (const [k, { m, sg }] of footLiveAcc) if (!footLiveDone.has(k) && footOk(m, sg[6])) { footLiveDone.add(k); out.push(footRec(k, sg)); }
  return out;
}
// 配布データをまとめて入れる（パソコン向け）
let pkStop = false;
async function packAll(post, at) {   // at=[緯度,経度]：その場所の地方（関東一円・関西・中京）だけ入れる
  const p = await packIndex(); if (!p || !p.size) return post({ fin: true, msg: "配布データが見つからなかったよ" });
  const ar = packAreaE;
  let nm = "", box = null;
  if (at && ar.length) {   // 地図のまん中が入っている地方。どこにも入っていなければ いちばん近い地方
    const d = ([S, W, N, E]) => Math.hypot(Math.max(S - at[0], 0, at[0] - N), Math.max(W - at[1], 0, at[1] - E));
    [nm, box] = ar.reduce((a, b) => d(b[1]) < d(a[1]) ? b : a);
  }
  const inBox = n => { if (!box) return true; const [i, j] = n.split("_").map(Number), la = (i + 0.5) * 0.01, lo = (j + 0.5) * 0.01; return la > box[0] && la < box[2] && lo > box[1] && lo < box[3]; };
  const all = [...p].filter(inBox), { have } = await haveKeys(), list = all.map(n => "0.01:" + n.replace("_", ",")).filter(k => !have.has(k));
  let done = 0, bytes = 0, next = 0;
  log(`==== 配布データをまとめて入れる${nm ? "（" + nm + "）" : ""}：${list.length}マス（もう持ってる ${all.length - list.length}マス）====`, "h");
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
  if (!top.startsWith("HOSOMICHI1\n")) throw new Error("ほそみちナビの道路データのファイルではないみたい");
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
async function clearAll() { const st = await store("readwrite"); if (st) await req(st.clear()); mem.clear(); await jarClear(); }

// 出発→目的地の線のまわり（帯）にかかるマスだけ選ぶ
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
// ==== 階段っぽさ（配布データの stairs_ai.json）：[緯度, 経度, 階段っぽさ%]
let stairsAI = null, stairsTried = false;
const AI_YES = 60, AI_NO = 30;   // 60%以上＝階段・30%以下＝階段じゃない（あいだは 標高だけで決める）
async function loadStairsAI() {
  if (stairsAI || stairsTried || !packBase) return;
  stairsTried = true;
  try {
    const res = await fetch(packBase + "stairs_ai.json"); if (!res.ok) return;
    const g = new Map(); let n = 0;
    for (const [la, lo, p] of (await res.json()).pts || []) { const k = Math.floor(la / 0.002) + "," + Math.floor(lo / 0.002); if (!g.has(k)) g.set(k, []); g.get(k).push([la, lo, p]); n++; }
    stairsAI = g; log(`階段っぽさ: ${n}か所`);
  } catch { stairsTried = false; }
}
function stairsAt(pts) {   // 道（点のならび）から 12m以内の 階段っぽさ（いちばん近いもの）の %。なければ null
  if (!stairsAI) return null;
  let best = null, bd = 12;
  for (const [la, lo] of pts) for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
    for (const q of stairsAI.get((Math.floor(la / 0.002) + i) + "," + (Math.floor(lo / 0.002) + j)) || []) {
      const d = hav(la, lo, q[0], q[1]); if (d < bd) { bd = d; best = q[2]; }
    }
  return best;
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
    for (const kind of ["cemetery", "park", "closed", "danchi", "parking"]) {
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
      cnt.push(`${kind === "park" ? "公園" : kind === "closed" ? "学校や工場の敷地" : kind === "danchi" ? "団地" : kind === "parking" ? "駐車場" : "霊園・墓地"} ${n}か所`);
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
// ==== 〰 小河川の川べりの車の来ない道（配布データの rivers/・0.1度のマス）：見分けるだけ（いまはルートの計算には使わない）====
// 川・水路・小川の線から 20m 以内で、線と向きが ±30° でそろう 区間（区間＝道の点と点のあいだ。10m おきに しらべて 半分以上あてはまれば その区間）
// 車の来ない道だけ：自転車道・歩道（車道ぞいの歩道・横断歩道はのぞく）・小道・歩行者天国（自転車OKの印があるときだけ）、または 車は通行止めの印（motor_vehicle=no など）がある道
// 自転車が走れない道はのぞく：bicycle=no・dismount（押して歩く）・🚓 警察のデータの 自転車通行止め・歩行者用道路。🟤 砂利・土の道も のぞく（舗装かわからない小道は 入れる）
// 大河川のCR は いったん置いておく（ユーザー：大きい川ぞいは 自転車道・自転車歩行者道の印が もともと多い）
const RIV_NEAR = 20, RIV_COS = Math.cos(30 * Math.PI / 180), RIV_FOOT = new Set(["cycleway", "footway", "path", "pedestrian"]), RIV_NOCAR = ["no", "private", "agricultural", "forestry"];
let rivIx = null; const rivMem = new Map();
async function rivCells(S, W, N, E) {
  if (!packBase) return [];
  if (!rivIx) { try { const r = await fetch(packBase + "rivers/index.json"); if (!r.ok) return []; const j = await r.json(); rivIx = { t: j.t || .1, has: new Set(j.cells || []) }; } catch { return []; } }
  const t = rivIx.t, out = [];
  for (let i = Math.floor(S / t); i <= Math.floor(N / t); i++) for (let k = Math.floor(W / t); k <= Math.floor(E / t); k++) {
    const key = i + "_" + k; if (!rivIx.has.has(key)) continue;
    if (!rivMem.has(key)) rivMem.set(key, fetch(packBase + "rivers/" + key + ".json").then(r => r.ok ? r.json() : null).catch(() => { rivMem.delete(key); return null; }));
    const c = await rivMem.get(key); if (c) out.push(c);
  }
  return out;
}
async function rivPrep(S, W, N, E) {
  const P = .001, cs = await rivCells(S - P, W - P, N + P, E + P);
  const cl = Math.cos((S + N) / 2 * Math.PI / 180), X = lo => lo * cl * 111320, Y = la => la * 110540;
  const LG = 50, lg = new Map(), seen = new Set();
  for (const c of cs) for (const [, nm, pts] of c.line || []) {
    const id = pts[0] + "|" + pts.length + "|" + nm; if (seen.has(id)) continue; seen.add(id);
    for (let q = 1; q < pts.length; q++) {
      const x1 = X(pts[q - 1][1]), y1 = Y(pts[q - 1][0]), x2 = X(pts[q][1]), y2 = Y(pts[q][0]);
      for (let i = Math.floor(Math.min(x1, x2) / LG); i <= Math.floor(Math.max(x1, x2) / LG); i++) for (let j = Math.floor(Math.min(y1, y2) / LG); j <= Math.floor(Math.max(y1, y2) / LG); j++) {
        const k = i + "," + j; let a = lg.get(k); if (!a) lg.set(k, a = []); a.push([x1, y1, x2, y2, nm || ""]);
      }
    }
  }
  return { X, Y, lg, LG, n: lg.size };
}
// 点 (px,py) から R m 以内で、向き (ux,uy) と ±30° でそろう川の線があるか（あれば 川の名前、なければ null）
function rivNear(g, G, R, px, py, ux, uy) {
  const ci = Math.floor(px / G), cj = Math.floor(py / G), K = Math.ceil(R / G);
  let best = null, bd = R;
  for (let i = -K; i <= K; i++) for (let j = -K; j <= K; j++) for (const [x1, y1, x2, y2, v] of g.get((ci + i) + "," + (cj + j)) || []) {
    const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy); if (l < 1) continue;
    if (Math.abs((dx * ux + dy * uy) / l) < RIV_COS) continue;
    let t = ((px - x1) * dx + (py - y1) * dy) / (l * l); t = Math.max(0, Math.min(1, t));
    const dd = Math.hypot(px - x1 - t * dx, py - y1 - t * dy); if (dd <= bd) { bd = dd; best = v; }
  }
  return best;
}
// ==== ➡️ シンプルパス（配布データの warp.json・tools/make_warp.py で作る。いまは東京23区だけ）：曲がらずに遠くまで続く細い道 ====
// 道の区間が シンプルパスの線から 8m 以内で 向きが ±30° でそろえば 🌀（川べりと同じ見分けかた）。設定 warp で「通りたい」倍率（足し算）をつける
const WARP_NEAR = 8, WARP_HW = new Set(["residential", "living_street", "unclassified", "service", "tertiary"]); let warpMem = null;   // WARP_HW：見つけた道と同じ種類だけ（となりの歩道には かけない）
async function warpPrep(S, W, N, E, minL) {
  if (!packBase) return null;
  if (!warpMem) warpMem = fetch(packBase + "warp.json").then(r => r.ok ? r.json() : null).catch(() => { warpMem = null; return null; });
  const j = await warpMem; if (!j || !j.s) return null;
  const cl = Math.cos((S + N) / 2 * Math.PI / 180), X = lo => lo * cl * 111320, Y = la => la * 110540, LG = 50, lg = new Map(), P = .001;
  for (const o of j.s) {
    if (o.l < minL) continue;
    let a = 90, b = 180, c = -90, d = -180; for (const [la, lo] of o.p) { a = Math.min(a, la); c = Math.max(c, la); b = Math.min(b, lo); d = Math.max(d, lo); }
    if (a > N + P || c < S - P || b > E + P || d < W - P) continue;
    for (let q = 1; q < o.p.length; q++) {
      const x1 = X(o.p[q - 1][1]), y1 = Y(o.p[q - 1][0]), x2 = X(o.p[q][1]), y2 = Y(o.p[q][0]);
      for (let i = Math.floor(Math.min(x1, x2) / LG); i <= Math.floor(Math.max(x1, x2) / LG); i++) for (let k = Math.floor(Math.min(y1, y2) / LG); k <= Math.floor(Math.max(y1, y2) / LG); k++) {
        const key = i + "," + k; let arr = lg.get(key); if (!arr) lg.set(key, arr = []); arr.push([x1, y1, x2, y2, o.nm || ""]);
      }
    }
  }
  return { X, Y, lg, LG, n: lg.size };
}
// 車の来ない道か（自転車は通れる）
const rivOK = t => {
  if (EXCLUDE.has(t.highway) || t.highway === "steps" || yes(t.bridge) || yes(t.tunnel) || t.bicycle === "no" || t.bicycle === "dismount") return false;
  if (t["jar:nb"] === "1" || t["jar:nb"] === "ta") return false;   // 🚓 警察のデータで 自転車通行止め・歩行者用道路
  if (isUnpaved(t) === "sure") return false;   // 🟤 砂利・土の道（いそぐための道なので）
  const bOK = ["yes", "designated", "permissive"].includes(t.bicycle);
  if (t.highway === "pedestrian" && !bOK) return false;   // 🚶 歩行者天国・広場：自転車OKの印がなければ のぞく
  if ((t.access === "no" || t.access === "private") && !bOK) return false;
  if (RIV_FOOT.has(t.highway)) {
    if (t.footway === "sidewalk" || t.footway === "crossing" || t.cycleway === "crossing" || t.path === "sidewalk") return false;
    if (t.highway === "cycleway" || bOK) return true;
    return !!t.surface && !UNPAVED.has(t.surface);   // 11/25：歩道・遊歩道は「自転車OK」か「舗装の印（surfaceタグ）がちゃんとある」のどちらかがなければ のぞく（タグなしの正体不明な小道を除外するため）
  }
  return [t.motor_vehicle, t.motorcar, t.vehicle].some(v => RIV_NOCAR.includes(v)) && (t.vehicle !== "no" || bOK) || (t.access === "no" && bOK);
};
// 1本の道の点の列 [[緯度,経度],…] → 区間ごとに 0＝なし・1＝〰川べり（どれもなければ null）と、そばの川の名前
function rivWay(R, pts, near = RIV_NEAR) {
  const xs = pts.map(p => R.X(p[1])), ys = pts.map(p => R.Y(p[0]));
  { const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); let hit = false;   // まわりに川がなければ すぐ終わり
    for (let i = Math.floor((x0 - near) / R.LG); i <= Math.floor((x1 + near) / R.LG) && !hit; i++) for (let j = Math.floor((y0 - near) / R.LG); j <= Math.floor((y1 + near) / R.LG) && !hit; j++) if (R.lg.has(i + "," + j)) hit = true;
    if (!hit) return null; }
  const rv = [], nms = new Map(); let any = false;
  for (let q = 1; q < pts.length; q++) {
    const ax = xs[q - 1], ay = ys[q - 1], dx = xs[q] - ax, dy = ys[q] - ay, L = Math.hypot(dx, dy);
    if (L < 1) { rv.push(rv.length ? rv[rv.length - 1] : 0); continue; }
    const ux = dx / L, uy = dy / L, n = Math.max(1, Math.round(L / 10)); let h = 0;
    for (let s = 0; s < n; s++) {
      const f = (s + .5) / n, nm = rivNear(R.lg, R.LG, near, ax + dx * f, ay + dy * f, ux, uy);
      if (nm !== null) { h++; if (nm) nms.set(nm, (nms.get(nm) || 0) + 1); }
    }
    const k = h * 2 >= n ? 1 : 0; rv.push(k); if (k) any = true;
  }
  if (!any) return null;
  let rn = "", bn = 0; for (const [k, v] of nms) if (v > bn) { bn = v; rn = k; }
  return { rv, rn };
}
// ==== 坂道：国土地理院の標高タイル（5mメッシュ dem5a・dem5b・ズーム15。ない所は 10mメッシュ dem_png・ズーム14）で、のぼりをきらう・印のない階段をさがす ====
const DEMZ = 15, demCache = new Map();
const demDecode = d => { const h = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) {
    const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2], v = R * 65536 + G * 256 + B;
    h[i] = (R === 128 && G === 0 && B === 0) ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;   // 128,0,0 は「データなし」
  }
  return h; };
async function demPng(url) {
  const res = await fetch(url); if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob()), cv = new OffscreenCanvas(256, 256), cx = cv.getContext("2d");
  cx.drawImage(bmp, 0, 0); return demDecode(cx.getImageData(0, 0, 256, 256).data);
}
async function demTile(x, y) {
  const k = x + "/" + y;
  if (demCache.has(k)) return demCache.get(k);
  let h = null;
  for (const nm of ["dem5a_png", "dem5b_png"]) {   // 5m（航空レーザ → 写真測量）
    try { h = await demPng(`https://cyberjapandata.gsi.go.jp/xyz/${nm}/${DEMZ}/${x}/${y}.png`); } catch {}
    if (h && h.some(v => !isNaN(v))) break; h = null;
  }
  if (!h) try {   // 5m がない所：10m（ズーム14）の4分の1を 2倍にのばす
    const q = await demPng(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/${DEMZ - 1}/${x >> 1}/${y >> 1}.png`);
    if (q) { h = new Float32Array(65536); const ox = (x & 1) * 128, oy = (y & 1) * 128;
      for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) h[j * 256 + i] = q[(oy + (j >> 1)) * 256 + ox + (i >> 1)]; }
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
  if (list.length > 2500) { log(`坂道：範囲が広すぎるので、坂は見ないよ（標高タイル ${list.length}枚）`, "w"); return false; }
  const t0 = Date.now(); let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (i < list.length) { const [x, y] = list[i++]; await demTile(x, y); } }));
  if (list.length) log(`坂道：標高タイル ${list.length}枚（${((Date.now() - t0) / 1000).toFixed(1)}秒）`);
  return true;
}
function heightAt(la, lo) {   // まわり4ピクセルで なめらかに
  let [px, py] = demXY(la, lo); px -= 0.5; py -= 0.5;
  const x0 = Math.floor(px), y0 = Math.floor(py), u = px - x0, v = py - y0;
  let s = 0, w = 0;
  for (const [dx, dy, k] of [[0, 0, (1 - u) * (1 - v)], [1, 0, u * (1 - v)], [0, 1, (1 - u) * v], [1, 1, u * v]]) {
    const X = x0 + dx, Y = y0 + dy, h = demCache.get((X >> 8) + "/" + (Y >> 8));
    const z = h ? h[(Y & 255) * 256 + (X & 255)] : NaN;
    if (isNaN(z)) return NaN;
    s += z * k; w += k;
  }
  return s / w;
}
// のぼり 1m を k m 分と数える（急な所は ⛰急坂？・🪜階段？ の設定で）。標高のゆれ（橋・切り通し）に強くするため 15% で頭打ち
// 印のない階段さがし（tools/test_dem.py で船橋・松戸でためした方法）：
//  道を「交差点から交差点まで」に区切って、80mまでの短い道の「はし→はし」の高さの差で見る（とちゅうのでこぼこ・崖のそばのずれに強い）
//  ・階段？：車の通る道で 20%より急／歩道・小道で 10%より急（高さの差 2.5m以上。歩道・小道の急な所は 階段のことが多い）→ 設定 stepsGuess の倍率（はじめ ×30。"no"＝通らない）
//  ・急坂？：10%より急（高さの差 2m以上）→ 設定 steep の倍率（はじめ ×3。じっさいは階段のことも多い）
//  ・⛰急坂？になった道だけ、道にそって2mごとに高さを見て、高さの差のほとんど（7割以上）が 15mの間に まとまっていて
//    そこが25%より急なら 🪜階段？にする（長い道の まん中だけ階段、みたいな所。はし→はしだと うすまって急坂？になる）
//    （どの道でも15mの間を見ると 崖のそばのずれで まちがえやすいので、はし→はしで もう急な道だけにしぼる）
//    とちゅうの点で、はしとはしの高さのあいだ（±0.5m）から飛び出したものは 崖・擁壁のずれとして すてる（3割をこえたら見ない）
//    長い階段（擁壁のあいだの 高さ5〜8mの階段など）は 15mに入りきらないので、15mの間で3m以上・30%より急なら まとまりは見ないで 🪜階段？
//    （ふつうの道は 急でも20%くらいまで）
//  橋・トンネル（と そのはしにつながる道）は 標高のデータと高さが合わないので見ない
const STEP_WIN = 15, STEP_MASS = 0.7, STEP_GR = 0.25, STEP_TOL = 0.5, STEP_GR2 = 0.3, STEP_NEED2 = 3;
function stepConc(pts, need) {   // 道（点のならび）で、15mまでの間に need m 以上かわる所の いちばん急な坂 gr（なければ 0）・15mの間の いちばん大きい差 loc・すてた点の わりあい drop
  const sm = []; let d0 = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a1, o1] = pts[i - 1], [a2, o2] = pts[i], L = hav(a1, o1, a2, o2);
    for (let t = 0; t < L; t += 2) sm.push([d0 + t, heightAt(a1 + (a2 - a1) * t / L, o1 + (o2 - o1) * t / L)]);
    d0 += L;
  }
  const [la, lo] = pts[pts.length - 1]; sm.push([d0, heightAt(la, lo)]);
  if (sm.some(x => isNaN(x[1]))) return { why: "標高データなし" };
  // はしとはしの高さの あいだ（±0.5m）から飛び出した点は、崖・擁壁のそばの 標高のずれとして すてる。すてる点が3割をこえたら あてにならない
  const lo0 = Math.min(sm[0][1], sm[sm.length - 1][1]) - STEP_TOL, hi0 = Math.max(sm[0][1], sm[sm.length - 1][1]) + STEP_TOL, n0 = sm.length;
  for (let i = sm.length - 1; i >= 0; i--) if (sm[i][1] < lo0 || sm[i][1] > hi0) sm.splice(i, 1);
  const drop = 1 - sm.length / n0;
  if (sm.length < n0 * 0.7 || sm.length < 3) return { why: "すてた点が多い", drop };
  let gr = 0, gr2 = 0, loc = 0, j = 0;
  for (let i = 0; i < sm.length; i++) {
    while (sm[i][0] - sm[j][0] > STEP_WIN) j++;
    for (let k = j; k < i; k++) {
      const d = Math.abs(sm[i][1] - sm[k][1]), g = d / Math.max(sm[i][0] - sm[k][0], 6); loc = Math.max(loc, d);   // 6mより短い所は 6mとして（標高データのゆれで 急になりすぎないように）
      if (d >= need) gr = Math.max(gr, g);
      if (d >= STEP_NEED2) gr2 = Math.max(gr2, g);   // 長い階段用：まとまりは見ない
    }
  }
  return { gr, gr2, loc, drop };
}
const CAR_HW = new Set(["residential", "unclassified", "service", "living_street", "tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link", "trunk", "trunk_link", "road"]);
// ✅ 通れる：🚫と同じで、印から いちばん近い道（12m以内・いちばん近い道より4m以上はなれた道はのぞく）だけ
function okSegD(G, p, u, v) {
  const M = 111320, cosl = Math.cos(p[0] * RAD);
  const ax = (G.lon[u] - p[1]) * cosl * M, ay = (G.lat[u] - p[0]) * M, bx = (G.lon[v] - p[1]) * cosl * M, by = (G.lat[v] - p[0]) * M;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}
function okMins(G) {   // 印ごとの いちばん近い道までのきょり
  const out = okPts.map(() => Infinity), n = G.lat.length;
  for (let u = 0; u < n; u++) if (G.adj[u]) for (const e of G.adj[u]) if (e.v > u) okPts.forEach((p, k) => {
    if (Math.abs(G.lat[u] - p[0]) > 0.0005 || Math.abs(G.lon[u] - p[1]) > 0.0006) return;   // 遠い道は 計算しない（約55m）
    const d = okSegD(G, p, u, e.v); if (d < out[k]) out[k] = d;
  });
  return out;
}
function okNear(G, path, mins) {   // 🪜✕／🪜✓ の印が、この道（点のならび）に かかっていれば その種類（n・y）
  for (let k = 0; k < okPts.length; k++) {
    if (!(mins[k] < BLOCK_R)) continue;
    for (let i = 1; i < path.length; i++) { const d = okSegD(G, okPts[k], path[i - 1], path[i]); if (d < BLOCK_R && d <= mins[k] + 4) return okPts[k][2] || "n"; }
  }
  return null;
}
function applySlope(G, k, stK, slK, count) {   // count：数だけ返す（📍長押しの「このあたりを見る」）   // k：のぼり1mを何m分 / stK：🪜階段？の倍率（"no"＝通らない） / slK：⛰急坂？の倍率
  if (typeof OffscreenCanvas === "undefined") return G;
  const n = G.lat.length, h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = G.inGraph[i] ? heightAt(G.lat[i], G.lon[i]) : NaN;
  // となり（向きは気にしない）
  const nb = Array.from({ length: n }, () => null), brN = new Uint8Array(n);
  const addNb = (a, b) => { (nb[a] || (nb[a] = new Set())).add(b); };
  for (let u = 0; u < n; u++) for (const e of G.adj[u]) { addNb(u, e.v); addNb(e.v, u); if (e.b) { brN[u] = 1; brN[e.v] = 1; } }
  const deg = i => nb[i] ? nb[i].size : 0;
  const edge = (a, b) => G.adj[a].find(e => e.v === b);
  let st = 0, sl = 0;
  let okM = null;   // ✅ 通れる の印ごとの いちばん近い道までのきょり（はじめて いるときに計算）
  const seen = new Set(), marks = [];   // 地図のマーク用：[緯度, 経度, 1=階段？/0=急坂？, 坂%, 高さの差, 長さ]
  for (let a = 0; a < n; a++) {
    if (!nb[a] || deg(a) === 2) continue;   // 交差点・行き止まりから歩きだす
    for (const first of nb[a]) {
      const path = [a]; let prev = a, cur = first, L = 0, bad = false, car = false;
      for (;;) {
        path.push(cur);
        const e = edge(prev, cur) || edge(cur, prev); if (e) { L += e.L; if (e.b) bad = true; if (CAR_HW.has(e.hw)) car = true; }
        if (deg(cur) !== 2 || L > 80 || path.length > 200) break;
        let nx = -1; for (const x of nb[cur]) if (x !== prev) nx = x;
        if (nx < 0 || nx === a) break; prev = cur; cur = nx;
      }
      const z = path[path.length - 1], key = a < z ? a + "-" + z + "-" + path[1] : z + "-" + a + "-" + path[path.length - 2];
      if (seen.has(key)) continue; seen.add(key);
      if (bad || L > 80 || L < 5 || brN[a] || brN[z] || deg(z) === 2) continue;
      if (G.stepN && path.some(i => G.stepN[i])) continue;   // 地図データの 階段に つながっている道は 見ない（階段の手前の歩道が 急坂？になっていた）
      const dh = Math.abs(h[z] - h[a]); if (!(dh >= 2)) continue;
      const gr = dh / L; let stair = dh >= 2.5 && gr >= (car ? 0.2 : 0.1), steep = !stair && gr >= 0.1;
      // 階段っぽさ：高ければ 階段？・低ければ 急坂？
      const ai = stairsAt(path.map(i => [G.lat[i], G.lon[i]]));
      if (ai != null && gr >= 0.1) { if (ai >= AI_YES) { stair = true; steep = false; } else if (ai <= AI_NO) { stair = false; steep = true; } }
      let why = ai != null ? `航空写真AI ${ai}%` : "";   // 🔍 マークをタップしたときに出す 判定の数字（調整用）
      if (steep && ai == null) {   // ⛰急坂？：高さの差が 15mの間に まとまっていたら 🪜階段？
        const q = stepConc(path.map(i => [G.lat[i], G.lon[i]]), Math.max(2, STEP_MASS * dh));
        if (q.gr != null && (q.gr >= STEP_GR || q.gr2 >= STEP_GR2)) { stair = true; steep = false; }
        why = q.why ? q.why + (q.drop != null ? ` ${Math.round(q.drop * 100)}%` : "")
          : `15mの間のまとまり ${Math.round(100 * q.loc / dh)}%（${Math.round(STEP_MASS * 100)}%いる）・そこの坂 ${Math.round(q.gr * 100)}%（${Math.round(STEP_GR * 100)}%いる）`
            + `・3m以上の所の坂 ${Math.round(q.gr2 * 100)}%（${Math.round(STEP_GR2 * 100)}%いれば 長い階段）・すてた点 ${Math.round(q.drop * 100)}%`;
      }
      if (!stair && !steep) continue;
      const fix = okPts.length ? okNear(G, path, okM || (okM = okMins(G))) : null;
      if (fix === "n") { stair = false; steep = true; why = "🪜✕ 階段じゃない の印"; }   // 🪜階段？ → ⛰急坂？
      if (fix === "y") { stair = true; steep = false; why = "🪜✓ 階段だった の印"; }   // ⛰急坂？ → 🪜階段？   // ✅ 通れる の印がある道は 取り消し（マークも出さない）
      if (stair) st++; else sl++;
      { // マークは 道の線にそって ちょうど まん中の所（点の番号のまん中だと、点が2つしかない道では はしの交差点に出て、となりの道の印に見えるので）
        let half = L / 2, mla = G.lat[path[0]], mlo = G.lon[path[0]];
        for (let i = 1; i < path.length; i++) {
          const p0 = path[i - 1], p1 = path[i], d = hav(G.lat[p0], G.lon[p0], G.lat[p1], G.lon[p1]);
          if (d >= half) { const t = d ? half / d : 0; mla = G.lat[p0] + (G.lat[p1] - G.lat[p0]) * t; mlo = G.lon[p0] + (G.lon[p1] - G.lon[p0]) * t; break; }
          half -= d; mla = G.lat[p1]; mlo = G.lon[p1];
        }
        if (!fix) marks.push([+mla.toFixed(6), +mlo.toFixed(6), stair ? 1 : 0, Math.round(gr * 100), +dh.toFixed(1), Math.round(L), why]); }   // 階段じゃない／階段だった の印がある道は マークを出さない（印と同じ所に かさなるので）
      for (let i = 1; i < path.length; i++) for (const [u, v] of [[path[i - 1], path[i]], [path[i], path[i - 1]]]) {
        const e = edge(u, v); if (!e) continue;
        // 🪨 走りにくい の理由：前の倍率（rg）と くらべて 大きいほうにして、ほかの理由とは 足し算のまま
        const K = stair ? stK : slK, rg = e.rg || 1, sm = e.sm || e.c / e.L;
        if (K === "no") e.c *= 1e4;
        else if ((+K || 1) > rg) { const s2 = sm + (+K || 1) - rg; e.c *= s2 / sm; e.sm = s2; e.rg = +K; }
        if (stair) { e.k = "階段？"; e.dk = "steps"; }
      }
    }
  }
  if (k) for (let u = 0; u < n; u++) for (const e of G.adj[u]) {
    let dh = h[e.v] - h[u];
    if (!(dh > 0) || e.L < 3 || e.b) continue;
    dh = Math.min(dh, e.L * 0.15);
    e.c += dh * k;   // 急な所は ⛰急坂？・🪜階段？ の設定のほうで見るので、ここは のぼった高さだけ
  }
  if (marks.length && typeof self !== "undefined" && self.postMessage && typeof module === "undefined") self.postMessage({ type: "slope", marks });
  if (count) return { st, sl };
  if (st || sl) log(`標高で：🪜階段？ ${st}か所（${stK === "no" ? "通らない" : "×" + (+stK || 1)}）・⛰急坂？ ${sl}か所（×${+slK || 1}）`);
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
  await loadStairsAI();
  await loadAreas();   // 霊園・公園のほか、学校や工場の敷地（中の通路は通らない）にも使うので いつも読む
  // 標高：坂道・⛰急坂？・🪜階段？に使う。3つとも「気にしない」なら 取らない（マークも出ない）
  const stK0 = cfg && cfg.stepsGuess != null ? cfg.stepsGuess : DEFAULT_CFG.stepsGuess, slK0 = cfg && cfg.steep != null ? cfg.steep : DEFAULT_CFG.steep;
  const needDem = slopeK || stK0 === "no" || +stK0 !== 1 || +slK0 !== 1;
  const demP = needDem ? loadDem(s, g, pad + 0.005).catch(() => false) : Promise.resolve(false);
  const noLink = msg => Object.assign(new Error(msg), { noLink: true, usedPad: pad });
  // 長さの上限：道路データがぜんぶ手元にあれば 150km、ダウンロードが必要なら 30km（サーバーにやさしく・待たせすぎない）
  { const km = hav(s[0], s[1], g[0], g[1]) / 1000;
    if (km > 30 && !(await allLocal(tilesFor(s, g, pad))))
      throw new Error(`出発と目的地が ${km.toFixed(1)}km はなれてるよ。道路データのダウンロードが必要な所（${missN}マス）があるので、30km以内にしてね（配布データのある所なら150kmまでOK）`); }
  const tiles = tilesFor(s, g, pad), N = tiles.length;
  log(`==== ルート計算スタート ====`, "h");
  log(`出発 ${s[0].toFixed(5)},${s[1].toFixed(5)} → 目的地 ${g[0].toFixed(5)},${g[1].toFixed(5)}（まっすぐ ${(hav(s[0], s[1], g[0], g[1]) / 1000).toFixed(2)}km）`);
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
  let jarL = []; try { jarL = await jarPrep(tiles.map(t => bigOf(t.key)), cfg); } catch {}   // 🚓 横断禁止の線（取れなければ使わない）
  let rivR = null; try { const S0 = Math.min(s[0], g[0]) - pad, N0 = Math.max(s[0], g[0]) + pad, W0 = Math.min(s[1], g[1]) - pad, E0 = Math.max(s[1], g[1]) + pad;
    rivR = await rivPrep(S0, W0, N0, E0); if (rivR.n) log(`〰 川のデータ：${rivR.n}マス（川べりの道を見分ける）`); } catch { rivR = null; }   // 〰 川べりの道（取れなければ使わない）
  let warpR = null; if (cfg.warp != null && cfg.warp !== "off") { try { const S0 = Math.min(s[0], g[0]) - pad, N0 = Math.max(s[0], g[0]) + pad, W0 = Math.min(s[1], g[1]) - pad, E0 = Math.max(s[1], g[1]) + pad;
    warpR = await warpPrep(S0, W0, N0, E0, +cfg.warpMin || 1500); if (warpR && warpR.n) log(`➡️ シンプルパスのデータ：${warpR.n}マス（${(+cfg.warpMin || 1500) / 1000}km以上）`); } catch { warpR = null; } }   // 🌀（取れなければ使わない）
  const BG = (osm, c, p) => { const G0 = buildGraph(addPins(jarApply(osm, c, jarL), [s, g]), { ...(c || {}), _riv: rivR, _warp: warpR }, p); return demOK ? applySlope(G0, slopeK, c && c.stepsGuess != null ? c.stepsGuess : DEFAULT_CFG.stepsGuess, c && c.steep != null ? c.steep : DEFAULT_CFG.steep) : G0; };
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
        for (const e of got.get(t.key)) { const k = elKey(e); if (!seen.has(k)) { seen.add(k); elements.push(e); } }
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
  const conf = [], kinds = {}, ok = [], xw = [], ng = [], xvia = [], ek = [], tp = [];
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
          for (const e of got.get(t.key)) { const k = elKey(e); if (!seen.has(k)) { seen.add(k); elements.push(e); } }
        const tb = Date.now();
        G = BG({ elements }, cfg);
        tBuild += (Date.now() - tb) / 1000; nNodes = Math.max(nNodes, G.nNodes);
        { let ne = 0; for (const a of G.adj) ne += a.length;
          log(`道のつながり: データ ${elements.length}件 → 点 ${G.nNodes}個・道のつなぎ ${ne}本（${Date.now() - tb}ms）${G.swLen ? `・歩道のある道 ${(G.swLen / 1000).toFixed(1)}km` : ""}${G.nBlk ? `・🚫⚠印で変えた所 ${G.nBlk}か所` : ""}${wide ? "【範囲を広げてやりなおし】" : ""}`); }
        sn = confEnd != null ? G.idx.get(confEnd) : undefined;
        if (sn === undefined) {
          const q = nearestGood(G, s[0], s[1]);
          log(`出発の点: ${Math.round(q.d)}m先の道（つながり ${q.size}点）` + (q.seg ? `｜道の線まで ${q.seg}m なので、その道の はしの点を使うよ` : q.n !== q.nearestAny ? `｜いちばん近い点 ${Math.round(q.dAny)}m はつながり ${q.anySize}点しかないので使わない` : ""));
          if (q.n < 0 || q.d > 400) throw new Error("出発地のそばに、ほかとつながっている道が見つかりませんでした");
          sn = q.n;
        }
        stage = 3; report();
        const ts = Date.now();
        if (final) {
          // 出発とおなじ「つながりのかたまり」にある点だけをゴールにする（駅の中の通路などをさける）
          const q = nearestGood(G, g[0], g[1], sn);
          log(`目的地の点: ${Math.round(q.d)}m先の道（出発とつながっている）` + (q.seg ? `｜道の線まで ${q.seg}m なので、その道の はしの点を使うよ` : q.n !== q.nearestAny ? `｜いちばん近い点 ${Math.round(q.dAny)}m は出発とつながってないので使わない（つながり ${q.anySize}点）` : ""), q.d > 300 ? "w" : "i");
          if (q.n < 0 || q.d > 600) {
            if (!wide && lo > 0) { log("目的地のそばにつながる道がないので、範囲を広げて探しなおし", "w"); wide = true; continue; }
            throw noLink("目的地まで道がつながりませんでした。⚙ 設定の「地図データを取る広さ」を「ひろい」にするか、設定で「通らない」にしている道（階段・歩道橋など）をゆるめてみてね");
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
        addKinds(a.kinds); ok.push(...a.ok); xw.push(...a.xw); ng.push(...a.ng); xvia.push(...a.xvia); ek.push(...a.ek); tp.push(...a.tp); turns += a.turns; confLen += a.len;
        const pts = confPart.map(i => [G.lat[i], G.lon[i]]);
        conf.push(...(conf.length ? pts.slice(1) : pts));
        confEnd = G.ids[confPart[confPart.length - 1]];
        tConf = along(G.lat[confPart[confPart.length - 1]], G.lon[confPart[confPart.length - 1]]);
        log(`確定: +${(a.len / 1000).toFixed(2)}km（合計 ${(confLen / 1000).toFixed(2)}km）曲がる ${a.turns}回・信号 ${a.ok.length}・横断歩道 ${a.xw.length}・ルール外 ${a.ng.length}`, a.ng.length ? "w" : "ok");
      } else if (!final) log("今回は確定できる所がなかった（先のデータ待ち）");
      lastGraph = { G, sn: G.idx.get(G.ids[path[0]]) };
      wanderG = G;   // 🧭 ためし走行：わざと外れるとき、この道のつながりを使う
      if (final) break;
      const tentPts = tent.map(i => [G.lat[i], G.lon[i]]);
      partial({ route: conf.slice(), ek: ek.slice(), tent: tentPts, ok: ok.slice(), xw: xw.slice(), ng: ng.slice(), xvia: xvia.slice(), tp: tp.slice(), kinds: { ...kinds }, turns, len: confLen,
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
  if (!need.length && conf.length > 1 && !(cfg && (cfg.alts === false || cfg.alts === "no"))) prog({ stage: 4, msg: "ほかのルート（第2・第3）を計算中" });
  if (need.length && conf.length > 1 && !(cfg && (cfg.alts === false || cfg.alts === "no")))   // ダウンロードしたときは1本だけ（サーバーにやさしく・早く）
    log(`第2・第3のルートは出さないよ（道路データを ${need.length}マス ダウンロードしたので）`);
  else if (conf.length > 1 && !(cfg && (cfg.alts === false || cfg.alts === "no"))) {
    try {
      const ta = Date.now(), Dkm = hav(s[0], s[1], g[0], g[1]) / 1000;
      const offKm = Math.min(8, Math.max(1.5, Dkm * 0.25));        // 左右にずらす量（大きめ：遠くても ちがう道を）
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
      for (const t of altTiles) if (got.has(t.key)) for (const e of got.get(t.key)) { const k = elKey(e); if (!seen.has(k)) { seen.add(k); elements.push(e); } }
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
            if (a.len > mainLen * 1.7) return;                                         // 遠回りすぎ（1.7倍まではOK）
            if (picked.some(st => shared(p, st) > 0.3)) return;                         // 3割より多く同じ道
            const ov = shared(p, picked[0]);
            picked.push(setOf(p)); cands.push({ p, a, how, ov });
          };
          // ① まん中を左右にずらした地点を通る
          const c0 = Math.cos(s[0] * RAD), ex = (g[1] - s[1]) * c0 * 111.32, ny = (g[0] - s[0]) * 111.32, Lk = Math.hypot(ex, ny) || 1;
          const px = -ny / Lk, py = ex / Lk, mla = (s[0] + g[0]) / 2, mlo = (s[1] + g[1]) / 2;
          for (const [sg, kk] of [[1, 1], [-1, 1], [1, 0.5], [-1, 0.5]]) {   // 大きく・半分 左右にずらす
            const vla = mla + sg * py * offKm * kk / 111.32, vlo = mlo + sg * px * offKm * kk / (111.32 * c0);
            const qv = nearestGood(G, vla, vlo, qs.n); if (qv.n < 0 || qv.d > 1500) continue;
            const ra = search(G, qs.n, qv.n, [G.lat[qv.n], G.lon[qv.n]], false); if (ra.goal < 0) continue;
            const rb = search(G, qv.n, qg.n, g, false); if (rb.goal < 0) continue;
            const p1 = pathTo(ra.prev, ra.goal), p2 = pathTo(rb.prev, rb.goal);
            let k = 0; while (k + 1 < p2.length && p1.length - 2 - k >= 0 && p1[p1.length - 2 - k] === p2[1 + k]) k++;   // 行って戻るムダをけずる
            tryPath(p1.slice(0, p1.length - k).concat(p2.slice(1 + k)), sg > 0 ? "左まわり" : "右まわり");
          }
          // ② 使った道と そのまわり（約150m・となりの平行な道も）を通りにくくしてさがしなおす
          const cellK = (la, lo) => Math.round(la * 740) + "," + Math.round(lo * 600);
          const penal = p => { const cs = new Set();
            for (let i = 0; i < p.length; i++) { const u = p[i]; cs.add(cellK(G.lat[u], G.lon[u]));
              if (i) { const w = p[i - 1], n = Math.floor(eLen(w, u) / 60); for (let k = 1; k <= n; k++) cs.add(cellK(G.lat[w] + (G.lat[u] - G.lat[w]) * k / (n + 1), G.lon[w] + (G.lon[u] - G.lon[w]) * k / (n + 1))); } }
            for (let u = 0; u < G.adj.length; u++) { if (!G.adj[u] || !cs.has(cellK(G.lat[u], G.lon[u]))) continue; for (const e of G.adj[u]) if (cs.has(cellK(G.lat[e.v], G.lon[e.v]))) e.c *= 2.5; }
            for (let i = 1; i < p.length; i++) { const u = p[i - 1], v = p[i];
              for (const e of G.adj[u]) if (e.v === v) e.c *= 3; for (const e of G.adj[v]) if (e.v === u) e.c *= 3; } };
          let last = p0;
          for (let tries = 0; tries < 5 && cands.length < 6; tries++) {
            penal(last);
            const r1 = search(G, qs.n, qg.n, g, false); if (r1.goal < 0) break;
            last = pathTo(r1.prev, r1.goal); tryPath(last, "べつの道");
          }
          cands.sort((a, b) => (a.ov - b.ov) || (a.a.len - b.a.len));   // いちばんのルートと 重なりが少ないものから（遠くてもOK）
          for (const { p, a } of cands.slice(0, 2))
            alts.push({ route: p.map(u => [G.lat[u], G.lon[u]]), ek: a.ek, ok: a.ok, xw: a.xw, ng: a.ng, xvia: a.xvia, tp: a.tp, kinds: a.kinds, turns: a.turns, len: a.len });
          log(`ほかのルート: 候補 ${cands.length}本（${cands.map(c => c.how + " " + (c.a.len / 1000).toFixed(1) + "km").join("・") || "なし"}）`);
        }
      }
      log(`ほかのルート: ${alts.length}本（${alts.map(a => (a.len / 1000).toFixed(2) + "km").join("・") || "ちがう道が見つからなかった"}・考えた範囲 まわり${(wpad * 111).toFixed(1)}km${altTiles === tiles ? "（広げられなかった）" : ""}・${Date.now() - ta}ms）`);
    } catch (e) { log("ほかのルートを出せなかった: " + e.message, "w"); alts = []; }
  }
  const T = (Date.now() - T0) / 1000;
  log(`==== 完了 ${(confLen / 1000).toFixed(2)}km・${T.toFixed(1)}秒（ダウンロード ${done}マス ${kb(bytes)}・つながり ${tBuild.toFixed(1)}秒・探索 ${tSearch.toFixed(1)}秒） ====`, "ok");
  return { route: conf, ek, ok, xw, ng, xvia, tp, kinds, turns, len: confLen, nNodes, sec: T, tiles: N, saved, bytes, alts,
    tLoad: Math.max(0, T - tBuild - tSearch), tBuild, tSearch };
}
// 「ただの最短」はくらべる用。順番に確定する方式では出さない
function shortest() { return null; }

// ---------- 🧭 ためし走行：分かれ道で わざとルートを外れる ----------
const wKey = (la, lo) => la.toFixed(7) + "," + lo.toFixed(7);
function wanderIndex(G) {   // 点（緯度・経度）→ 道の番号（いちどだけ作る）
  if (!wanderHash || wanderHash.G !== G) { const m = new Map(); for (let i = 0; i < G.lat.length; i++) if (G.inGraph[i]) m.set(wKey(G.lat[i], G.lon[i]), i); wanderHash = { G, m }; }
  return wanderHash.m;
}
// ルートの点のうち、ルート以外にも道がつながる交差点（3方向以上）を 一覧にする。返すのは［ルートの何番目の点・ルート以外へ行ける道の数］
function wanderJunctions(pts) {
  const G = wanderG; wanderJ = [];
  if (!G || !Array.isArray(pts)) return { junc: [] };
  const M = wanderIndex(G), ix = pts.map(p => M.get(wKey(p[0], p[1])));
  for (let k = 1; k < pts.length - 1; k++) {
    const u = ix[k], pv = ix[k - 1], nx = ix[k + 1];
    if (u === undefined || pv === undefined || nx === undefined || !G.adj[u]) continue;
    const nb = [...new Set(G.adj[u].map(e => e.v))];
    if (nb.length < 3) continue;
    const br = nb.filter(v => v !== pv && v !== nx && v !== u);
    if (br.length) wanderJ.push({ k, u, br });
  }
  return { junc: wanderJ.map(j => ({ k: j.k, n: j.br.length })) };
}
// 分かれ道 j の、br[b] の道へ入って、ランダムに lenM 分走る（Uターンはしない）。点の列［緯度,経度］を返す
function wanderWalkOne(j, b, lenM) {
  const G = wanderG, J = wanderJ[j];
  if (!G || !J || J.br[b] === undefined) return { pts: [] };
  let prev = J.u, cur = J.br[b], d = 0, guard = 0;
  const pts = [[G.lat[prev], G.lon[prev]], [G.lat[cur], G.lon[cur]]];
  while (d < lenM && guard++ < 3000) {
    const opts = (G.adj[cur] || []).filter(e => e.v !== prev && G.inGraph[e.v]);
    if (!opts.length) break;
    const e = opts[Math.floor(Math.random() * opts.length)];
    d += hav(G.lat[cur], G.lon[cur], G.lat[e.v], G.lon[e.v]);
    pts.push([G.lat[e.v], G.lon[e.v]]); prev = cur; cur = e.v;
  }
  return { pts };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof module === "undefined") {
  logFn = m => self.postMessage({ type: "log", ...m });
  self.onmessage = async ev => {
    const d = ev.data;
    try {
      if (d.cmd === "stats") return self.postMessage({ type: "stats", ...(await stats()) });
      if (d.cmd === "hol") { jarHol = new Set(d.days || []); return; }
      if (d.cmd === "clear") { await clearAll(); return self.postMessage({ type: "stats", ...(await stats()) }); }
      if (d.cmd === "pack") {   // 配布データの場所。一覧を読んで、地図に「すぐ使える所」を出せるように画面に送る
        packBase = d.base; packIdx = null;
        const p = await packIndex();
        if (p && p.size) self.postMessage({ type: "packinfo", keys: [...p], empty: packEmpty ? [...packEmpty] : [] });
        return;
      }
      if (d.cmd === "packAll") { pkStop = false; await packAll(p => self.postMessage({ type: "pk", ...p }), d.at); return self.postMessage({ type: "stats", ...(await stats()) }); }
      if (d.cmd === "packStop") { pkStop = true; return; }
      if (d.cmd === "footLive") { const segs = await footLive(d.t0, d.pair); return self.postMessage({ type: "footLive", segs }); }
      if (d.cmd === "footMatch") { const segs = await footMatch(d.runs); return self.postMessage({ type: "footMatch", id: d.id, segs }); }
      if (d.cmd === "painted") { paintedSet = new Set(d.keys || []); return; }   // 👣 もう塗った道（画面から）
      if (d.cmd === "slopeView") { okPts = Array.isArray(d.oks) ? d.oks : []; const r = await slopeView(d.bb); return self.postMessage({ type: "slopeView", ...r }); }
      if (d.cmd === "oneway") { const r = await onewayIn(d.bb); return self.postMessage({ type: "oneway", id: d.id, ...r }); }
      if (d.cmd === "jarSig") { const r = await jarSigIn(d.bb, d.cfg).catch(e => ({ err: e.message, sigs: [] })); return self.postMessage({ type: "jarSig", id: d.id, who: d.who, ...r }); }
      if (d.cmd === "wanderPrep") return self.postMessage({ type: "wanderPrep", id: d.id, ...wanderJunctions(d.pts) });   // 🧭 分かれ道の一覧
      if (d.cmd === "wander") return self.postMessage({ type: "wander", id: d.id, ...wanderWalkOne(d.j, d.b, d.len) });   // 🧭 外れた道を走る点の列
      if (d.cmd === "dbgView") { const r = await dbgView(d.bb, d.cfg, d.opt).catch(e => ({ err: e.message })); return self.postMessage({ type: "dbgView", id: d.id, tag: d.tag, ...r }); }
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
      AVOID_PEN = Math.max(1, +(d.cfg && d.cfg.avoidPen) || 10);
      PAINT_PEN = Math.max(1, +(d.cfg && d.cfg.paintPen) || 1);
      preferPts = Array.isArray(d.prefers) ? d.prefers : [];
      okPts = Array.isArray(d.oks) ? d.oks : [];
      otherUsed = null;
      if (Array.isArray(d.others) && d.others.length) { const keep = usedNodes; usedNodes = new Set(); for (const r of d.others) markUsed(r); otherUsed = usedNodes; usedNodes = keep;   // 🔄 前のルート（いくつでも）
        // 出発・目的地のまわり（約400m）は さけない（どのルートも通るので）
        const ends = [d.s, d.g].filter(Boolean); for (const k of [...otherUsed]) { const [a, b] = k.split(",").map(Number), la = a / 600, lo = b / 490; if (ends.some(p => hav(la, lo, p[0], p[1]) < 400)) otherUsed.delete(k); } }
      PREFER_K = Math.min(1, Math.max(0.2, +(d.cfg && d.cfg.preferK) || 0.5));
      const pr = p => self.postMessage({ type: "prog", ...p, frac: p.frac !== undefined ? p.frac : stageFrac(p) ?? undefined });
      const r = d.tour ? await tourRoute(d, pr) : d.loop ? await loopRoute(d, pr) : await route(d, pr, p => self.postMessage({ type: "partial", ...p }));
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
if (typeof module !== "undefined") module.exports = { wanderJunctions, wanderWalkOne, setWanderG: g => { wanderG = g; }, dbgView, _mem: () => mem, _setPaint: (k, p) => { paintedSet = new Set(k); PAINT_PEN = p; }, applySlope, demCache, heightAt, demXY, tileEls, nearestGood, shortest, padFor, buildGraph, dijkstra, analyze, nearest, route, isWide, wayCost, overpassQuery, tilesFor, DEFAULT_CFG };
