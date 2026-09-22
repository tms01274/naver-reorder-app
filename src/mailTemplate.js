const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "..", "data", "mail-template.json");

// 사용 가능한 자리표시자(placeholder) 목록 — 프론트엔드에도 동일하게 노출됨
const PLACEHOLDERS = [
  { key: "품목명", desc: "상품 이름" },
  { key: "수량", desc: "권장 발주 수량" },
  { key: "재고", desc: "현재 재고 수량" },
  { key: "일평균판매", desc: "하루 평균 판매량" },
  { key: "소진예상", desc: "예상 재고 소진 시점 (며칠 후)" },
  { key: "업체명", desc: "공급업체명" },
];

const DEFAULT_TEMPLATE = {
  subject: "[발주 요청] {{품목명}} {{수량}}개",
  body:
    "안녕하세요, 아래와 같이 발주 요청드립니다.\n\n" +
    "- 품목: {{품목명}}\n" +
    "- 요청 수량: {{수량}}개\n" +
    "- 현재 재고: {{재고}}개 (일평균 판매 {{일평균판매}}개)\n" +
    "- 예상 소진 시점: {{소진예상}}\n\n" +
    "빠른 확인 부탁드립니다. 감사합니다.",
};

function getTemplate() {
  if (!fs.existsSync(FILE_PATH)) return DEFAULT_TEMPLATE;
  try {
    const saved = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
    return { ...DEFAULT_TEMPLATE, ...saved };
  } catch {
    return DEFAULT_TEMPLATE;
  }
}

function saveTemplate({ subject, body }) {
  const data = {
    subject: subject ?? DEFAULT_TEMPLATE.subject,
    body: body ?? DEFAULT_TEMPLATE.body,
  };
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
  return data;
}

module.exports = { getTemplate, saveTemplate, PLACEHOLDERS, DEFAULT_TEMPLATE };
