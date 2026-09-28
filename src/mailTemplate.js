const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "..", "data", "mail-template.json");

// 발주서 언어 — 업체마다 하나를 고르고, 그 언어의 양식으로 메일이 만들어진다
const LANGUAGES = [
  { code: "ko", label: "한국어", unit: "개" },
  { code: "en", label: "English", unit: "pcs" },
  { code: "zh", label: "中文", unit: "件" },
];
const LANG_CODES = LANGUAGES.map((l) => l.code);

// 발주서 메일에 넣을 수 있는 자리표시자 — 화면의 "메일 양식" 에도 이 목록이 그대로 보인다.
// 어느 언어 양식이든 같은(한글) 자리표시자를 쓴다.
const PLACEHOLDERS = [
  { key: "업체명", desc: "받는 업체 이름" },
  { key: "품목목록", desc: "고른 품목과 수량 목록" },
  { key: "품목수", desc: "품목 개수" },
  { key: "총수량", desc: "수량 합계" },
  { key: "날짜", desc: "오늘 날짜" },
  { key: "보내는사람", desc: "보내는 사람 이름" },
];

const DEFAULT_TEMPLATES = {
  ko: {
    subject: "[발주 요청] {{보내는사람}} - {{날짜}} ({{품목수}}건)",
    body:
      "안녕하세요, {{업체명}} 담당자님.\n" +
      "{{보내는사람}}입니다.\n\n" +
      "아래 품목 발주 요청드립니다.\n\n" +
      "{{품목목록}}\n\n" +
      "총 {{품목수}}개 품목, {{총수량}}개입니다.\n" +
      "확인 후 출고(입고) 예정일 회신 부탁드립니다.\n\n" +
      "감사합니다.\n" +
      "{{보내는사람}} 드림",
  },
  en: {
    subject: "[Purchase Order] {{보내는사람}} - {{날짜}} ({{품목수}} item(s))",
    body:
      "Dear {{업체명}},\n\n" +
      "This is {{보내는사람}}. We would like to place an order for the following items:\n\n" +
      "{{품목목록}}\n\n" +
      "Total: {{품목수}} item(s), {{총수량}} pcs.\n" +
      "Please confirm this order and let us know the expected shipping date.\n\n" +
      "Best regards,\n" +
      "{{보내는사람}}",
  },
  zh: {
    subject: "【采购订单】{{보내는사람}} - {{날짜}}（共{{품목수}}项）",
    body:
      "{{업체명}} 您好，\n\n" +
      "我们是{{보내는사람}}。现需订购以下商品：\n\n" +
      "{{품목목록}}\n\n" +
      "共 {{품목수}} 项，合计 {{총수량}} 件。\n" +
      "请确认订单，并告知预计发货日期。\n\n" +
      "谢谢！\n" +
      "{{보내는사람}}",
  },
};

// 보내는 사람 이름: 한국어는 .env 의 SENDER_NAME, 영어·중국어는 SENDER_NAME_EN (없으면 가게 이름)
function getSenderNames() {
  const ko = (process.env.SENDER_NAME || "").trim() || "아틀리에 말리";
  const intl = (process.env.SENDER_NAME_EN || "").trim() || "Atelier Mali";
  return { ko, en: intl, zh: intl };
}

function hasItemList(t) {
  return typeof t?.body === "string" && t.body.includes("{{품목목록}}");
}

function readFile() {
  if (!fs.existsSync(FILE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeFile(data) {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// 저장 형식: { templates: { ko: {subject, body}, en: …, zh: … }, legacy? }
// 예전 형식 { subject, body } 는 한국어 양식으로 본다. 단, 품목 하나짜리 옛 양식({{품목목록}} 없음)은
// 여러 품목 발주서에 맞지 않으므로 기본 양식을 쓰고 예전 내용은 legacy 로 보관한다.
function normalize(saved) {
  if (!saved) return { templates: {} };
  if (saved.templates) return saved;
  const out = { templates: {}, ...(saved.legacy ? { legacy: saved.legacy } : {}) };
  if (typeof saved.body === "string") {
    if (hasItemList(saved)) out.templates.ko = { subject: saved.subject, body: saved.body };
    else if (!out.legacy) out.legacy = { subject: saved.subject, body: saved.body };
  }
  return out;
}

function getTemplates() {
  const raw = readFile();
  const data = normalize(raw);
  if (raw && !raw.templates) writeFile(data); // 예전 형식이면 새 형식으로 한 번 바꿔 저장
  const result = {};
  for (const code of LANG_CODES) {
    const t = data.templates[code];
    result[code] = hasItemList(t) ? { subject: t.subject ?? DEFAULT_TEMPLATES[code].subject, body: t.body } : DEFAULT_TEMPLATES[code];
  }
  return result;
}

function saveTemplate(lang, { subject, body }) {
  if (!LANG_CODES.includes(lang)) throw new Error("알 수 없는 언어예요.");
  if (typeof body !== "string" || !body.includes("{{품목목록}}")) {
    throw new Error("본문에 {{품목목록}} 을 꼭 넣어주세요. 이 자리에 품목과 수량이 들어가요.");
  }
  const data = normalize(readFile());
  data.templates[lang] = { subject: subject ?? DEFAULT_TEMPLATES[lang].subject, body };
  writeFile(data);
  return data.templates[lang];
}

module.exports = { getTemplates, saveTemplate, getSenderNames, PLACEHOLDERS, LANGUAGES, LANG_CODES, DEFAULT_TEMPLATES };
