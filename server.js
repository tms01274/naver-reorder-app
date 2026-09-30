require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const { computeReorderList, roundOrderQty } = require("./src/reorderLogic");
const { assignOrdersToOptionRows, inheritParentInfo } = require("./src/productOptions");
const { startDailyBackup } = require("./src/backup");
const { getAllSuppliers, upsertSupplier, clearFieldFromAll, setFieldForProducts, migrateSuppliers } = require("./src/suppliers");
const { getAllVendors, createVendor, updateVendor, deleteVendor, migrateLegacySupplierFields } = require("./src/vendors");
const {
  listOrders, createOrder, receiveOrder, unreceiveItem, updateItemQty, removeItem, deleteOrder, pendingByProduct,
  autoReceiveArrived, recentAutoReceipts, orderIntervalsByVendor, recentlyReceivedByHand,
} = require("./src/orders");
const { detectUnrecordedArrivals, listRises, takeRise } = require("./src/stockWatch");
const { listDrafts, getDraft, saveDraft, deleteDraft } = require("./src/orderDrafts");
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
const naverCache = new Map(); // "products" | "orders:<일수>" -> { data, fetchedAt }

// 같은 요청이 이미 진행 중이면 새로 부르지 않고 그 결과를 같이 기다린다
// (서버 시작 직후 미리 불러오는 중에 화면 요청이 들어와도 네이버를 두 번 부르지 않게)
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// 캐시가 지났어도 이 시간 안에 받은 데이터면 바로 돌려주고, 네이버에서는 뒤에서 새로 받아 둔다.
// (발주 완료로 처리 · 입고 처리 뒤 목록을 다시 그릴 때 네이버 조회 10초 넘게 기다리지 않게)
const STALE_OK_MS = 30 * 60 * 1000;

// 네이버 연결 상태. 마지막 호출이 실패했으면 첫 화면 '오늘 할 일'에 알린다
// (매장 인터넷 주소가 바뀌거나 API 키가 만료되면 예전 데이터만 보고 있을 수 있어서)
const naverStatus = { ok: true, message: "", failedAt: null, lastSuccessAt: null };

function naverFailureMessage(err) {
  const m = String(err?.message || "");
  if (m.includes("IP_NOT_ALLOWED")) return "매장 인터넷 주소(IP)가 바뀌어서 네이버가 연결을 막았어요. 관리자에게 알려주세요.";
  if (m.includes("인증 토큰") || m.includes("status=401") || m.includes("status=403") || m.includes(".env")) return "네이버 API 키에 문제가 있어 연결이 안 돼요. 관리자에게 알려주세요.";
  if (m.includes("fetch failed") || m.includes("ENOTFOUND") || m.includes("ETIMEDOUT") || m.includes("ECONNRESET")) return "인터넷 연결을 확인해주세요. 연결되면 자동으로 다시 불러와요.";
  return "네이버에서 데이터를 받지 못했어요. 계속되면 관리자에게 알려주세요.";
}

function trackNaver(fn) {
  return async () => {
    try {
      const data = await fn();
      Object.assign(naverStatus, { ok: true, message: "", failedAt: null, lastSuccessAt: new Date().toISOString() });
      return data;
    } catch (err) {
      Object.assign(naverStatus, { ok: false, message: naverFailureMessage(err), failedAt: new Date().toISOString() });
      throw err;
    }
  };
}

function refreshInBackground(key, fn) {
  once(key, fn).catch((err) => console.error("네이버 데이터 새로 받기 실패 (이전 데이터로 보여줘요):", err.message.split("\n")[0]));
}

// force: 화면의 "새로고침" — 기다려서라도 새로 받는다. 실패하면 예전 데이터라도 보여준다 (화면이 통째로 멈추지 않게)
async function getCached(key, fetchFn, force) {
  const c = naverCache.get(key);
  const age = c ? Date.now() - c.fetchedAt : Infinity;
  const load = trackNaver(async () => {
    const data = await fetchFn();
    naverCache.set(key, { data, fetchedAt: Date.now() });
    return data;
  });
  if (!force && age < CACHE_TTL_MS) return c.data;
  if (!force && age < STALE_OK_MS) {
    refreshInBackground(key, load);
    return c.data;
  }
  try {
    return await once(key, load);
  } catch (err) {
    if (c) {
      console.error("네이버 데이터 받기 실패 (이전 데이터로 보여줘요):", err.message.split("\n")[0]);
      return c.data;
    }
    throw err;
  }
}

const getCachedProducts = (force) => getCached("products", () => naverClient.fetchProducts(), force);
const getCachedOrders = (days, force) => getCached(`orders:${days}`, () => naverClient.fetchRecentOrders(days), force);

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
    orderCycleDays: parseDays(query.orderCycleDays, 0),
  };

  const changed = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  if (Object.keys(changed).length) saveSettings(changed);
  const saved = readSettings();

  // 예전 버전에서 빈 칸이 0으로 저장된 경우가 있어, 저장값도 검사해서 이상하면 기본값을 쓴다
  return {
    lookbackDays: parseDays(saved.lookbackDays, 1) ?? Number(process.env.SALES_LOOKBACK_DAYS ?? 14),
    leadTimeDays: Number(process.env.DEFAULT_LEAD_TIME_DAYS ?? 7),
    bufferDays: parseDays(saved.bufferDays, 0) ?? Number(process.env.DEFAULT_SAFETY_BUFFER_DAYS ?? 3),
    // 기본 발주 간격: 한 번 발주하면 며칠 뒤 다시 발주할지 (그 기간 동안 팔 양을 더 채운다). 업체마다 따로 정할 수 있다
    orderCycleDays: parseDays(saved.orderCycleDays, 0) ?? DEFAULT_ORDER_CYCLE_DAYS,
  };
}

const DEFAULT_ORDER_CYCLE_DAYS = 14;

// 이미 발주해서 들어올 수량을 재고에 더해 "발주 필요"와 권장 수량을 다시 계산한다.
// 충분히 발주했으면 발주 필요에서 빠지고, 모자라면 남은 수량만 권장한다.
function applyPendingOrder(p, pending) {
  if (!pending || pending.qty <= 0) return { ...p, pendingOrder: null };
  const covered = p.stockQuantity + pending.qty;
  const needsReorder = p.dailyVelocity > 0 ? covered / p.dailyVelocity <= p.reorderPointDays : covered === 0;
  const neededQty = Math.max(0, p.targetStock - covered);
  return {
    ...p,
    needsReorder,
    neededQty,
    recommendedOrderQty: roundOrderQty(neededQty, p.orderRule),
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
    const force = !!req.query.fresh;
    const settings = getSettings(req.query);
    const [products, rawOrders] = await Promise.all([
      getCachedProducts(force),
      getCachedOrders(settings.lookbackDays, force),
    ]);
    // 옵션 상품은 옵션마다 한 줄이라, 주문도 옵션 줄에 맞추고 예전에 상품에 지정한 업체 · 라벨을 옵션 줄이 이어받는다
    const orders = assignOrdersToOptionRows(products, rawOrders);
    migrateSuppliers((all) => inheritParentInfo(products, all));
    const suppliers = getAllSuppliers();
    const labels = getAllLabels();
    const vendors = getAllVendors();

    const leadTimeOverrides = {};
    const orderRules = {};
    // 발주 간격: 업체에 직접 정한 값 → 발주 기록에서 알아낸 값(자동) → 기본값
    const learnedCycles = orderIntervalsByVendor();
    const cycleOverrides = {};
    const cycleSource = {}; // "vendor" | "auto" (없으면 기본값)
    for (const [pid, info] of Object.entries(suppliers)) {
      const label = info.labelId ? labels[info.labelId] : null;
      const effective = info.leadTimeDays ?? label?.leadTimeDays;
      if (effective !== undefined && effective !== null) leadTimeOverrides[pid] = Number(effective);
      if (info.minOrderQty || info.packSize) orderRules[pid] = { minOrderQty: info.minOrderQty, packSize: info.packSize };
      const vendor = info.vendorId ? vendors[info.vendorId] : null;
      if (vendor?.orderCycleDays !== undefined && vendor.orderCycleDays !== null) {
        cycleOverrides[pid] = Number(vendor.orderCycleDays);
        cycleSource[pid] = "vendor";
      } else if (vendor && learnedCycles[info.vendorId]) {
        cycleOverrides[pid] = learnedCycles[info.vendorId].days;
        cycleSource[pid] = "auto";
      }
    }

    // 발주 뒤 네이버 재고가 (팔린 만큼 빼고도) 늘어난 품목은 자동으로 입고 처리 (사람은 스마트스토어 재고만 올리면 됨)
    // 옵션으로 나누기 전에 상품 번호로 남긴 발주 기록도 알아볼 수 있게, 상품 번호에는 옵션 재고 합계를 넣는다
    const stockById = {};
    for (const p of products) if (p.parentId) stockById[p.parentId] = (stockById[p.parentId] || 0) + p.stockQuantity;
    for (const p of products) stockById[p.id] = p.stockQuantity;
    const soldSince = (productId, sinceIso) => {
      const t = new Date(sinceIso).getTime();
      return orders.reduce((sum, o) => ((o.productId === productId || o.parentId === productId) && o.orderedAt && new Date(o.orderedAt).getTime() >= t ? sum + o.quantity : sum), 0);
    };
    const justReceived = autoReceiveArrived(stockById, soldSince);
    const pending = pendingByProduct();
    // 발주 기록 없이 재고가 늘어난 품목 (= '발주 완료로 처리'를 깜빡한 발주가 도착) → 오늘 할 일에서 물어본다
    const byHand = recentlyReceivedByHand();
    detectUnrecordedArrivals(products, {
      soldSince,
      justReceived,
      hasOpenOrder: (id) => {
        const parentId = products.find((p) => p.id === id)?.parentId;
        return !!pending[id] || !!pending[parentId] || byHand.has(id) || byHand.has(parentId);
      },
      maxAgeMs: settings.lookbackDays * 24 * 60 * 60 * 1000,
    });
    const autoReceipts = recentAutoReceipts();
    const daily = dailySalesByProduct(orders, settings.lookbackDays);
    const list = computeReorderList(products, orders, settings, leadTimeOverrides, orderRules, cycleOverrides).map((p) => {
      const supplierInfo = suppliers[p.id] || null;
      const labelId = supplierInfo?.labelId && labels[supplierInfo.labelId] ? supplierInfo.labelId : null;
      const vendorId = supplierInfo?.vendorId && vendors[supplierInfo.vendorId] ? supplierInfo.vendorId : null;
      return {
        ...applyPendingOrder(p, pending[p.id]),
        recentAutoReceipt: autoReceipts[p.id] || null,
        orderCycleSource: cycleSource[p.id] || "default",
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
      naver: { ...naverStatus },
      products: list,
      // 깜빡했을 때 재고 계산이 틀어질 수 있는 것들 → 첫 화면 '오늘 할 일'에 알림
      alerts: {
        drafts: listDrafts(),
        unrecordedArrivals: listRises(),
      },
      labels: Object.entries(labels).map(([id, l]) => ({ id, ...l })),
      vendors: Object.entries(vendors).map(([id, v]) => ({ id, ...v, learnedCycle: learnedCycles[id] || null })),
    });
  } catch (err) {
    console.error(err);
    // 네이버 연결 문제면 매장에서 알아볼 수 있는 말로
    res.status(500).json({ error: naverStatus.ok ? err.message : naverStatus.message });
  }
});

// 최소 주문 수량 · 묶음 단위: 빈 값이면 지우고(undefined), 아니면 1 이상 정수. 잘못된 값이면 null
function parseOrderRule(value) {
  if (String(value ?? "").trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// 품목별 정보 저장 (거래 업체, 입고유형 라벨, 품목만의 리드타임, 업체 주문 규칙)
app.post("/api/suppliers/:productId", (req, res) => {
  try {
    const { vendorId, leadTimeDays, labelId, vendorItemName, minOrderQty, packSize } = req.body;
    const rules = {};
    for (const [key, value] of Object.entries({ minOrderQty, packSize })) {
      if (value === undefined) continue;
      const n = parseOrderRule(value);
      if (n === null) return res.status(400).json({ error: "최소 주문 수량과 묶음 단위는 1 이상의 정수로 입력해주세요." });
      rules[key] = n;
    }
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
      ...rules,
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
  // 발주 간격 (빈 값이면 기본 발주 간격을 쓴다)
  if (body.orderCycleDays !== undefined) {
    if (String(body.orderCycleDays).trim() === "") out.orderCycleDays = partial ? null : undefined;
    else {
      const n = parseDays(body.orderCycleDays, 0);
      if (n === undefined) throw new Error("발주 간격은 0 이상의 숫자로 입력해주세요.");
      out.orderCycleDays = n;
    }
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

// 발주 기록에 넣을 품목 정리. 잘못된 값이 있으면 { error }
function cleanOrderItems(items) {
  if (!Array.isArray(items) || !items.length) return { error: "기록할 품목이 없어요." };
  const now = Date.now();
  const clean = [];
  for (const it of items) {
    const qty = Math.floor(Number(it.qty));
    if (!it.productId || !(qty > 0)) return { error: "품목과 수량을 확인해주세요." };
    const lead = Number.isFinite(Number(it.leadTimeDays)) && Number(it.leadTimeDays) >= 0 ? Number(it.leadTimeDays) : 7;
    clean.push({
      productId: String(it.productId),
      name: String(it.name || it.productId),
      ...(it.vendorItemName ? { vendorItemName: String(it.vendorItemName) } : {}),
      qty,
      // 발주할 때의 네이버 재고. 나중에 재고가 늘면 자동으로 입고 처리한다
      ...(Number.isFinite(Number(it.stockAtOrder)) && it.stockAtOrder !== null && it.stockAtOrder !== "" ? { stockAtOrder: Number(it.stockAtOrder) } : {}),
      // 입고 예정일 = 발주일 + 그 품목의 리드타임
      expectedAt: new Date(now + lead * 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  return { items: clean };
}

// 발주서 화면 · 첫 화면의 "발주 완료로 처리" (direct = 발주서 없이 첫 화면에서, 업체 없이도 가능)
// body: { vendorId, direct?, items: [{ productId, name, vendorItemName?, qty, leadTimeDays, stockAtOrder? }] }
app.post("/api/orders", (req, res) => {
  const { vendorId, items, direct } = req.body;
  const vendor = vendorId ? getAllVendors()[vendorId] : null;
  if (vendorId && !vendor) return res.status(400).json({ error: "업체를 찾을 수 없어요." });
  if (!vendorId && !direct) return res.status(400).json({ error: "업체를 찾을 수 없어요." });
  const cleaned = cleanOrderItems(items);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });
  if (vendorId) deleteDraft(vendorId); // 그 업체의 "처리 안 한 발주서" 알림은 끝
  res.json(createOrder({ vendorId: vendorId || "", vendorName: vendor ? vendor.name : "업체 미지정", items: cleaned.items, direct: !!direct }));
});

// 메일 화면에서 복사 · 메일 열기를 누르면 저장 (발주 완료로 처리를 깜빡했을 때 알려주려고)
app.post("/api/order-drafts", (req, res) => {
  const { vendorId, items } = req.body || {};
  const vendor = getAllVendors()[vendorId];
  if (!vendor) return res.status(400).json({ error: "업체를 찾을 수 없어요." });
  const cleaned = cleanOrderItems(items);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });
  // 예정일은 처리할 때 다시 계산하므로, 받은 그대로(리드타임 포함) 저장
  res.json(saveDraft(vendorId, { vendorName: vendor.name, items }));
});

// 알림에서 "발주 완료로 처리" → 저장해 둔 발주서로 기록
app.post("/api/order-drafts/:vendorId/record", (req, res) => {
  const draft = getDraft(req.params.vendorId);
  if (!draft) return res.status(404).json({ error: "이미 처리했거나 없는 발주서예요." });
  const cleaned = cleanOrderItems(draft.items);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });
  deleteDraft(req.params.vendorId);
  res.json(createOrder({ vendorId: draft.vendorId, vendorName: getAllVendors()[draft.vendorId]?.name || draft.vendorName, items: cleaned.items }));
});

// 알림에서 "안 보냈어요"
app.delete("/api/order-drafts/:vendorId", (req, res) => {
  deleteDraft(req.params.vendorId);
  res.json({ ok: true });
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

// "재고가 늘었는데 발주 기록이 없어요" 알림에서 "발주였어요" → 늦게라도 발주 기록(입고 완료)으로 남긴다.
// 발주일은 알 수 없으니 재고가 늘어난 날에서 그 품목의 리드타임만큼 앞으로 잡는다 (발주 간격 계산용)
app.post("/api/stock-rises/:id/confirm", (req, res) => {
  const rise = takeRise(req.params.id);
  if (!rise) return res.status(404).json({ error: "이미 처리한 알림이에요." });
  const info = getAllSuppliers()[rise.productId] || {};
  const vendor = info.vendorId ? getAllVendors()[info.vendorId] : null;
  const label = info.labelId ? getAllLabels()[info.labelId] : null;
  const lead = Number(info.leadTimeDays ?? label?.leadTimeDays ?? getSettings().leadTimeDays) || 0;
  const orderedAt = new Date(new Date(rise.detectedAt).getTime() - lead * 24 * 60 * 60 * 1000).toISOString();
  res.json(createOrder({
    vendorId: vendor ? info.vendorId : "",
    vendorName: vendor ? vendor.name : "업체 미지정",
    createdAt: orderedAt,
    lateRecord: true,
    items: [{
      productId: rise.productId, name: rise.name, qty: rise.qty, stockAtOrder: rise.before,
      expectedAt: rise.detectedAt, receivedAt: rise.detectedAt, autoReceived: true, stockAtReceive: rise.after,
    }],
  }));
});

// "아니에요" (반품 재입고 · 재고 정리 등 발주가 아니었음)
app.delete("/api/stock-rises/:id", (req, res) => {
  takeRise(req.params.id);
  res.json({ ok: true });
});

// 기록한 품목의 수량 고치기 / 품목 빼기
app.put("/api/orders/:id/items/:productId", (req, res) => {
  const qty = Math.floor(Number(req.body?.qty));
  if (!(qty > 0)) return res.status(400).json({ error: "수량은 1 이상으로 입력해주세요." });
  const saved = updateItemQty(req.params.id, req.params.productId, qty);
  if (!saved) return res.status(404).json({ error: "발주 기록을 찾을 수 없어요." });
  res.json(saved);
});

app.delete("/api/orders/:id/items/:productId", (req, res) => {
  const saved = removeItem(req.params.id, req.params.productId);
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
  startDailyBackup();
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
