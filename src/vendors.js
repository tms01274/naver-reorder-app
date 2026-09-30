const fs = require("fs");
const path = require("path");

// 거래 업체 목록. 품목은 data/suppliers.json 의 vendorId 로 업체 하나에 연결된다.
const FILE_PATH = path.join(__dirname, "..", "data", "vendors.json");

// data 구조: { [vendorId]: { name, email, lang, orderCycleDays? } }  lang: 발주서 언어 ko | en | zh (없으면 ko)
// orderCycleDays: 이 업체에 보통 며칠 간격으로 발주하는지 (없으면 판단 기준의 기본 발주 간격)

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

function getAllVendors() {
  return readAll();
}

function newId() {
  return "vendor_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createVendor({ name, email, lang = "ko", orderCycleDays }) {
  const all = readAll();
  const id = newId();
  all[id] = { name, email, lang, ...(orderCycleDays !== undefined && orderCycleDays !== null ? { orderCycleDays } : {}) };
  writeAll(all);
  return { id, ...all[id] };
}

// orderCycleDays: null 이면 지워서 기본 발주 간격을 쓰게 한다
function updateVendor(id, { name, email, lang, orderCycleDays }) {
  const all = readAll();
  if (!all[id]) return null;
  all[id] = {
    ...all[id],
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(lang !== undefined ? { lang } : {}),
    ...(orderCycleDays !== undefined ? { orderCycleDays } : {}),
  };
  if (all[id].orderCycleDays === null) delete all[id].orderCycleDays;
  writeAll(all);
  return { id, ...all[id] };
}

function deleteVendor(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
}

// 예전 버전은 품목마다 업체명/이메일을 따로 적었다. 같은 이메일(없으면 같은 이름)끼리
// 업체 하나로 묶어 업체 목록을 만들고, 품목에는 vendorId 만 남긴다. 옮길 게 없으면 아무것도 안 한다.
function migrateLegacySupplierFields(suppliers) {
  const vendors = readAll();
  let changed = false;
  const keyOf = (name, email) => (email ? `e:${email.toLowerCase()}` : `n:${name}`);
  const byKey = new Map(Object.entries(vendors).map(([id, v]) => [keyOf(v.name, v.email), id]));

  for (const info of Object.values(suppliers)) {
    const name = (info.supplierName || "").trim();
    const email = (info.supplierEmail || "").trim();
    if (!("supplierName" in info) && !("supplierEmail" in info)) continue;
    if ((name || email) && !info.vendorId) {
      const key = keyOf(name, email);
      let id = byKey.get(key);
      if (!id) {
        id = newId() + byKey.size;
        vendors[id] = { name: name || email, email };
        byKey.set(key, id);
      }
      info.vendorId = id;
    }
    delete info.supplierName;
    delete info.supplierEmail;
    changed = true;
  }

  if (changed) writeAll(vendors);
  return changed;
}

module.exports = { getAllVendors, createVendor, updateVendor, deleteVendor, migrateLegacySupplierFields };
