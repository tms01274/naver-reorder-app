require("dotenv").config();
const express = require("express");
const path = require("path");

const { computeReorderList } = require("./src/reorderLogic");
const { getAllSuppliers, upsertSupplier, clearLabelFromAll } = require("./src/suppliers");
const { getTemplate, saveTemplate, PLACEHOLDERS } = require("./src/mailTemplate");
const { getAllLabels, createLabel, updateLabel, deleteLabel } = require("./src/inboundLabels");
const { readSettings, saveSettings } = require("./src/settings");

const MOCK_MODE = String(process.env.MOCK_MODE || "true").toLowerCase() !== "false";
const naverClient = MOCK_MODE ? require("./src/mockData") : require("./src/naverClient");

if (MOCK_MODE) {
  console.log("⚠️  MOCK_MODE=true 로 실행 중입니다. 샘플 데이터로 동작합니다.");
  console.log("   실제 네이버 데이터를 쓰려면 .env 에서 MOCK_MODE=false 로 바꾸고 API 키를 넣어주세요.");
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function getSettings(overrides = {}) {
  const saved = readSettings();

  if (overrides.lookbackDays !== undefined || overrides.bufferDays !== undefined) {
    saveSettings({
      ...(overrides.lookbackDays !== undefined ? { lookbackDays: Number(overrides.lookbackDays) } : {}),
      ...(overrides.bufferDays !== undefined ? { bufferDays: Number(overrides.bufferDays) } : {}),
    });
  }

  return {
    lookbackDays: Number(overrides.lookbackDays ?? saved.lookbackDays ?? process.env.SALES_LOOKBACK_DAYS ?? 14),
    leadTimeDays: Number(process.env.DEFAULT_LEAD_TIME_DAYS ?? 7),
    bufferDays: Number(overrides.bufferDays ?? saved.bufferDays ?? process.env.DEFAULT_SAFETY_BUFFER_DAYS ?? 3),
  };
}

// 재주문 필요 품목 리스트 (+ 전체 품목)
app.get("/api/products", async (req, res) => {
  try {
    const settings = getSettings(req.query);
    const [products, orders, suppliers] = await Promise.all([
      naverClient.fetchProducts(),
      naverClient.fetchRecentOrders(settings.lookbackDays),
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
    const saved = upsertSupplier(req.params.productId, {
      ...(supplierName !== undefined ? { supplierName } : {}),
      ...(supplierEmail !== undefined ? { supplierEmail } : {}),
      ...(leadTimeDays ? { leadTimeDays: Number(leadTimeDays) } : {}),
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
    if (leadTimeDays === undefined || leadTimeDays === "") throw new Error("리드타임을 입력해주세요.");
    const saved = createLabel({ name: String(name).trim(), leadTimeDays });
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 입고유형 라벨 수정
app.put("/api/labels/:id", (req, res) => {
  try {
    const { name, leadTimeDays } = req.body;
    const saved = updateLabel(req.params.id, {
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(leadTimeDays !== undefined ? { leadTimeDays } : {}),
    });
    if (!saved) return res.status(404).json({ error: "라벨을 찾을 수 없어요." });
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 입고유형 라벨 삭제 (지정돼 있던 품목은 라벨 없음 상태로 돌아감)
app.delete("/api/labels/:id", (req, res) => {
  deleteLabel(req.params.id);
  clearLabelFromAll(req.params.id);
  res.json({ ok: true });
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
});
