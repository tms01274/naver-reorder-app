require("dotenv").config();
const express = require("express");
const path = require("path");

const { computeReorderList } = require("./src/reorderLogic");
const { getAllSuppliers, upsertSupplier } = require("./src/suppliers");
const { getTemplate, saveTemplate, PLACEHOLDERS } = require("./src/mailTemplate");

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
  return {
    lookbackDays: Number(overrides.lookbackDays ?? process.env.SALES_LOOKBACK_DAYS ?? 14),
    leadTimeDays: Number(overrides.leadTimeDays ?? process.env.DEFAULT_LEAD_TIME_DAYS ?? 7),
    bufferDays: Number(overrides.bufferDays ?? process.env.DEFAULT_SAFETY_BUFFER_DAYS ?? 3),
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

    const leadTimeOverrides = {};
    for (const [pid, info] of Object.entries(suppliers)) {
      if (info.leadTimeDays) leadTimeOverrides[pid] = Number(info.leadTimeDays);
    }

    const list = computeReorderList(products, orders, settings, leadTimeOverrides).map((p) => ({
      ...p,
      supplier: suppliers[p.id] || null,
    }));

    res.json({ settings, mockMode: MOCK_MODE, products: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 공급업체 정보 저장/수정
app.post("/api/suppliers/:productId", (req, res) => {
  try {
    const { supplierName, supplierEmail, leadTimeDays } = req.body;
    const saved = upsertSupplier(req.params.productId, {
      supplierName,
      supplierEmail,
      ...(leadTimeDays ? { leadTimeDays: Number(leadTimeDays) } : {}),
    });
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
