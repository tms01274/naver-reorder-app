const fs = require("fs");
const path = require("path");

// 발주 기록. 발주서 화면에서 "발주 완료로 기록"을 누르면 쌓이고, 입고되면 품목별로 입고 처리한다.
const FILE_PATH = path.join(__dirname, "..", "data", "orders.json");

// data 구조: { [orderId]: { vendorId, vendorName, createdAt, items: [
//   { productId, name, vendorItemName?, qty, expectedAt, receivedAt? } ] } }
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

function createOrder({ vendorId, vendorName, items }) {
  const all = readAll();
  const id = "order_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  all[id] = { vendorId, vendorName, createdAt: new Date().toISOString(), items };
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
  for (const item of order.items) if (item.productId === productId) delete item.receivedAt;
  writeAll(all);
  return { id, ...order };
}

function deleteOrder(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
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

module.exports = { listOrders, createOrder, receiveOrder, unreceiveItem, deleteOrder, pendingByProduct };
