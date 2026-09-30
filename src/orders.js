const fs = require("fs");
const path = require("path");

// 발주 기록. 발주서 · 첫 화면에서 "발주 완료로 처리"를 누르면 쌓이고, 네이버 재고가 늘면 자동으로 입고 처리된다.
const FILE_PATH = path.join(__dirname, "..", "data", "orders.json");

// data 구조: { [orderId]: { vendorId("" = 업체 미지정), vendorName, createdAt, direct?(발주서 없이 첫 화면에서 기록), items: [
//   { productId, name, vendorItemName?, qty, stockAtOrder?(발주할 때 네이버 재고), stockAtTime?(그 재고를 본 시각, 없으면 발주 시각),
//     expectedAt, receivedAt?, autoReceived?(재고가 늘어서 자동 입고), stockAtReceive?,
//     noAuto?(자동 입고를 사람이 되돌림 → 다시 자동 처리 안 함) } ] } }
// vendorName · name 은 기록 당시 이름을 남겨둔다 (나중에 업체/품목 이름이 바뀌어도 기록은 그대로).

function readAll() {
  if (!fs.existsSync(FILE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function listOrders() {
  return Object.entries(readAll())
    .map(([id, o]) => ({ id, ...o }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// createdAt: 늦게 기록할 때 발주했을 법한 날짜 (없으면 지금). lateRecord: 재고가 늘어난 걸 보고 나중에 기록한 발주
function createOrder({ vendorId, vendorName, items, direct, createdAt, lateRecord }) {
  const all = readAll();
  const id = "order_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  all[id] = {
    vendorId, vendorName, createdAt: createdAt || new Date().toISOString(),
    ...(direct ? { direct: true } : {}), ...(lateRecord ? { lateRecord: true } : {}), items,
  };
  writeAll(all);
  return { id, ...all[id] };
}

// productIds 를 주면 그 품목만, 없으면 발주 전체를 입고 처리
function receiveOrder(id, productIds) {
  const all = readAll();
  const order = all[id];
  if (!order) return null;
  const now = new Date().toISOString();
  for (const item of order.items) {
    if (!item.receivedAt && (!productIds || productIds.includes(item.productId))) item.receivedAt = now;
  }
  writeAll(all);
  return { id, ...order };
}

// 입고 처리를 되돌린다 (잘못 눌렀을 때)
function unreceiveItem(id, productId) {
  const all = readAll();
  const order = all[id];
  if (!order) return null;
  for (const item of order.items) {
    if (item.productId !== productId) continue;
    if (item.autoReceived) item.noAuto = true; // 자동 입고를 되돌렸으면 다시 자동으로 처리하지 않는다
    delete item.receivedAt;
    delete item.autoReceived;
    delete item.stockAtReceive;
  }
  writeAll(all);
  return { id, ...order };
}

// 기록한 수량 고치기
function updateItemQty(id, productId, qty) {
  const all = readAll();
  const item = all[id]?.items.find((i) => i.productId === productId);
  if (!item) return null;
  item.qty = qty;
  writeAll(all);
  return { id, ...all[id] };
}

// 잘못 넣은 품목 빼기. 마지막 품목까지 빼면 그 발주 기록도 없앤다
function removeItem(id, productId) {
  const all = readAll();
  const order = all[id];
  if (!order) return null;
  order.items = order.items.filter((i) => i.productId !== productId);
  if (!order.items.length) {
    delete all[id];
    writeAll(all);
    return { id, deleted: true };
  }
  writeAll(all);
  return { id, ...order };
}

function deleteOrder(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
}

// ── 네이버 재고로 입고 여부 판단 ─────────────────────
// 판매로는 재고가 줄기만 하므로, 발주한 뒤 "팔린 만큼 뺀 재고"보다 실제 재고가 많으면 물건이 들어온 것.
//   원래라면 있어야 할 재고 = 발주할 때 재고 − 그 뒤로 팔린 수량
//   늘어난 양 = 지금 재고 − 원래라면 있어야 할 재고
// 반품 · 취소는 보통 1~2개라서, 발주 수량의 절반 이상(최소 2개, 발주 수량보다 크지 않게) 늘었을 때만 입고로 본다.
// soldSince(productId, 시각) → 그 시각 이후 판매 수량.

const DAY = 24 * 60 * 60 * 1000;

function arrivalThreshold(qty) {
  return Math.min(qty, Math.max(2, Math.ceil(qty * 0.5)));
}

function stockRise(item, createdAt, stockNow, soldSince) {
  const since = item.stockAtTime || createdAt;
  const expected = Math.max(0, item.stockAtOrder - soldSince(item.productId, since));
  return stockNow - expected;
}

// 예전 기록처럼 발주할 때 재고를 모르는 품목은, 처음 본 지금 재고를 기준으로 삼는다 (이후에 늘면 알아챌 수 있게)
function fillMissingBaselines(all, stockById, nowIso) {
  let changed = false;
  for (const o of Object.values(all)) {
    for (const item of o.items) {
      if (item.receivedAt || item.stockAtOrder !== undefined || stockById[item.productId] === undefined) continue;
      item.stockAtOrder = stockById[item.productId];
      item.stockAtTime = nowIso;
      changed = true;
    }
  }
  return changed;
}

// 재고가 늘어난 품목은 자동으로 입고 처리한다. 사람은 스마트스토어 재고만 올리면 된다.
// 같은 품목을 여러 번 발주했으면 먼저 한 발주부터, 늘어난 양을 나눠 쓴다 (한 번 들어온 걸로 두 발주를 다 처리하지 않게).
// 돌려주는 값: 이번에 입고 처리한 품목 id (Set)
function autoReceiveArrived(stockById, soldSince) {
  const received = new Set();
  const all = readAll();
  const nowIso = new Date().toISOString();
  let changed = fillMissingBaselines(all, stockById, nowIso);
  const open = [];
  for (const o of Object.values(all)) {
    for (const item of o.items) {
      if (!item.receivedAt && !item.noAuto && item.stockAtOrder !== undefined && stockById[item.productId] !== undefined) open.push({ o, item });
    }
  }
  open.sort((a, b) => a.o.createdAt.localeCompare(b.o.createdAt));
  const used = {};
  for (const { o, item } of open) {
    const stockNow = stockById[item.productId];
    const rise = stockRise(item, o.createdAt, stockNow, soldSince) - (used[item.productId] || 0);
    if (rise < arrivalThreshold(item.qty)) continue;
    item.receivedAt = nowIso;
    item.autoReceived = true;
    item.stockAtReceive = stockNow;
    used[item.productId] = (used[item.productId] || 0) + item.qty;
    received.add(item.productId);
    changed = true;
  }
  if (changed) writeAll(all);
  return received;
}

// 최근 며칠 안에 자동 입고된 품목: { [productId]: { receivedAt, qty } } — 화면에 "자동 입고됨" 표시용
function recentAutoReceipts(days = 3) {
  const cutoff = Date.now() - days * DAY;
  const result = {};
  for (const o of Object.values(readAll())) {
    for (const item of o.items) {
      if (!item.autoReceived || new Date(item.receivedAt).getTime() < cutoff) continue;
      const prev = result[item.productId];
      if (!prev || item.receivedAt > prev.receivedAt) result[item.productId] = { receivedAt: item.receivedAt, qty: item.qty };
    }
  }
  return result;
}

// 최근 며칠 안에 사람이 "입고"를 눌러 처리한 품목 (Set). 그 뒤 재고가 늘어도 기록 없는 발주로 보지 않게
function recentlyReceivedByHand(days = 7) {
  const cutoff = Date.now() - days * DAY;
  const ids = new Set();
  for (const o of Object.values(readAll())) {
    for (const item of o.items) {
      if (item.receivedAt && !item.autoReceived && new Date(item.receivedAt).getTime() >= cutoff) ids.add(item.productId);
    }
  }
  return ids;
}

// 업체마다 실제로 며칠 간격으로 발주했는지 (사람이 발주 간격을 입력하지 않아도 되게, 발주 기록에서 알아낸다)
// 같은 날 여러 번 기록한 건 한 번으로 보고, 최근 발주 INTERVAL_SAMPLE 번 사이 간격의 중간값을 쓴다
// (가끔 급하게 연달아 주문하거나 한참 쉬어도 크게 흔들리지 않게). 간격이 2개 미만(발주 3번 미만)이면 모름.
// → { [vendorId]: { days, orders(센 발주 수) } }
const INTERVAL_SAMPLE = 6;

function orderIntervalsByVendor() {
  const daysByVendor = {};
  for (const o of Object.values(readAll())) {
    if (!o.vendorId) continue;
    const d = new Date(o.createdAt);
    d.setHours(0, 0, 0, 0);
    (daysByVendor[o.vendorId] ||= new Set()).add(d.getTime());
  }
  const result = {};
  for (const [vendorId, set] of Object.entries(daysByVendor)) {
    const days = [...set].sort((a, b) => a - b).slice(-INTERVAL_SAMPLE);
    if (days.length < 3) continue;
    const gaps = days.slice(1).map((t, i) => Math.round((t - days[i]) / DAY)).sort((a, b) => a - b);
    const mid = gaps.length / 2;
    const median = gaps.length % 2 ? gaps[Math.floor(mid)] : (gaps[mid - 1] + gaps[mid]) / 2;
    result[vendorId] = { days: Math.round(median), orders: days.length };
  }
  return result;
}

// 품목별로 아직 입고 안 된 발주 합계: { [productId]: { qty, orderedAt(가장 이른), expectedAt(가장 이른), count } }
function pendingByProduct() {
  const result = {};
  for (const o of Object.values(readAll())) {
    for (const item of o.items) {
      if (item.receivedAt) continue;
      const r = (result[item.productId] ||= { qty: 0, orderedAt: o.createdAt, expectedAt: item.expectedAt, count: 0 });
      r.qty += item.qty;
      r.count += 1;
      if (o.createdAt < r.orderedAt) r.orderedAt = o.createdAt;
      if (item.expectedAt < r.expectedAt) r.expectedAt = item.expectedAt;
    }
  }
  return result;
}

module.exports = {
  listOrders, createOrder, receiveOrder, unreceiveItem, updateItemQty, removeItem, deleteOrder, pendingByProduct,
  autoReceiveArrived, recentAutoReceipts, orderIntervalsByVendor, recentlyReceivedByHand,
};
