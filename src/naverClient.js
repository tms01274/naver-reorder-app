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

const bcrypt = require("bcryptjs");

const BASE_URL = "https://api.commerce.naver.com/external";

// 이 두 경로는 네이버 문서 기준 최신 버전으로 넣어뒀지만,
// 연동 전 반드시 공식 문서에서 한 번 더 확인해주세요.
const API_ENDPOINTS = {
  token: `${BASE_URL}/v1/oauth2/token`,
  productSearch: `${BASE_URL}/v1/products/search`,
  productOrders: `${BASE_URL}/v1/pay-order/seller/product-orders`,
};

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
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
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
      products.push({
        id: String(channelProduct.channelProductNo ?? channelProduct.originProductNo ?? item.originProductNo),
        name: channelProduct.name ?? channelProduct.channelProductName ?? "이름 없음",
        stockQuantity: Number(channelProduct.stockQuantity ?? 0),
        salePrice: Number(channelProduct.salePrice ?? 0),
      });
    }

    if (items.length < size) break;
    page += 1;
    if (page > 50) break; // 안전장치
  }

  return products;
}

/**
 * 최근 N일간 상품주문 내역 조회 (판매속도 계산용)
 * 반환: [{ productId, quantity, orderedAt }]
 *
 * 네이버 커머스API는 from~to 기간을 최대 24시간까지만 허용하므로,
 * 요청 기간을 23시간 단위로 나눠 여러 번 호출한 뒤 결과를 합칩니다.
 */
async function fetchRecentOrders(days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const CHUNK_MS = 23 * 60 * 60 * 1000;

  const orders = [];
  let chunkFrom = from;
  while (chunkFrom < to) {
    const chunkTo = new Date(Math.min(chunkFrom.getTime() + CHUNK_MS, to.getTime()));

    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams({
        from: chunkFrom.toISOString(),
        to: chunkTo.toISOString(),
        page: String(page),
      });

      const data = await authedFetch(`${API_ENDPOINTS.productOrders}?${params.toString()}`, {
        method: "GET",
      });

      const pageOrders = data?.data?.contents ?? data?.contents ?? [];
      for (const o of pageOrders) {
        orders.push({
          productId: String(o.productOrder?.productId ?? o.productId ?? ""),
          quantity: Number(o.productOrder?.quantity ?? o.quantity ?? 0),
          orderedAt: o.productOrder?.orderDate ?? o.orderDate ?? null,
        });
      }

      const hasNext = data?.data?.pagination?.hasNext ?? false;
      if (!hasNext) break;
      page += 1;
      await sleep(350);
    }

    chunkFrom = chunkTo;
    if (chunkFrom < to) await sleep(350);
  }

  return orders;
}

module.exports = { fetchProducts, fetchRecentOrders, getAccessToken };
