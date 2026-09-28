require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const { computeReorderList } = require("./src/reorderLogic");
const { getAllSuppliers, upsertSupplier, clearLabelFromAll, setLabelForProducts } = require("./src/suppliers");
const { getTemplate, saveTemplate, PLACEHOLDERS } = require("./src/mailTemplate");
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

async function getCachedProducts() {
  const now = Date.now();
  if (productsCache.data && productsCache.expiresAt > now) return productsCache.data;
  const data = await naverClient.fetchProducts();
  productsCache = { data, expiresAt: now + CACHE_TTL_MS };
  return data;
}

async function getCachedOrders(days) {
  const now = Date.now();
  const cached = ordersCacheByDays.get(days);
  if (cached && cached.expiresAt > now) return cached.data;
  const data = await naverClient.fetchRecentOrders(days);
  ordersCacheByDays.set(days, { data, expiresAt: now + CACHE_TTL_MS });
  return data;
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

    const leadTimeOverrides = {};
    for (const [pid, info] of Object.entries(suppliers)) {
      const label = info.labelId ? labels[info.labelId] : null;
      const effective = info.leadTimeDays ?? label?.leadTimeDays;
      if (effective !== undefined && effective !== null) leadTimeOverrides[pid] = Number(effective);
    }

    const list = computeReorderList(products, orders, settings, leadTimeOverrides).map((p) => {
      const supplierInfo = suppliers[p.id] || null;
      const labelId = supplierInfo?.labelId || null;
      return {
        ...p,
        supplier: supplierInfo,
        labelId,
        label: labelId ? { id: labelId, ...labels[labelId] } : null,
      };
    });

    res.json({
      settings,
      mockMode: MOCK_MODE,
      products: list,
      labels: Object.entries(labels).map(([id, l]) => ({ id, ...l })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 공급업체 정보 저장/수정
app.post("/api/suppliers/:productId", (req, res) => {
  try {
    const { supplierName, supplierEmail, leadTimeDays, labelId } = req.body;
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
      ...(supplierName !== undefined ? { supplierName } : {}),
      ...(supplierEmail !== undefined ? { supplierEmail } : {}),
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
  if (!labelId || !getAllLabels()[labelId]) {
    return res.status(400).json({ error: "지정할 라벨을 찾을 수 없어요." });
  }
  setLabelForProducts(productIds.map(String), labelId);
  res.json({ ok: true, count: productIds.length });
});

// 입고유형 라벨 삭제 (지정돼 있던 품목은 라벨 없음 상태로 돌아감)
app.delete("/api/labels/:id", (req, res) => {
  deleteLabel(req.params.id);
  clearLabelFromAll(req.params.id);
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
app.post("/api/whats-new/seen", (req, res) => {
  const latestId = CHANGELOG[0]?.id ?? null;
  saveUiState({ lastSeenChangelogId: latestId });
  res.json({ ok: true, lastSeenId: latestId });
});

// 발주 메일 양식 조회
app.get("/api/mail-template", (req, res) => {
  res.json({ template: getTemplate(), placeholders: PLACEHOLDERS });
});

// 발주 메일 양식 저장
app.post("/api/mail-template", (req, res) => {
  try {
    const { subject, body } = req.body;
    const saved = saveTemplate({ subject, body });
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n재고 발주 도우미가 실행됐어요: http://localhost:${PORT}\n`);
  ensureDesktopShortcut();
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
