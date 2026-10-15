const fs = require("fs");
const path = require("path");

// 시장 조사: 네이버 쇼핑 검색 API(developers.naver.com, 커머스API 와 다른 키)로
// 단어를 검색해서 경쟁 상품 · 가격대 · 우리 스토어에 없는 품목 단어를 보여준다.
// 마음에 드는 상품은 '후보'로 담아 원가를 넣으면 마진율을 계산한다.
//
// data/market.json: { keywords: [최근 검색어], storeMall: "우리 스토어 이름(자동으로 알아냄)", feePercent, candidates: { [id]: {...} } }
// data/market-cache.json: 검색 결과 캐시 (백업하지 않음)
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE_PATH = path.join(DATA_DIR, "market.json");
const CACHE_PATH = path.join(DATA_DIR, "market-cache.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 같은 단어는 6시간 동안 다시 부르지 않음 (하루 2만 5천 번 제한)
const CACHE_MAX = 40;
const PAGES = 3; // 100개씩 3번 = 300개
const MAX_KEYWORDS = 12;
const DEFAULT_FEE_PERCENT = 6; // 스마트스토어 수수료 대략 (결제 · 매출연동). 화면에서 바꿀 수 있음
// 중국에서 살 때 물건값(위안 × 환율)에 더 붙는 비용: 중국 내 배송 · 국제 배송 · 관세 · 부가세 · 깨짐 손실을 대략 % 로. 화면에서 바꿀 수 있음
const DEFAULT_EXTRA_PERCENT = 40;
const DEFAULT_CNY_RATE = 200;
const RATE_TTL_MS = 12 * 60 * 60 * 1000;

// 상품 종류가 아니라 광고 · 수식어라서 '없는 품목 단어'에서 빼는 말
const STOPWORDS = new Set(`
만들기 재료 diy 세트 무료배송 국산 정품 고급 대용량 소량 낱개 묶음 개입 사이즈 컬러 색상 선택 모음 종류 인기 추천 신상 특가 할인
당일발송 당일 발송 배송 공예 공예용 미술 미술용 학교 체험 교육 교육용 키트 준비물 수업 선물 용품 부자재 소품 인테리어 장식 장식용
옵션 택1 1개 2개 3개 5개 10개 단품 상품 제품 판매 전문 공방 홈 the and for
미니 소형 중형 대형 소사이즈 중사이즈 대사이즈 빅
`.split(/\s+/).filter(Boolean));

function readAll() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
    return {
      keywords: d.keywords || [], storeMall: d.storeMall || "", feePercent: d.feePercent ?? DEFAULT_FEE_PERCENT,
      extraPercent: d.extraPercent ?? DEFAULT_EXTRA_PERCENT, cnyRate: d.cnyRate || null, candidates: d.candidates || {},
    };
  } catch {
    return { keywords: [], storeMall: "", feePercent: DEFAULT_FEE_PERCENT, extraPercent: DEFAULT_EXTRA_PERCENT, cnyRate: null, candidates: {} };
  }
}

function writeAll(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  const entries = Object.entries(cache).sort((a, b) => b[1].fetchedAt.localeCompare(a[1].fetchedAt)).slice(0, CACHE_MAX);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(entries)), "utf-8");
}

function keysSet() {
  return !!(String(process.env.NAVER_SEARCH_CLIENT_ID || "").trim() && String(process.env.NAVER_SEARCH_CLIENT_SECRET || "").trim());
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" }[e]));
}

// 상품 이름 비교용: 띄어쓰기 · 기호 빼고 소문자
function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
}

function tokens(s) {
  return String(s || "").toLowerCase().split(/[^0-9a-z가-힣]+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !/^\d+(mm|cm|m|g|kg|ml|p|t|개|매|장|롤)$/.test(t));
}

class SearchKeyError extends Error {}

async function callSearch(query, start, keys = {}, display = 100) {
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=${display}&start=${start}&sort=sim&exclude=used:rental`;
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, {
      headers: {
        "X-Naver-Client-Id": String(keys.id ?? process.env.NAVER_SEARCH_CLIENT_ID ?? "").trim(),
        "X-Naver-Client-Secret": String(keys.secret ?? process.env.NAVER_SEARCH_CLIENT_SECRET ?? "").trim(),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new SearchKeyError("검색 키가 맞지 않아요. Client ID 와 Client Secret 을 서로 바꿔 넣지 않았는지, 등록할 때 사용 API 에 '검색'을 골랐는지 확인해 주세요.");
  if (!res.ok) throw new Error(`네이버 쇼핑 검색에 실패했어요 (${res.status}${body.errorMessage ? `: ${body.errorMessage}` : ""})`);
  return body;
}

// 저장하기 전에 키가 맞는지 한 번 검색해 본다 (틀리면 SearchKeyError)
async function verifyKeys(id, secret) {
  await callSearch("글라스아트", 1, { id, secret }, 1);
}

async function fetchItems(query) {
  const items = [];
  let total = 0;
  for (let page = 0; page < PAGES; page++) {
    const body = await callSearch(query, page * 100 + 1);
    total = body.total || 0;
    for (const it of body.items || []) {
      items.push({
        id: String(it.productId),
        title: decodeEntities(it.title),
        link: it.link,
        image: it.image,
        price: Number(it.lprice) || 0,
        mallName: decodeEntities(it.mallName),
        // productType 1~3 = 가격비교(여러 판매처를 묶은 상품)
        multiSeller: ["1", "2", "3"].includes(String(it.productType)),
        brand: decodeEntities(it.brand),
        maker: decodeEntities(it.maker),
        category: [it.category1, it.category2, it.category3, it.category4].filter(Boolean).map(decodeEntities),
      });
    }
    if (items.length >= total || (body.items || []).length < 100) break;
  }
  return { items, total };
}

// 샘플 모드(키 없이 화면 확인용)
function sampleItems(query) {
  const words = ["글라스페인트", "유리물감", "썬캐쳐 키트", "크리스탈 프리즘", "마크라메 실", "풍경 종", "납선테이프", "아크릴판", "동테이프", "유리구슬", "드림캐쳐 링", "스테인드 필름"];
  const malls = ["유리공방몰", "만들기천국", "공예재료상회", "아트하우스", "글라스몰", "아틀리에 말리"];
  const items = [];
  for (let i = 0; i < 60; i++) {
    const w = words[i % words.length];
    items.push({
      id: `sample${i}`,
      title: `${query} ${w} ${["세트", "10개", "대용량", "미니"][i % 4]}`,
      link: "https://search.shopping.naver.com/",
      image: "",
      price: 3000 + ((i * 1370) % 27000),
      mallName: malls[i % malls.length],
      multiSeller: i % 9 === 0,
      brand: "",
      maker: "",
      category: ["생활/건강", "수집품", "공예", w],
    });
  }
  return { items, total: 1234 };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

/**
 * 검색 결과를 우리 스토어 상품과 비교해서 정리한다.
 * - 우리 스토어 이름은 결과 중 우리 상품과 이름이 같은 것의 판매처로 알아낸다 (사람이 입력하지 않음)
 * - 우리 상품 이름에 없는 단어 중 여러 판매처가 쓰는 말 = 우리가 안 파는 품목 후보
 */
function analyze(query, items, ourNames, storeMall) {
  const ourNorm = new Set(ourNames.map(normalize));
  let mall = storeMall;
  if (!mall) {
    const hit = items.find((it) => !it.multiSeller && ourNorm.has(normalize(it.title)));
    if (hit) mall = hit.mallName;
  }
  const isOurs = (it) => !!mall && it.mallName === mall;
  const others = items.filter((it) => !isOurs(it));

  const prices = others.map((it) => it.price).filter((p) => p > 0).sort((a, b) => a - b);
  const mallCount = new Map();
  for (const it of others) if (!it.multiSeller) mallCount.set(it.mallName, (mallCount.get(it.mallName) || 0) + 1);

  // 단어별로 몇 군데 판매처가 쓰는지 (한 판매처가 같은 단어를 여러 번 써도 1)
  const ourTokens = new Set(ourNames.flatMap(tokens));
  const queryTokens = new Set(tokens(query));
  const wordMalls = new Map();
  const wordItems = new Map();
  for (const it of others) {
    const seller = it.multiSeller ? `가격비교:${it.id}` : it.mallName;
    for (const t of new Set(tokens(it.title))) {
      if (STOPWORDS.has(t) || queryTokens.has(t)) continue;
      if (!wordMalls.has(t)) { wordMalls.set(t, new Set()); wordItems.set(t, 0); }
      wordMalls.get(t).add(seller);
      wordItems.set(t, wordItems.get(t) + 1);
    }
  }
  const words = [...wordMalls.entries()]
    .map(([word, sellers]) => ({ word, malls: sellers.size, items: wordItems.get(word), weHave: ourTokens.has(word) }))
    .filter((w) => w.malls >= 2)
    .sort((a, b) => b.malls - a.malls || b.items - a.items);

  return {
    storeMall: mall,
    ourCount: items.length - others.length,
    priceStats: prices.length ? { min: prices[0], p25: percentile(prices, 0.25), median: percentile(prices, 0.5), p75: percentile(prices, 0.75), max: prices[prices.length - 1] } : null,
    topMalls: [...mallCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
    missingWords: words.filter((w) => !w.weHave).slice(0, 24),
    sharedWords: words.filter((w) => w.weHave).slice(0, 12),
  };
}

async function search(query, { ourNames = [], sample = false, force = false } = {}) {
  const q = String(query || "").trim().replace(/\s+/g, " ");
  if (!q) throw new Error("찾을 단어를 넣어주세요.");
  if (q.length > 50) throw new Error("단어가 너무 길어요. 짧게 넣어주세요.");
  if (!sample && !keysSet()) throw new SearchKeyError("네이버 쇼핑 검색 키가 아직 없어요.");

  const cache = readCache();
  const cacheKey = normalize(q);
  let entry = cache[cacheKey];
  if (sample) {
    entry = { ...sampleItems(q), fetchedAt: new Date().toISOString() };
  } else if (force || !entry || Date.now() - new Date(entry.fetchedAt).getTime() > CACHE_TTL_MS) {
    entry = { ...(await fetchItems(q)), fetchedAt: new Date().toISOString() };
    cache[cacheKey] = entry;
    writeCache(cache);
  }

  const data = readAll();
  const analysis = analyze(q, entry.items, ourNames, data.storeMall);
  data.keywords = [q, ...data.keywords.filter((k) => normalize(k) !== cacheKey)].slice(0, MAX_KEYWORDS);
  if (!sample && analysis.storeMall && !data.storeMall) data.storeMall = analysis.storeMall;
  writeAll(data);

  return { query: q, total: entry.total, fetchedAt: entry.fetchedAt, items: entry.items, ...analysis };
}

// 위안 환율 (1위안 = ?원). 하루 두 번 정도 자동으로 받고, 못 받으면 지난 값 → 기본값
async function refreshCnyRate() {
  const d = readAll();
  if (d.cnyRate && Date.now() - new Date(d.cnyRate.at).getTime() < RATE_TTL_MS) return d.cnyRate;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/CNY", { signal: AbortSignal.timeout(4000) });
    const krw = Number((await res.json())?.rates?.KRW);
    if (!(krw > 0)) throw new Error("환율 응답 이상");
    const fresh = readAll();
    fresh.cnyRate = { value: Math.round(krw * 10) / 10, at: new Date().toISOString() };
    writeAll(fresh);
    return fresh.cnyRate;
  } catch (err) {
    console.error("위안 환율을 받지 못했어요:", err.message);
    return d.cnyRate || { value: DEFAULT_CNY_RATE, at: null };
  }
}

async function getState() {
  const cnyRate = await refreshCnyRate();
  const d = readAll();
  return {
    keysSet: keysSet(), keywords: d.keywords, storeMall: d.storeMall, feePercent: d.feePercent, extraPercent: d.extraPercent,
    cnyRate, candidates: listCandidates(d),
  };
}

function listCandidates(d = readAll()) {
  return Object.entries(d.candidates)
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

function addCandidate(item, query) {
  if (!item || !item.title) throw new Error("담을 상품 정보가 없어요.");
  const d = readAll();
  const id = `cand_${String(item.id || Date.now()).replace(/[^0-9a-z_]/gi, "")}`;
  if (!d.candidates[id]) {
    d.candidates[id] = {
      title: String(item.title).slice(0, 200),
      link: String(item.link || ""),
      image: String(item.image || ""),
      mallName: String(item.mallName || ""),
      marketPrice: Number(item.price) || 0,
      salePrice: Number(item.price) || 0,
      cost: null,
      cny: null,
      zhQuery: "",
      memo: "",
      query: String(query || ""),
      addedAt: new Date().toISOString(),
    };
    writeAll(d);
  }
  return { id, ...d.candidates[id] };
}

function toMoney(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,\s원]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new Error("금액은 0 이상 숫자로 넣어주세요.");
  return Math.round(n);
}

function updateCandidate(id, patch) {
  const d = readAll();
  const c = d.candidates[id];
  if (!c) throw new Error("후보를 찾을 수 없어요.");
  if ("salePrice" in patch) c.salePrice = toMoney(patch.salePrice) ?? 0;
  if ("cost" in patch) c.cost = toMoney(patch.cost);
  if ("memo" in patch) c.memo = String(patch.memo || "").slice(0, 1000);
  if ("zhQuery" in patch) c.zhQuery = String(patch.zhQuery || "").trim().slice(0, 100);
  if ("cny" in patch) {
    const v = String(patch.cny ?? "").replace(/[,\s¥元위안]/g, "");
    if (v === "") c.cny = null;
    else if (Number.isFinite(Number(v)) && Number(v) >= 0) c.cny = Math.round(Number(v) * 100) / 100;
    else throw new Error("위안 가격은 숫자로 넣어주세요 (예: 3.5)");
  }
  writeAll(d);
  return { id, ...c };
}

function deleteCandidate(id) {
  const d = readAll();
  delete d.candidates[id];
  writeAll(d);
}

function setPercent(key, v, max, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label}는 0~${max} 사이 숫자로 넣어주세요.`);
  const d = readAll();
  d[key] = n;
  writeAll(d);
  return n;
}
const setFeePercent = (v) => setPercent("feePercent", v, 50, "수수료");
const setExtraPercent = (v) => setPercent("extraPercent", v, 300, "추가 비용");

// 거래처 찾기: 사이트 검색 주소. 도매꾹은 옛 한글 방식(EUC-KR) 주소만 알아들어서 바꿔 넣는다
const SOURCING_SITES = {
  "1688": (q) => `https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=${encodeURIComponent(q)}`,
  taobao: (q) => `https://s.taobao.com/search?q=${encodeURIComponent(q)}`,
  domeggook: (q) => {
    let sw = encodeURIComponent(q);
    try {
      sw = [...require("iconv-lite").encode(q, "euc-kr")].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
    } catch {}
    return `https://www.domeggook.com/main/item/itemList.php?sfc=ttl&sf=ttl&sw=${sw}`;
  },
};
function sourcingUrl(site, q) {
  const make = SOURCING_SITES[site];
  const query = String(q || "").trim().slice(0, 100);
  if (!make || !query) return null;
  return make(query);
}

// 1688 사진 검색에 올릴 사진: 네이버 쇼핑 사진만 받아서 내려준다 (아무 주소나 대신 받아주지 않게)
async function fetchProductImage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !/(^|\.)(pstatic\.net|naver\.net)$/.test(u.hostname)) return null;
  const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const type = res.headers.get("content-type") || "image/jpeg";
  if (!type.startsWith("image/")) return null;
  return { type, buffer: Buffer.from(await res.arrayBuffer()) };
}

// 우리 스토어 이름을 잘못 알아냈을 때 다시 알아내게
function resetStoreMall() {
  const d = readAll();
  d.storeMall = "";
  writeAll(d);
}

module.exports = {
  search, verifyKeys, getState, addCandidate, updateCandidate, deleteCandidate, setFeePercent, setExtraPercent, resetStoreMall,
  sourcingUrl, fetchProductImage, keysSet, SearchKeyError,
  _test: { analyze, tokens, normalize },
};
