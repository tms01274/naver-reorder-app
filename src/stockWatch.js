const fs = require("fs");
const path = require("path");

// 발주 기록 없이 네이버 재고가 늘어난 품목 찾기.
// 매장에서는 물건이 오면 스마트스토어 재고를 꼭 올리므로, 기록 없는 재고 증가 = '발주 완료로 처리'를 깜빡한 발주가 도착한 것.
// 첫 화면 '오늘 할 일'에서 "발주였어요"를 누르면 늦게라도 발주 기록(입고 완료)으로 남긴다 → 발주 간격 계산에도 쓰인다.
//
// data/stock-watch.json: { snapshot: { [productId]: { stock, at } }, rises: { [id]: { productId, name, before, after, qty, detectedAt } } }
const FILE_PATH = path.join(__dirname, "..", "data", "stock-watch.json");
const DAY = 24 * 60 * 60 * 1000;
const MIN_RISE = 3; // 반품 · 취소로 1~2개 돌아오는 건 무시
const KEEP_DAYS = 14; // 답하지 않은 알림은 2주 뒤 사라짐

function readAll() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
    return { snapshot: d.snapshot || {}, rises: d.rises || {} };
  } catch {
    return { snapshot: {}, rises: {} };
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * 지난번에 본 재고와 비교해서 기록 없이 늘어난 품목을 찾아 남긴다.
 * @param products [{ id, name, stockQuantity }]
 * @param soldSince (productId, iso) → 그 뒤 판매 수량
 * @param hasOpenOrder (productId) → 아직 입고 안 된 발주가 있는지 (있으면 그 발주가 들어온 것일 수 있어 묻지 않는다)
 * @param justReceived Set(productId) — 방금 자동 입고된 품목 (그 증가는 이미 설명됨)
 * @param maxAgeMs 판매 기록이 있는 기간. 지난번 본 게 이보다 오래됐으면 비교하지 않고 새로 기준만 잡는다
 */
function detectUnrecordedArrivals(products, { soldSince, hasOpenOrder, justReceived, maxAgeMs }) {
  const data = readAll();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  for (const p of products) {
    const prev = data.snapshot[p.id];
    if (prev && now - new Date(prev.at).getTime() < maxAgeMs && !justReceived.has(p.id) && !hasOpenOrder(p.id)) {
      const expected = Math.max(0, prev.stock - soldSince(p.id, prev.at));
      const rise = p.stockQuantity - expected;
      if (rise >= MIN_RISE) {
        const id = `rise_${p.id}_${now.toString(36)}`;
        data.rises[id] = { productId: p.id, name: p.name, before: prev.stock, after: p.stockQuantity, qty: rise, detectedAt: nowIso };
      }
    }
    data.snapshot[p.id] = { stock: p.stockQuantity, at: nowIso };
  }
  // 오래된 알림 · 스토어에서 사라진(삭제 · 판매중지) 품목은 정리
  const alive = new Set(products.map((p) => p.id));
  for (const [id, r] of Object.entries(data.rises)) {
    if (now - new Date(r.detectedAt).getTime() > KEEP_DAYS * DAY || !alive.has(r.productId)) delete data.rises[id];
  }
  for (const id of Object.keys(data.snapshot)) if (!alive.has(id)) delete data.snapshot[id];
  writeAll(data);
}

function listRises() {
  return Object.entries(readAll().rises)
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

// "발주였어요" / "아니에요" 모두 알림에서는 지운다. 지운 알림을 돌려준다
function takeRise(id) {
  const data = readAll();
  const r = data.rises[id];
  if (!r) return null;
  delete data.rises[id];
  writeAll(data);
  return { id, ...r };
}

module.exports = { detectUnrecordedArrivals, listRises, takeRise };
