const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "..", "data", "suppliers.json");

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

// data 구조: { [productId]: { supplierName, supplierEmail, leadTimeDays? } }

function getSupplier(productId) {
  const all = readAll();
  return all[productId] || null;
}

function getAllSuppliers() {
  return readAll();
}

function upsertSupplier(productId, info) {
  const all = readAll();
  all[productId] = { ...(all[productId] || {}), ...info };
  writeAll(all);
  return all[productId];
}

function clearLabelFromAll(labelId) {
  const all = readAll();
  for (const info of Object.values(all)) {
    if (info.labelId === labelId) delete info.labelId;
  }
  writeAll(all);
}

// 여러 품목의 라벨을 한 번에 지정 (파일을 한 번만 읽고 쓴다)
function setLabelForProducts(productIds, labelId) {
  const all = readAll();
  for (const id of productIds) {
    all[id] = { ...(all[id] || {}), labelId };
  }
  writeAll(all);
}

module.exports = { getSupplier, getAllSuppliers, upsertSupplier, clearLabelFromAll, setLabelForProducts };
