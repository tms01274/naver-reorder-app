const fs = require("fs");
const path = require("path");

// 품목별 정보 (파일 이름은 예전 그대로 suppliers.json)
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

// data 구조: { [productId]: { vendorId?, labelId?, leadTimeDays? } }

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

// 삭제된 라벨/업체를 가리키던 품목에서 그 값을 지운다 (field: "labelId" | "vendorId")
function clearFieldFromAll(field, value) {
  const all = readAll();
  for (const info of Object.values(all)) {
    if (info[field] === value) delete info[field];
  }
  writeAll(all);
}

// 여러 품목에 라벨/업체를 한 번에 지정 (파일을 한 번만 읽고 쓴다)
function setFieldForProducts(productIds, field, value) {
  const all = readAll();
  for (const id of productIds) {
    all[id] = { ...(all[id] || {}), [field]: value };
  }
  writeAll(all);
}

// 저장된 품목 정보를 한 번에 고쳐 쓰는 용도 (예전 형식 옮기기). fn 이 true 를 돌려주면 저장
function migrateSuppliers(fn) {
  const all = readAll();
  if (fn(all)) writeAll(all);
}

module.exports = { getSupplier, getAllSuppliers, upsertSupplier, clearFieldFromAll, setFieldForProducts, migrateSuppliers };
