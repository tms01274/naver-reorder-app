const fs = require("fs");
const path = require("path");

// 발주 메일을 만들어 복사까지 했는데 "발주 완료로 처리"를 안 누른 발주서.
// 메일 화면에서 복사 · Gmail로 보내기를 누르면 업체별로 저장되고, 그 업체 발주를 처리하면 지워진다.
// 남아 있으면 첫 화면 '오늘 할 일'에 "보낸 발주 메일을 처리할까요?"로 알려준다 (깜빡해서 같은 품목을 또 발주하지 않게).
const FILE_PATH = path.join(__dirname, "..", "data", "order-drafts.json");

// data 구조: { [vendorId]: { vendorName, createdAt, items: [{ productId, name, vendorItemName?, qty, leadTimeDays, stockAtOrder }] } }

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

function listDrafts() {
  return Object.entries(readAll()).map(([vendorId, d]) => ({ vendorId, ...d }));
}

function getDraft(vendorId) {
  const d = readAll()[vendorId];
  return d ? { vendorId, ...d } : null;
}

function saveDraft(vendorId, draft) {
  const all = readAll();
  all[vendorId] = { ...draft, createdAt: new Date().toISOString() };
  writeAll(all);
  return { vendorId, ...all[vendorId] };
}

function deleteDraft(vendorId) {
  const all = readAll();
  if (!(vendorId in all)) return;
  delete all[vendorId];
  writeAll(all);
}

module.exports = { listDrafts, getDraft, saveDraft, deleteDraft };
