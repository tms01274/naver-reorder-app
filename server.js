require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const { computeReorderList } = require("./src/reorderLogic");
const { getAllSuppliers, upsertSupplier, clearFieldFromAll, setFieldForProducts, migrateSuppliers } = require("./src/suppliers");
const { getAllVendors, createVendor, updateVendor, deleteVendor, migrateLegacySupplierFields } = require("./src/vendors");
const { listOrders, createOrder, receiveOrder, unreceiveItem, deleteOrder, pendingByProduct } = require("./src/orders");
const { getTemplates, saveTemplate, getSenderNames, PLACEHOLDERS, LANGUAGES, LANG_CODES } = require("./src/mailTemplate");
const { getAllLabels, createLabel, updateLabel, deleteLabel } = require("./src/inboundLabels");
const { readSettings, saveSettings } = require("./src/settings");
const { CHANGELOG } = require("./src/changelog");
const { readUiState, saveUiState } = require("./src/uiState");

const MOCK_MODE = String(process.env.MOCK_MODE || "true").toLowerCase() !== "false";
const naverClient = MOCK_MODE ? require("./src/mockData") : require("./src/naverClient");

if (MOCK_MODE) {
  console.log("⚠️  MOCK_MODE=true 로 실행 중입니다. 샘플 데이터로 동작합니다.");
  console.log("   실제 네이버 데이터를 쓰려면 .env 에서 MOCK_MODE=false 로 바꾸고 API 키를 넣어주세요.");
}

// 예전 버전의 품목별 업체명/이메일을 업체 목록으로 옮긴다 (한 번만 실제로 바뀜)
migrateSuppliers(migrateLegacySupplierFields);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// 사용 설명서(Word) 내려받기용
app.use("/docs", express.static(path.join(__dirname, "docs")));

// 네이버 API(상품/주문)는 호출당 시간이 꽤 걸리므로, 짧게 캐시해서
// 라벨 저장/삭제처럼 화면을 다시 그릴 때마다 매번 다시 부르지 않게 합니다.
const CACHE_TTL_MS = 3 * 60 * 1000;
let productsCache = { data: null, expiresAt: 0 };
const ordersCacheByDays = new Map(); // lookbackDays -> { data, expiresAt }

// 같은 요청이 이미 진행 중이면 새로 부르지 않고 그 결과를 같이 기다린다
// (서버 시작 직후 미리 불러오는 중에 화면 요청이 들어와도 네이버를 두 번 부르지 않게)
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function getCachedProducts() {
  const now = Date.now();
  if (productsCache.data && productsCache.expiresAt > now) return productsCache.data;
  return once("products", async () => {
    const data = await naverClient.fetchProducts();
    productsCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    return data;
  });
}

async function getCachedOrders(days) {
  const now = Date.now();
  const cached = ordersCacheByDays.get(days);
  if (cached && cached.expiresAt > now) return cached.data;
  return once(`orders:${days}`, async () => {
    const data = await naverClient.fetchRecentOrders(days);
    ordersCacheByDays.set(days, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  });
}

// 서버가 켜지자마자 네이버 데이터를 미리 받아둔다. 바탕화면 아이콘이 화면을 여는 몇 초 사이에
// 주문 조회(하루 단위로 여러 번 호출, 10초 안팎)가 거의 끝나 있어서 첫 화면이 빨리 뜬다.
function warmUpCache() {
  const { lookbackDays } = getSettings();
  Promise.all([getCachedProducts(), getCachedOrders(lookbackDays)]).catch((err) => {
    console.error("시작할 때 네이버 데이터 미리 받기 실패 (화면을 열면 다시 시도해요):", err.message.split("\n")[0]);
  });
}

// 빈 값·숫자 아님·최솟값 미만이면 undefined (= 이 값은 무시)
function parseDays(value, min) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : undefined;
}

function getSettings(query = {}) {
  const overrides = {
    lookbackDays: parseDays(query.lookbackDays, 1),
    bufferDays: parseDays(query.bufferDays, 0),
  };

  if (overrides.lookbackDays !== undefined || overrides.bufferDays !== undefined) {
    saveSettings({
      ...(overrides.lookbackDays !== undefined ? { lookbackDays: overrides.lookbackDays } : {}),
      ...(overrides.bufferDays !== undefined ? { bufferDays: overrides.bufferDays } : {}),
    });
  }
  const saved = readSettings();

  // 예전 버전에서 빈 칸이 0으로 저장된 경우가 있어, 저장값도 검사해서 이상하면 기본값을 쓴다
  return {
    lookbackDays: parseDays(saved.lookbackDays, 1) ?? Number(process.env.SALES_LOOKBACK_DAYS ?? 14),
    leadTimeDays: Number(process.env.DEFAULT_LEAD_TIME_DAYS ?? 7),
    bufferDays: parseDays(saved.bufferDays, 0) ?? Number(process.env.DEFAULT_SAFETY_BUFFER_DAYS ?? 3),
  };
}

// 이미 발주해서 들어올 수량을 재고에 더해 "발주 필요"와 권장 수량을 다시 계산한다.
// 충분히 발주했으면 발주 필요에서 빠지고, 모자라면 남은 수량만 권장한다.
function applyPendingOrder(p, pending) {
  if (!pending || pending.qty <= 0) return { ...p, pendingOrder: null };
  const covered = p.stockQuantity + pending.qty;
  const needsReorder = p.dailyVelocity > 0 ? covered / p.dailyVelocity <= p.leadTimeDays : covered === 0;
  return {
    ...p,
    needsReorder,
    recommendedOrderQty: Math.max(0, p.recommendedOrderQty - pending.qty),
    pendingOrder: pending,
  };
}

// 주문 내역을 품목별 · 날짜별 판매량으로 센다. { [productId]: [n일 전, …, 오늘] }
function dailySalesByProduct(orders, days) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime() - (days - 1) * 86400000;
  const result = {};
  for (const o of orders) {
    if (!o.orderedAt) continue;
    const idx = Math.floor((new Date(o.orderedAt).getTime() - startMs) / 86400000);
    if (idx < 0 || idx >= days) continue;
    (result[o.productId] ||= new Array(days).fill(0))[idx] += o.quantity;
  }
  return result;
}

// 재주문 필요 품목 리스트 (+ 전체 품목)
app.get("/api/products", async (req, res) => {
  try {
    // 화면의 "새로고침" 버튼은 캐시를 무시하고 네이버에서 새로 받아온다
    if (req.query.fresh) {
      productsCache = { data: null, expiresAt: 0 };
      ordersCacheByDays.clear();
    }
    const settings = getSettings(req.query);
    const [products, orders, suppliers] = await Promise.all([
      getCachedProducts(),
      getCachedOrders(settings.lookbackDays),
      Promise.resolve(getAllSuppliers()),
    ]);
    const labels = getAllLabels();
    const vendors = getAllVendors();

    const leadTimeOverrides = {};
    for (const [pid, info] of Object.entries(suppliers)) {
      const label = info.labelId ? labels[info.labelId] : null;
      const effective = info.leadTimeDays ?? label?.leadTimeDays;
      if (effective !== undefined && effective !== null) leadTimeOverrides[pid] = Number(effective);
    }

    const pending = pendingByProduct();
    const daily = dailySalesByProduct(orders, settings.lookbackDays);
    const list = computeReorderList(products, orders, settings, leadTimeOverrides).map((p) => {
      const supplierInfo = suppliers[p.id] || null;
      const labelId = supplierInfo?.labelId && labels[supplierInfo.labelId] ? supplierInfo.labelId : null;
      const vendorId = supplierInfo?.vendorId && vendors[supplierInfo.vendorId] ? supplierInfo.vendorId : null;
      return {
        ...applyPendingOrder(p, pending[p.id]),
        supplier: supplierInfo,
        labelId,
        label: labelId ? { id: labelId, ...labels[labelId] } : null,
        vendorId,
        vendor: vendorId ? { id: vendorId, ...vendors[vendorId] } : null,
        // 사진 보기의 판매 그래프용: 판매 속도 계산 기간 동안 날짜별 판매량 (오래된 날 → 오늘)
        dailySales: daily[p.id] || new Array(settings.lookbackDays).fill(0),
      };
    });

    res.json({
      settings,
      mockMode: MOCK_MODE,
      products: list,
      labels: Object.entries(labels).map(([id, l]) => ({ id, ...l })),
      vendors: Object.entries(vendors).map(([id, v]) => ({ id, ...v })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 품목별 정보 저장 (거래 업체, 입고유형 라벨, 품목만의 리드타임)
app.post("/api/suppliers/:productId", (req, res) => {
  try {
    const { vendorId, leadTimeDays, labelId, vendorItemName } = req.body;
    if (vendorId && !getAllVendors()[vendorId]) return res.status(400).json({ error: "업체를 찾을 수 없어요." });
    let leadTimeUpdate = {};
    if (leadTimeDays !== undefined) {
      // 빈 값으로 저장하면 품목별 리드타임을 지워서 라벨 리드타임을 쓰게 한다
      if (String(leadTimeDays).trim() === "") leadTimeUpdate = { leadTimeDays: undefined };
      else {
        const n = parseDays(leadTimeDays, 0);
        if (n === undefined) return res.status(400).json({ error: "리드타임은 0 이상의 숫자로 입력해주세요." });
        leadTimeUpdate = { leadTimeDays: n };
      }
    }
    const saved = upsertSupplier(req.params.productId, {
      // 빈 값이면 업체 연결을 끊는다
      ...(vendorId !== undefined ? { vendorId: vendorId || undefined } : {}),
      // 해외 업체 발주서에 쓸 품명 (빈 값이면 지워서 원래 품명 사용)
      ...(vendorItemName !== undefined ? { vendorItemName: String(vendorItemName).trim() || undefined } : {}),
      ...leadTimeUpdate,
      ...(labelId !== undefined ? { labelId } : {}),
    });
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 입고유형 라벨 목록 조회
app.get("/api/labels", (req, res) => {
  const labels = getAllLabels();
  res.json(Object.entries(labels).map(([id, l]) => ({ id, ...l })));
});

// 입고유형 라벨 생성
app.post("/api/labels", (req, res) => {
  try {
    const { name, leadTimeDays } = req.body;
    if (!name || !String(name).trim()) throw new Error("라벨 이름을 입력해주세요.");
    const days = parseDays(leadTimeDays, 0);
    if (days === undefined) throw new Error("리드타임은 0 이상의 숫자로 입력해주세요.");
    const saved = createLabel({ name: String(name).trim(), leadTimeDays: days });
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 입고유형 라벨 수정
app.put("/api/labels/:id", (req, res) => {
  try {
    const { name, leadTimeDays } = req.body;
    if (name !== undefined && !String(name).trim()) throw new Error("라벨 이름을 입력해주세요.");
    const days = leadTimeDays === undefined ? undefined : parseDays(leadTimeDays, 0);
    if (leadTimeDays !== undefined && days === undefined) throw new Error("리드타임은 0 이상의 숫자로 입력해주세요.");
    const saved = updateLabel(req.params.id, {
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(days !== undefined ? { leadTimeDays: days } : {}),
    });
    if (!saved) return res.status(404).json({ error: "라벨을 찾을 수 없어요." });
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 여러 품목에 한 번에 라벨 지정
app.post("/api/labels/assign", (req, res) => {
  const { productIds, labelId } = req.body;
  if (!Array.isArray(productIds) || !productIds.length) {
    return res.status(400).json({ error: "라벨을 지정할 품목을 선택해주세요." });
  }
  // 빈 값이면 라벨 해제
  if (labelId !== "" && (!labelId || !getAllLabels()[labelId])) {
    return res.status(400).json({ error: "지정할 라벨을 찾을 수 없어요." });
  }
  setFieldForProducts(productIds.map(String), "labelId", labelId || undefined);
  res.json({ ok: true, count: productIds.length });
});

// 입고유형 라벨 삭제 (지정돼 있던 품목은 라벨 없음 상태로 돌아감)
app.delete("/api/labels/:id", (req, res) => {
  deleteLabel(req.params.id);
  clearFieldFromAll("labelId", req.params.id);
  res.json({ ok: true });
});

// ── 거래 업체 ──────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 이름은 필수, 이메일은 비워둘 수 있지만 쓰면 형식을 확인한다
function readVendorInput(body, { partial }) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? "").trim();
    if (!name) throw new Error("업체 이름을 입력해주세요.");
    out.name = name;
  }
  if (body.email !== undefined || !partial) {
    const email = String(body.email ?? "").trim();
    if (email && !EMAIL_RE.test(email)) throw new Error("이메일 주소 형식을 확인해주세요.");
    out.email = email;
  }
  // 발주서 언어 (기본 한국어)
  if (body.lang !== undefined || !partial) {
    const lang = body.lang || "ko";
    if (!LANG_CODES.includes(lang)) throw new Error("발주서 언어를 다시 골라주세요.");
    out.lang = lang;
  }
  return out;
}

app.get("/api/vendors", (req, res) => {
  res.json(Object.entries(getAllVendors()).map(([id, v]) => ({ id, ...v })));
});

app.post("/api/vendors", (req, res) => {
  try {
    res.json(createVendor(readVendorInput(req.body, { partial: false })));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/vendors/:id", (req, res) => {
  try {
    const saved = updateVendor(req.params.id, readVendorInput(req.body, { partial: true }));
    if (!saved) return res.status(404).json({ error: "업체를 찾을 수 없어요." });
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 여러 품목을 한 번에 업체에 연결
app.post("/api/vendors/assign", (req, res) => {
  const { productIds, vendorId } = req.body;
  if (!Array.isArray(productIds) || !productIds.length) {
    return res.status(400).json({ error: "업체를 지정할 품목을 선택해주세요." });
  }
  // 빈 값이면 업체 연결 해제
  if (vendorId !== "" && (!vendorId || !getAllVendors()[vendorId])) {
    return res.status(400).json({ error: "지정할 업체를 찾을 수 없어요." });
  }
  setFieldForProducts(productIds.map(String), "vendorId", vendorId || undefined);
  res.json({ ok: true, count: productIds.length });
});

// 업체 삭제 (연결돼 있던 품목은 업체 없음 상태로 돌아감)
app.delete("/api/vendors/:id", (req, res) => {
  deleteVendor(req.params.id);
  clearFieldFromAll("vendorId", req.params.id);
  res.json({ ok: true });
});

// ── 발주 기록 ──────────────────────────────────────────

app.get("/api/orders", (req, res) => {
  res.json(listOrders());
});

// 발주서 화면의 "발주 완료로 기록"
// body: { vendorId, items: [{ productId, name, vendorItemName?, qty, leadTimeDays }] }
app.post("/api/orders", (req, res) => {
  const { vendorId, items } = req.body;
  const vendor = getAllVendors()[vendorId];
  if (!vendor) return res.status(400).json({ error: "업체를 찾을 수 없어요." });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "기록할 품목이 없어요." });
  const now = Date.now();
  const clean = [];
  for (const it of items) {
    const qty = Math.floor(Number(it.qty));
    if (!it.productId || !(qty > 0)) return res.status(400).json({ error: "품목과 수량을 확인해주세요." });
    const lead = Number.isFinite(Number(it.leadTimeDays)) && Number(it.leadTimeDays) >= 0 ? Number(it.leadTimeDays) : 7;
    clean.push({
      productId: String(it.productId),
      name: String(it.name || it.productId),
      ...(it.vendorItemName ? { vendorItemName: String(it.vendorItemName) } : {}),
      qty,
      // 입고 예정일 = 발주일 + 그 품목의 리드타임
      expectedAt: new Date(now + lead * 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  res.json(createOrder({ vendorId, vendorName: vendor.name, items: clean }));
});

// 입고 처리 (productIds 없으면 그 발주 전체)
app.post("/api/orders/:id/receive", (req, res) => {
  const { productIds } = req.body || {};
  const saved = receiveOrder(req.params.id, Array.isArray(productIds) ? productIds.map(String) : null);
  if (!saved) return res.status(404).json({ error: "발주 기록을 찾을 수 없어요." });
  res.json(saved);
});

// 입고 처리 되돌리기
app.post("/api/orders/:id/unreceive", (req, res) => {
  const saved = unreceiveItem(req.params.id, String(req.body?.productId || ""));
  if (!saved) return res.status(404).json({ error: "발주 기록을 찾을 수 없어요." });
  res.json(saved);
});

// 발주 취소 (잘못 기록했을 때)
app.delete("/api/orders/:id", (req, res) => {
  deleteOrder(req.params.id);
  res.json({ ok: true });
});

// 업데이트 기록 + 사용자가 마지막으로 확인한 기록
app.get("/api/whats-new", (req, res) => {
  const latestId = CHANGELOG[0]?.id ?? null;
  const lastSeenId = readUiState().lastSeenChangelogId ?? null;
  const seenIndex = CHANGELOG.findIndex((e) => e.id === lastSeenId);
  // 확인한 적이 없으면 전부 새 소식, 확인했으면 그보다 위(최신)에 있는 항목만 새 소식
  const newIds = (seenIndex === -1 ? CHANGELOG : CHANGELOG.slice(0, seenIndex)).map((e) => e.id);
  res.json({ entries: CHANGELOG, latestId, lastSeenId, newIds, hasNew: newIds.length > 0 });
});

// 업데이트 기록을 확인했음을 저장 (가이드 버튼 강조 해제)
// 화면 설정 (품목 목록 보기 방식: 표 / 사진). PC 의 data 폴더에 저장해서 브라우저를 바꿔도 유지
const LIST_VIEWS = ["table", "cards"];
app.get("/api/ui-state", (req, res) => {
  const s = readUiState();
  res.json({ listView: LIST_VIEWS.includes(s.listView) ? s.listView : "table" });
});
app.post("/api/ui-state", (req, res) => {
  const { listView } = req.body || {};
  if (!LIST_VIEWS.includes(listView)) return res.status(400).json({ error: "알 수 없는 보기 방식이에요." });
  saveUiState({ listView });
  res.json({ listView });
});

app.post("/api/whats-new/seen", (req, res) => {
  const latestId = CHANGELOG[0]?.id ?? null;
  saveUiState({ lastSeenChangelogId: latestId });
  res.json({ ok: true, lastSeenId: latestId });
});

// 발주 메일 양식 조회
app.get("/api/mail-template", (req, res) => {
  res.json({ templates: getTemplates(), languages: LANGUAGES, placeholders: PLACEHOLDERS, senderNames: getSenderNames() });
});

// 발주 메일 양식 저장 (언어별)
app.post("/api/mail-template", (req, res) => {
  try {
    const { lang = "ko", subject, body } = req.body;
    res.json(saveTemplate(lang, { subject, body }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n재고 발주 도우미가 실행됐어요: http://localhost:${PORT}\n`);
  ensureDesktopShortcut();
  warmUpCache();
});

// 이미 설치된 PC도 업데이트만 받으면 바탕화면 아이콘이 새 "원클릭" 아이콘으로 바뀌도록,
// git 으로 설치된 Windows PC 에서 서버가 켜질 때마다 아이콘을 만들어 둔다 (여러 번 해도 안전)
function ensureDesktopShortcut() {
  if (process.platform !== "win32" || !fs.existsSync(path.join(__dirname, ".git"))) return;
  const script = path.join(__dirname, "windows-autostart", "create-shortcut.ps1");
  execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], (err) => {
    if (err) console.error("바탕화면 아이콘 만들기 실패:", err.message);
  });
}
