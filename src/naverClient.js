// 네이버 커머스API 연동 모듈
//
// 인증(OAuth2 토큰 발급) 로직은 네이버 커머스API 공식 규격을 따릅니다.
// (참고: https://apicenter.commerce.naver.com , type=SELF 방식)
//
// 상품/재고, 주문 조회 API의 정확한 경로·파라미터는 네이버 쪽 사정으로
// 종종 바뀝니다. 아래 fetchProducts / fetchRecentOrders 두 함수 안의
// API_ENDPOINTS 상수만 확인하시면 되고, 만약 호출이 실패하면 네이버가
// 내려주는 에러 메시지를 콘솔에 그대로 출력하도록 만들어뒀습니다.
// 에러 메시지 + 아래 공식 문서를 같이 보면 대부분 바로 원인을 알 수 있어요.
//   공식 문서: https://apicenter.commerce.naver.com/ko/basic/commerce-api
//   기술 Q&A: https://github.com/commerce-api-naver/commerce-api/discussions

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const BASE_URL = "https://api.commerce.naver.com/external";

// 이 두 경로는 네이버 문서 기준 최신 버전으로 넣어뒀지만,
// 연동 전 반드시 공식 문서에서 한 번 더 확인해주세요.
const API_ENDPOINTS = {
  token: `${BASE_URL}/v1/oauth2/token`,
  productSearch: `${BASE_URL}/v1/products/search`,
  // 옵션(색상 등)별 재고는 상품 목록에 없고 원상품 상세에만 있다 (2026-09 확인: optionInfo.optionCombinations[])
  originProduct: `${BASE_URL}/v2/products/origin-products`,
  productOrders: `${BASE_URL}/v1/pay-order/seller/product-orders`,
};

// 원상품 상세는 상품마다 한 번씩 불러야 하고 호출 제한(GW.RATE_LIMIT)이 빡빡해서, 결과를 파일에 남겨 두고
// 상품이 수정됐거나(modifiedDate) 옵션 상품의 전체 재고가 바뀌었을 때만 다시 부른다.
// { [originProductNo]: { modifiedDate, stockQuantity, checkedAt, options: null | [{ id, names:[..], stockQuantity, price }] } }
// 목록에 넣는 상품 상태 (2026-09 실제 응답: SALE · OUTOFSTOCK · SUSPENSION(판매중지) 확인)
const SELLING_STATUSES = new Set(["SALE", "OUTOFSTOCK"]);

const CACHE_DIR =process.env.NAVER_CACHE_DIR || path.join(__dirname, "..", "data");
const OPTION_CACHE_FILE = path.join(CACHE_DIR, "naver-options.json");
const OPTION_MAX_AGE_MS = 30 * 60 * 1000; // 옵션 상품은 전체 재고가 그대로여도 30분 지나면 다시 확인 (한 번에 몇 개씩)
const OPTION_AGING_PER_FETCH = 4;
const OPTION_WAIT_MS = 8000; // 옵션을 처음 받을 때 화면이 기다려 주는 최대 시간

// 주문은 하루 단위로만 조회돼서 30일이면 31번 불러야 한다(15초 넘게). 날짜별로 파일에 남겨 두고
// 최근 며칠(취소 · 반품 · 새 주문이 생기는 기간)만 매번 다시 받는다.
// { chunks: { "2026-09-29": { fetchedAt, orders: [...] } } }
const ORDER_CACHE_FILE = path.join(CACHE_DIR, "naver-orders.json");
const ORDER_RECENT_DAYS = 7; // 이 안의 날짜는 매번 다시 받는다
const ORDER_KEEP_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

let cachedToken = null; // { accessToken, expiresAt }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 커머스API 인증 토큰 발급용 서명값 생성
 * 공식 규격: password = `${client_id}_${timestamp}`
 *           client_secret 을 bcrypt salt로 사용해 password를 해시
 *           결과를 base64로 인코딩한 값이 client_secret_sign
 */
function signClientSecret(clientId, timestamp, clientSecret) {
  const password = `${clientId}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  return Buffer.from(hashed, "utf-8").toString("base64");
}

async function getAccessToken() {
  const now = Date.now();
  // 토큰은 3시간 유효. 30분 이상 남았으면 재사용 (네이버 권장 방식)
  if (cachedToken && cachedToken.expiresAt - now > 30 * 60 * 1000) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET이 .env에 설정되어 있지 않습니다."
    );
  }

  const timestamp = Date.now();
  const clientSecretSign = signClientSecret(clientId, timestamp, clientSecret);

  const body = new URLSearchParams({
    client_id: clientId,
    timestamp: String(timestamp),
    client_secret_sign: clientSecretSign,
    grant_type: "client_credentials",
    type: "SELF",
  });

  const res = await fetch(API_ENDPOINTS.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `[네이버 인증 토큰 발급 실패] status=${res.status} body=${text}\n` +
        `-> 공식 문서의 인증 규격과 client_id/secret 값을 다시 확인해주세요.`
    );
  }

  const data = JSON.parse(text);
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in ? data.expires_in * 1000 : 3 * 60 * 60 * 1000),
  };
  return cachedToken.accessToken;
}

async function authedFetch(url, options = {}) {
  const token = await getAccessToken();
  let res;
  // 호출 제한(429)에 걸리면 조금 쉬었다가 다시 부른다
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (res.status !== 429 || attempt >= 4) break;
    await sleep(1000 * 2 ** attempt);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `[네이버 API 호출 실패] url=${url} status=${res.status} body=${text}\n` +
        `-> 아래 문서에서 해당 API의 최신 요청 규격을 확인해주세요.\n` +
        `   https://apicenter.commerce.naver.com/ko/basic/commerce-api`
    );
  }
  return text ? JSON.parse(text) : null;
}

/**
 * 전체 상품 + 현재 재고수량 조회
 * 반환 형식을 앱 내부 공통 형식으로 맞춰서 돌려줍니다.
 * 실제 API 응답 필드명이 다르면 이 함수 안의 매핑 부분만 고치면 됩니다.
 */
async function fetchProducts() {
  const products = [];
  const originNos = []; // products 와 같은 순서의 원상품 번호 (옵션 조회용)
  let page = 1;
  const size = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await authedFetch(API_ENDPOINTS.productSearch, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page, size, orderType: "NO", periodType: "PROD_REG_DAY" }),
    });

    const items = data?.contents || data?.data?.contents || [];
    if (items.length === 0) break;

    for (const item of items) {
      const channelProduct = item.channelProducts ? item.channelProducts[0] : item;
      // 판매중지 · 판매종료 등 더 안 파는 상품은 빼고, 판매중 · 품절(발주해야 함)만 (상태가 없으면 그대로 둔다)
      const status = channelProduct.statusType ?? item.statusType;
      if (status && !SELLING_STATUSES.has(status)) continue;
      products.push({
        id: String(channelProduct.channelProductNo ?? channelProduct.originProductNo ?? item.originProductNo),
        name: channelProduct.name ?? channelProduct.channelProductName ?? "이름 없음",
        stockQuantity: Number(channelProduct.stockQuantity ?? 0),
        salePrice: Number(channelProduct.salePrice ?? 0),
        // 대표 사진 (사진으로 보기 카드에 씀). 2026-09 실제 응답에서 channelProducts[].representativeImage.url 확인
        imageUrl: channelProduct.representativeImage?.url ?? item.representativeImage?.url ?? null,
      });
      originNos.push({ no: item.originProductNo ?? channelProduct.originProductNo, modifiedDate: channelProduct.modifiedDate ?? null });
    }

    if (items.length < size) break;
    page += 1;
    if (page > 50) break; // 안전장치
  }

  const optionsByOrigin = await loadOptions(products, originNos);
  return products.flatMap((p, i) => splitByOption(p, optionsByOrigin[originNos[i].no]));
}

// 파일로 남겨 두는 네이버 데이터 (옵션 정보 · 날짜별 주문). 테스트에서는 NAVER_CACHE_DIR 로 다른 폴더를 쓴다
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

function writeJsonFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), "utf-8");
  } catch (err) {
    console.error("네이버 데이터 저장 실패:", err.message);
  }
}

// 여러 개를 동시에 limit 개씩 처리 (네이버는 초당 3번 정도까지 받아준다. 넘치면 authedFetch 가 쉬었다가 다시 부름)
async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

// 원상품 상세의 옵션 조합 → [{ id, names, stockQuantity, price }] (재고 관리하는 옵션이 없으면 null)
function readOptionCombinations(detail) {
  const info = detail?.originProduct?.detailAttribute?.optionInfo;
  if (!info || info.useStockManagement === false) return null;
  const combos = (info.optionCombinations || []).filter((c) => c.usable !== false);
  if (!combos.length) return null;
  return combos.map((c) => ({
    id: String(c.id),
    names: [c.optionName1, c.optionName2, c.optionName3, c.optionName4].filter((n) => n !== undefined && n !== null && String(n).trim() !== "").map(String),
    stockQuantity: Number(c.stockQuantity ?? 0),
    price: Number(c.price ?? 0),
  }));
}

let optionCache = null; // 파일 내용을 메모리에 들고 있는다
let optionJob = null; // 뒤에서 옵션을 받는 중이면 그 작업

// 상품마다 옵션을 확인한다. 처음엔 상품 수만큼 불러야 해서(99개면 30초 넘게) 최대 OPTION_WAIT_MS 만 기다리고,
// 못 받은 상품은 일단 한 줄로 보여준 채 뒤에서 마저 받는다. 그 뒤로는 바뀐 상품만 다시 부른다:
//  - 상품을 수정했거나(modifiedDate) 옵션 상품의 전체 재고가 바뀌었을 때 (팔리거나 입고되면 바뀜)
//  - 전체 재고는 그대로인데 옵션끼리 재고가 바뀌었을 수도 있어서, 오래된 옵션 상품을 한 번에 몇 개씩 돌아가며 다시 확인
async function loadOptions(products, originNos) {
  if (!optionCache) optionCache = readJsonFile(OPTION_CACHE_FILE);
  const cache = optionCache;
  const now = Date.now();
  const todo = [];
  const aging = [];
  products.forEach((p, i) => {
    const { no, modifiedDate } = originNos[i];
    if (no === undefined || no === null) return;
    const entry = cache[no];
    const job = { no, modifiedDate, stockQuantity: p.stockQuantity };
    if (!entry || entry.modifiedDate !== modifiedDate || (entry.options && entry.stockQuantity !== p.stockQuantity)) todo.push(job);
    else if (entry.options && now - entry.checkedAt > OPTION_MAX_AGE_MS) aging.push({ ...job, checkedAt: entry.checkedAt });
  });
  aging.sort((a, b) => a.checkedAt - b.checkedAt);
  todo.push(...aging.slice(0, OPTION_AGING_PER_FETCH));

  // 스토어에서 지운 상품은 정리
  const alive = new Set(originNos.map((o) => String(o.no)));
  for (const no of Object.keys(cache)) if (!alive.has(no)) delete cache[no];

  if (todo.length && !optionJob) {
    optionJob = mapLimit(todo, 2, async (job) => {
      try {
        const detail = await authedFetch(`${API_ENDPOINTS.originProduct}/${job.no}`, { method: "GET" });
        cache[job.no] = { modifiedDate: job.modifiedDate, stockQuantity: job.stockQuantity, checkedAt: Date.now(), options: readOptionCombinations(detail) };
      } catch (err) {
        // 한 상품이 실패해도 목록은 보여준다 (예전에 받아 둔 옵션이 있으면 그걸로, 없으면 옵션 없이)
        console.error(`옵션 조회 실패 (상품 ${job.no}):`, err.message.split("\n")[0]);
      }
    }).finally(() => {
      writeJsonFile(OPTION_CACHE_FILE, cache);
      optionJob = null;
    });
  }
  if (optionJob) await Promise.race([optionJob, sleep(OPTION_WAIT_MS)]);
  return Object.fromEntries(Object.entries(cache).map(([no, e]) => [no, e.options]));
}

// 옵션이 있는 상품은 옵션마다 한 줄 (재고 · 판매를 옵션별로 따로 계산해야 한 색만 품절돼도 알 수 있다)
// 옵션 줄 id = "상품번호_옵션번호", parentId = 상품번호
function splitByOption(p, options) {
  if (!options?.length) return [p];
  return options.map((o) => {
    const optionName = o.names.join(" / ") || "옵션";
    return {
      ...p,
      id: `${p.id}_${o.id}`,
      parentId: p.id,
      name: `${p.name} (${optionName})`,
      productName: p.name,
      optionName,
      optionNames: o.names,
      stockQuantity: o.stockQuantity,
      salePrice: p.salePrice + o.price,
    };
  });
}

// 판매로 세지 않는 주문 상태: 결제 전, 취소, 반품
function countsAsSale(status) {
  if (!status) return true;
  return !/^(PAYMENT_WAITING|CANCELED|CANCELED_BY_NOPAYMENT|RETURNED)$/.test(status) && !status.startsWith("CANCEL") && !status.startsWith("RETURN");
}

// 하루치(dayStart ~ 그날 끝 또는 지금) 주문. 판매 여부는 나중에 거르므로 상태도 같이 남긴다
async function fetchOrdersBetween(from, to) {
  const orders = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), page: String(page) });
    const data = await authedFetch(`${API_ENDPOINTS.productOrders}?${params.toString()}`, { method: "GET" });

    // 실제 응답(2026-09 확인): data.contents[] = { productOrderId, content: { order, productOrder, delivery } }
    // 예전 코드는 content 한 단계를 빼먹어 모든 주문이 품목 없음·수량 0 으로 읽혀 판매 속도가 전부 0 이었다.
    const pageOrders = data?.data?.contents ?? data?.contents ?? [];
    for (const o of pageOrders) {
      const c = o.content ?? o;
      const po = c.productOrder ?? {};
      orders.push({
        id: String(o.productOrderId ?? po.productOrderId ?? ""),
        status: po.productOrderStatus ?? "",
        productId: String(po.productId ?? ""),
        quantity: Number(po.quantity ?? 0),
        // 옵션 상품이면 "색상: 021 Yellow" 같은 글자. 서버에서 옵션 줄에 맞춰 준다 (src/productOptions.js)
        optionText: po.productOption ? String(po.productOption) : "",
        orderedAt: c.order?.paymentDate ?? c.order?.orderDate ?? po.placeOrderDate ?? null,
      });
    }

    const hasNext = data?.data?.pagination?.hasNext ?? false;
    if (!hasNext) break;
    page += 1;
  }
  return orders;
}

function localDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 최근 N일간 상품주문 내역 조회 (판매속도 계산용)
 * 반환: [{ productId, quantity, optionText, orderedAt }]
 *
 * 네이버 커머스API는 from~to 기간을 최대 24시간까지만 허용해서 하루씩 나눠 부른다.
 * 날짜별 결과를 파일에 남겨 두고, 최근 ORDER_RECENT_DAYS 일만 매번 다시 받는다 (새로고침 17초 → 3~4초).
 * 오래된 날짜도 그 뒤 일주일이 지나기 전에 받아 둔 것이면 하루에 한 번 다시 받는다 (늦게 들어온 취소 · 반품).
 */
async function fetchRecentOrders(days) {
  const now = new Date();
  const since = now.getTime() - days * DAY_MS;
  const cache = readJsonFile(ORDER_CACHE_FILE);
  const chunks = cache.chunks || {};

  const dayList = [];
  const d = new Date(since);
  d.setHours(0, 0, 0, 0);
  for (; d.getTime() <= now.getTime(); d.setDate(d.getDate() + 1)) {
    const from = new Date(d);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const to = new Date(Math.min(next.getTime() - 1, now.getTime()));
    dayList.push({ key: localDayKey(from), from, to, end: next.getTime() });
  }

  const toFetch = dayList.filter(({ key, end }) => {
    const c = chunks[key];
    if (!c || end > now.getTime() - ORDER_RECENT_DAYS * DAY_MS) return true;
    const settled = c.fetchedAt >= end + ORDER_RECENT_DAYS * DAY_MS;
    return !settled && now.getTime() - c.fetchedAt > DAY_MS;
  });
  await mapLimit(toFetch, 2, async ({ key, from, to }) => {
    chunks[key] = { fetchedAt: Date.now(), orders: await fetchOrdersBetween(from, to) };
  });

  // 오래된 날짜 정리 후 저장
  const oldest = localDayKey(new Date(now.getTime() - ORDER_KEEP_DAYS * DAY_MS));
  for (const key of Object.keys(chunks)) if (key < oldest) delete chunks[key];
  if (toFetch.length) writeJsonFile(ORDER_CACHE_FILE, { chunks });

  // 같은 상품주문이 여러 날짜에 나오면(상태가 바뀐 날에도 다시 나올 수 있음) 나중 날짜의 상태를 쓴다
  const byId = new Map();
  const noId = [];
  for (const { key } of dayList) {
    for (const o of chunks[key]?.orders || []) {
      if (o.id) byId.set(o.id, o);
      else noId.push(o);
    }
  }
  return [...byId.values(), ...noId]
    .filter((o) => countsAsSale(o.status) && (!o.orderedAt || new Date(o.orderedAt).getTime() >= since))
    .map(({ productId, quantity, optionText, orderedAt }) => ({ productId, quantity, optionText, orderedAt }));
}

module.exports = { fetchProducts, fetchRecentOrders, getAccessToken };
