let currentData = null;
// 발주서 메일 양식 (언어별) — 업체의 언어에 맞는 양식으로 메일을 만든다
let mailTemplates = {};
let mailLanguages = [
  { code: "ko", label: "한국어", unit: "개" },
  { code: "en", label: "English", unit: "pcs" },
  { code: "zh", label: "中文", unit: "件" },
];
let senderNames = { ko: "아틀리에 말리", en: "Atelier Mali", zh: "Atelier Mali" };
// 메일 양식 창에서 지금 보고 있는 언어와, 저장 전에 고친 내용
let templateLang = "ko";
const templateDrafts = {};
let currentLabels = [];
let currentVendors = [];
let hasAutoOpenedLabelPopup = false;
let activeTab = "reorder";
const picked = new Set(); // 첫 화면에서 체크한 품목 (발주 완료로 처리용)


const $ = (id) => document.getElementById(id);

// ── 공통 ────────────────────────────────────────────

// 서버 응답이 실패면 서버가 보낸 에러 메시지로 예외를 던진다
async function fetchJson(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    // 서버 자체에 연결이 안 되는 경우 (서버가 꺼졌거나 재시작 중)
    throw new Error("프로그램 서버에 연결할 수 없어요. 바탕화면의 '재고 발주 도우미' 아이콘을 다시 눌러주세요.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function postJson(url, method, payload) {
  return fetchJson(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "error" : ""}`;
  el.textContent = message;
  $("toastHost").appendChild(el);
  setTimeout(() => el.remove(), type === "error" ? 4500 : 2200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openModal(id) { $(id).hidden = false; }
function closeModal(id) {
  if (!$(id).hidden && !confirmDiscardEdits($(id))) return;
  $(id).hidden = true;
}

// 삭제처럼 되돌릴 수 없는 버튼: 한 번 누르면 "한 번 더 누르면 삭제" 상태가 되고, 3초 안에 다시 눌러야 실행
function confirmClick(btn, label, action) {
  if (btn.classList.contains("confirming")) {
    action();
    return;
  }
  const original = btn.textContent;
  btn.classList.add("confirming");
  btn.textContent = label;
  setTimeout(() => {
    btn.classList.remove("confirming");
    btn.textContent = original;
  }, 3000);
}

// ── 품목 상태 계산 (화면 표시용) ─────────────────────

function formatDays(d) {
  if (d >= 100) return "100일 이상";
  return `${d < 10 ? d : Math.round(d)}일`;
}

function statusOf(p) {
  if (p.stockQuantity <= 0) {
    return p.dailyVelocity > 0 ? { level: "danger", text: "품절" } : { level: "danger", text: "재고 없음" };
  }
  if (p.daysLeft === null) return { level: "none", text: "판매 없음" };
  if (p.needsReorder) return { level: "danger", text: `${formatDays(p.daysLeft)} 남음` };
  if (p.daysLeft <= reorderPointOf(p) + SOON_DAYS) return { level: "warn", text: `${formatDays(p.daysLeft)} 남음` };
  return { level: "ok", text: `${formatDays(p.daysLeft)} 남음` };
}

// 발주해야 하는 시점(리드타임 + 안전 여유)보다 이만큼 앞서 "곧 필요"로 알려준다
const SOON_DAYS = 7;

function reorderPointOf(p) {
  return p.reorderPointDays ?? (p.leadTimeDays || 0) + (p.bufferDays || 0);
}

// 업체의 최소 주문 수량 · 묶음 단위에 맞춘 수량 (서버 src/reorderLogic.js 의 roundOrderQty 와 같은 규칙)
function roundOrderQty(qty, rule = {}) {
  if (!(qty > 0)) return 0;
  const min = Number(rule?.minOrderQty) > 0 ? Number(rule.minOrderQty) : 0;
  const pack = Number(rule?.packSize) > 1 ? Number(rule.packSize) : 1;
  return Math.ceil(Math.max(qty, min) / pack) * pack;
}

// 품목 이름. 옵션 줄은 옵션(색상 등)을 앞에 칩으로 보여줘서, 긴 상품명이 잘려도 어떤 옵션인지 보이게
function nameHtml(p) {
  if (!p.optionName) return escapeHtml(p.name);
  return `<span class="option-chip">${escapeHtml(p.optionName)}</span>${escapeHtml(p.productName || p.name)}`;
}

const LEVEL_ORDER = { danger: 0, warn: 1, ok: 2, none: 3 };

function sortByUrgency(list) {
  return [...list].sort((a, b) => {
    const la = LEVEL_ORDER[statusOf(a).level];
    const lb = LEVEL_ORDER[statusOf(b).level];
    if (la !== lb) return la - lb;
    return (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity);
  });
}

// 이미 발주해서 입고를 기다리는 품목은 "곧 필요"에서 뺀다
function isSoon(p) {
  return statusOf(p).level === "warn" && !p.pendingOrder;
}

function shortDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function timeText(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function daysAgoText(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? "오늘" : `${days}일 전`;
}

// 입고 예정일이 지났는지
function isLate(iso) {
  const end = new Date(iso);
  end.setHours(23, 59, 59, 999);
  return end.getTime() < Date.now();
}

// 하루에 대량 주문이 몰려 판매 속도가 부풀었는지: 그 하루가 기간 판매의 절반을 넘고 10개 이상일 때
// 계산은 그대로 두고, 그 날을 뺀 판매 속도와 권장 수량을 함께 보여줘서 사람이 판단하게 한다
function spikeInfo(p) {
  const ds = p.dailySales || [];
  const total = ds.reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...ds);
  if (total < 10 || max < 10 || max / total <= 0.5) return null;
  const velocity = (total - max) / ds.length;
  const cover = p.coverDays ?? reorderPointOf(p);
  const rec = roundOrderQty(Math.ceil(velocity * cover) - p.stockQuantity - (p.pendingOrder?.qty || 0), p.orderRule);
  return { max, velocity: Number(velocity.toFixed(2)), rec };
}

function spikeChip(p) {
  const sp = spikeInfo(p);
  return sp ? `<span class="spike-chip" title="하루에 ${sp.max}개 주문이 몰려 판매 속도가 높게 나왔을 수 있어요">대량 주문 포함</span>` : "";
}

function spikeNoteHtml(p) {
  const sp = spikeInfo(p);
  if (!sp) return "";
  return `<div class="warn-box"><span>최근 ${p.dailySales.length}일 중 <b>하루에 ${sp.max}개</b> 주문이 몰렸어요. 이 날을 빼면 하루 ${sp.velocity}개 판매, 권장 발주 <b>${sp.rec}개</b>예요. 일회성 대량 주문이었다면 발주서에서 수량을 줄여주세요.</span></div>`;
}

// 최소 주문 수량 · 묶음 단위 때문에 권장 수량을 올렸으면 알려준다
function orderRuleNoteHtml(p) {
  const r = p.orderRule || {};
  if (!(p.neededQty > 0) || p.recommendedOrderQty === p.neededQty) return "";
  const why = [r.minOrderQty ? `최소 주문 ${r.minOrderQty}개` : "", r.packSize > 1 ? `${r.packSize}개 묶음` : ""].filter(Boolean).join(" · ");
  return `<div class="info-box"><span>필요한 수량은 ${p.neededQty}개인데, ${why}에 맞춰 <b>${p.recommendedOrderQty}개</b>로 올렸어요.</span></div>`;
}

// "발주함 50개 · 10/5 예정" (예정일이 지나면 "입고 지연")
function pendingChip(p) {
  const po = p.pendingOrder;
  // 최근 재고가 늘어서 자동 입고된 품목: 혹시 반품이었으면 발주 기록에서 되돌릴 수 있게 며칠 보여준다
  if (!po && p.recentAutoReceipt) return `<span class="pending-chip arrived" title="스마트스토어 재고가 늘어서 자동으로 입고 처리했어요. 들어온 게 아니면 발주 기록에서 되돌려 주세요">자동 입고됨 · ${shortDate(p.recentAutoReceipt.receivedAt)}</span>`;
  if (!po) return "";
  const late = isLate(po.expectedAt);
  return `<span class="pending-chip ${late ? "late" : ""}" title="${daysAgoText(po.orderedAt)} 발주">${late ? "입고 지연" : "발주함"} ${po.qty}개 · ${shortDate(po.expectedAt)} 예정</span>`;
}

function labelChip(label) {
  if (!label) return `<span class="label-chip none">라벨 없음</span>`;
  const c = label.color || "#888888";
  return `<span class="label-chip" style="background:${c}17; color:${c}; border-color:${c}40;"><span class="label-dot" style="background:${c};"></span>${escapeHtml(label.name)}</span>`;
}

// ── 데이터 불러오기 ─────────────────────────────────

function setListLoading(isLoading) {
  $("listLoadingOverlay").hidden = !isLoading;
}

// params: 판단 기준을 바꿀 때만 넘긴다 (그 외 새로고침은 서버에 저장된 기준을 그대로 사용)
async function loadProducts(params = {}) {
  setListLoading(true);
  const qs = new URLSearchParams(params).toString();
  try {
    const data = await fetchJson(`/api/products${qs ? "?" + qs : ""}`);
    currentData = data;
    currentLabels = data.labels || [];
    currentVendors = data.vendors || [];
    render();
    return true;
  } catch (err) {
    // 품목을 못 불러와도 라벨/업체 관리는 쓸 수 있게 목록만 따로 불러온다
    renderLoadError(err.message);
    await loadLabels().catch(() => {});
    return false;
  } finally {
    setListLoading(false);
  }
}

async function loadLabels() {
  [currentLabels, currentVendors] = await Promise.all([fetchJson("/api/labels"), fetchJson("/api/vendors")]);
  renderLabelFilterOptions();
}

async function loadMailTemplate() {
  const data = await fetchJson("/api/mail-template");
  mailTemplates = data.templates;
  mailLanguages = data.languages || mailLanguages;
  senderNames = data.senderNames || senderNames;
  $("mtLangTabs").innerHTML = mailLanguages
    .map((l) => `<button type="button" class="tab" data-template-lang="${l.code}">${escapeHtml(l.label)}</button>`)
    .join("");
  showTemplateLang(templateLang);
  $("placeholderHint").innerHTML = data.placeholders
    .map((p) => `<button type="button" data-key="${escapeHtml(p.key)}" title="${escapeHtml(p.desc)}"><code>{{${escapeHtml(p.key)}}}</code> ${escapeHtml(p.desc)}</button>`)
    .join("");
}

// 라벨/업체 추가·수정·삭제·지정 후 화면 전체를 새로 그린다
async function refreshAfterLabelChange() {
  await loadProducts();
  if (!$("labelOverlay").hidden) renderLabelManagerBody();
  if (!$("vendorOverlay").hidden) renderVendorManagerBody();
  if (!$("orderOverlay").hidden) renderOrder();
}

// ── 메인 화면 ───────────────────────────────────────

// ── 오늘 할 일 ──────────────────────────────────────
// 첫 화면 맨 위. 지금 데이터로 할 일을 만들어 보여주고, 누르면 바로 그 작업으로 이어진다.
//  - 업체마다 "○○에 발주하기" (발주 필요 품목이 있는 업체만, 급한 순)
//  - "입고 확인" (입고 예정일이 지난 발주)
//  - "업체 연결" (발주가 필요한데 업체가 없어 발주서를 못 만드는 품목)

const TASK_ICONS = {
  order: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H5.2L4 17.2V4z"></path><path d="M8 9h8M8 12h5"></path></svg>',
  receive: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4z"></path><path d="M3 7v10l9 4 9-4V7"></path></svg>',
  link: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"></path><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"></path></svg>',
  done: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"></path></svg>',
};

function todayDateText() {
  const d = new Date();
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${"일월화수목금토"[d.getDay()]}요일`;
}

function buildTodayTasks(products) {
  const tasks = [];
  const alerts = currentData?.alerts || {};

  // 네이버 연결이 끊겼으면 맨 위에 (예전 데이터로 계산하고 있다는 걸 알려야 해서)
  if (currentData?.naver && currentData.naver.ok === false) tasks.push({ kind: "naver", naver: currentData.naver });

  // 발주 메일을 만들어 복사했는데 '발주 완료로 처리'를 안 한 업체 (깜빡하면 같은 품목을 또 발주할 수 있음)
  for (const d of alerts.drafts || []) tasks.push({ kind: "draft", draft: d });

  // 업체별 발주 (발주 필요 품목이 있는 업체만)
  const byVendor = new Map();
  for (const p of products) {
    if (!p.needsReorder || !p.vendorId) continue;
    if (!byVendor.has(p.vendorId)) byVendor.set(p.vendorId, []);
    byVendor.get(p.vendorId).push(p);
  }
  const vendorTasks = [...byVendor.entries()].map(([vendorId, items]) => ({
    kind: "order",
    vendor: vendorById(vendorId) || items[0].vendor,
    items: sortByUrgency(items),
  }));
  // 가장 급한 품목이 급한 업체부터
  vendorTasks.sort((a, b) => {
    const la = LEVEL_ORDER[statusOf(a.items[0]).level], lb = LEVEL_ORDER[statusOf(b.items[0]).level];
    if (la !== lb) return la - lb;
    const sa = a.items[0].stockQuantity <= 0 ? -1 : a.items[0].daysLeft ?? Infinity;
    const sb = b.items[0].stockQuantity <= 0 ? -1 : b.items[0].daysLeft ?? Infinity;
    return sa - sb || b.items.length - a.items.length;
  });
  tasks.push(...vendorTasks);

  // 입고 지연 (네이버 재고가 늘면 서버가 자동으로 입고 처리하므로, 여기 남은 건 아직 재고가 안 늘어난 발주)
  const late = products.filter((p) => p.pendingOrder && isLate(p.pendingOrder.expectedAt));
  if (late.length) tasks.push({ kind: "receive", items: late });

  // 발주 기록 없이 네이버 재고가 늘어난 품목 ('발주 완료로 처리'를 깜빡한 발주가 도착한 것일 수 있음)
  if (alerts.unrecordedArrivals?.length) tasks.push({ kind: "arrival", items: alerts.unrecordedArrivals });

  // 발주가 필요한데 업체가 없는 품목
  const noVendor = products.filter((p) => p.needsReorder && !p.vendorId);
  if (noVendor.length) tasks.push({ kind: "link", items: noVendor });

  return tasks;
}

function todayTaskHtml(t, i) {
  if (t.kind === "order") {
    const total = t.items.reduce((sum, p) => sum + (p.recommendedOrderQty || 0), 0);
    const lang = t.vendor?.lang && t.vendor.lang !== "ko" ? `<span class="lang-badge">${escapeHtml(langInfo(t.vendor.lang).label)}</span>` : "";
    const preview = t.items.slice(0, 2).map((p) => {
      const s = statusOf(p);
      return `<div class="task-item"><span class="name" title="${escapeHtml(p.name)}">${nameHtml(p)}</span><span class="task-item-status ${s.level}">${s.text}</span></div>`;
    }).join("");
    const more = t.items.length > 2 ? `<div class="task-item more">외 ${t.items.length - 2}품목</div>` : "";
    return `
      <div class="task-card task-order">
        <div class="task-head">
          <span class="task-icon danger">${TASK_ICONS.order}</span>
          <div class="task-title">
            <strong>${escapeHtml(t.vendor?.name || "업체")}에 발주하기 ${lang}</strong>
            <span>발주 필요 ${t.items.length}품목 · 권장 ${total}개</span>
          </div>
        </div>
        <div class="task-items">${preview}${more}</div>
        <div class="task-actions"><button class="btn-primary" data-task="${i}">발주서 만들기</button></div>
      </div>`;
  }
  if (t.kind === "draft") {
    const d = t.draft;
    const total = d.items.reduce((sum, it) => sum + Number(it.qty || 0), 0);
    const when = new Date(d.createdAt);
    const whenText = `${shortDate(d.createdAt)} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    return `
      <div class="task-card task-small task-draft">
        <span class="task-icon warn">${TASK_ICONS.order}</span>
        <div class="task-title">
          <strong>보낸 발주 메일, 처리할까요? · ${escapeHtml(vendorById(d.vendorId)?.name || d.vendorName)}</strong>
          <span>${whenText}에 메일을 만들었는데 '발주 완료로 처리'를 안 했어요 (${d.items.length}품목 · ${total}개). 보냈다면 처리해야 같은 품목을 또 발주하지 않아요</span>
        </div>
        <div class="task-buttons">
          <button class="btn-ghost btn-sm" data-task-alt="${i}">안 보냈어요</button>
          <button class="btn-primary btn-sm" data-task="${i}">발주 완료로 처리</button>
        </div>
      </div>`;
  }
  if (t.kind === "naver") {
    const last = t.naver.lastSuccessAt ? `${daysAgoText(t.naver.lastSuccessAt) === "오늘" ? timeText(t.naver.lastSuccessAt) : daysAgoText(t.naver.lastSuccessAt)}에 받은 데이터로 보여주고 있어요. ` : "";
    return `
      <div class="task-card task-small task-naver">
        <span class="task-icon danger">${TASK_ICONS.link}</span>
        <div class="task-title">
          <strong>네이버 연결이 안 돼요</strong>
          <span>${escapeHtml(last)}${escapeHtml(t.naver.message || "")}</span>
        </div>
        <button class="btn-outline btn-sm" data-task="${i}">다시 연결</button>
      </div>`;
  }
  if (t.kind === "arrival") {
    const rows = t.items.map((r) => {
      const p = productById(r.productId);
      return `
        <div class="arrival-row">
          <span class="name" title="${escapeHtml(r.name)}">${p ? nameHtml(p) : escapeHtml(r.name)}</span>
          <span class="arrival-qty">${r.before}개 → ${r.after}개 <span class="muted">(${shortDate(r.detectedAt)})</span></span>
          <span class="arrival-buttons">
            <button class="btn-ghost btn-sm" data-rise-no="${escapeHtml(r.id)}" title="반품 재입고 · 재고 정리처럼 발주가 아니었어요">아니에요</button>
            <button class="btn-primary btn-sm" data-rise-yes="${escapeHtml(r.id)}" title="${r.qty}개 발주가 도착한 걸로 기록해요">발주였어요</button>
          </span>
        </div>`;
    }).join("");
    return `
      <div class="task-card task-arrival">
        <div class="task-head">
          <span class="task-icon warn">${TASK_ICONS.receive}</span>
          <div class="task-title">
            <strong>재고가 늘었는데 발주 기록이 없어요 · ${t.items.length}품목</strong>
            <span>'발주 완료로 처리'를 깜빡한 발주가 도착했나요? '발주였어요'를 누르면 늘어난 수량으로 발주 기록을 남겨요 (다음 발주 계산에 쓰여요)</span>
          </div>
        </div>
        <div class="arrival-list">${rows}</div>
      </div>`;
  }
  if (t.kind === "receive") {
    const vendors = [...new Set(t.items.map((p) => p.vendor?.name).filter(Boolean))];
    const who = vendors.length ? `${vendors[0]}${vendors.length > 1 ? ` 외 ${vendors.length - 1}곳` : ""} · ` : "";
    return `
      <div class="task-card task-small">
        <span class="task-icon warn">${TASK_ICONS.receive}</span>
        <div class="task-title">
          <strong>입고 확인 · 지연 ${t.items.length}품목</strong>
          <span>${escapeHtml(who)}입고 예정일이 지났는데 스마트스토어 재고가 아직 안 늘었어요</span>
        </div>
        <button class="btn-outline btn-sm" data-task="${i}">입고 처리</button>
      </div>`;
  }
  return `
    <div class="task-card task-small">
      <span class="task-icon brand">${TASK_ICONS.link}</span>
      <div class="task-title">
        <strong>업체 없는 품목 연결 · ${t.items.length}개</strong>
        <span>발주가 필요한데 업체가 없어 발주서에 안 나와요</span>
      </div>
      <button class="btn-outline btn-sm" data-task="${i}">연결하기</button>
    </div>`;
}

function renderTodayTasks() {
  const tasks = buildTodayTasks(currentData.products);
  $("todayDate").textContent = todayDateText();
  $("pageTitle").textContent = tasks.length ? `오늘 할 일 ${tasks.length}가지` : "오늘 할 일";
  const box = $("todayTasks");
  box.innerHTML = tasks.length
    ? tasks.map(todayTaskHtml).join("")
    : `<div class="task-card task-small task-empty">
        <span class="task-icon ok">${TASK_ICONS.done}</span>
        <div class="task-title"><strong>오늘은 할 일이 없어요</strong><span>발주가 필요한 품목도, 늦어진 입고도 없어요.</span></div>
      </div>`;
  box.querySelectorAll("[data-task]").forEach((btn) => {
    const t = tasks[Number(btn.dataset.task)];
    btn.addEventListener("click", () => {
      if (t.kind === "order") openOrder({ vendorId: t.vendor.id });
      else if (t.kind === "draft") taskAction(btn, () => postJson(`/api/order-drafts/${encodeURIComponent(t.draft.vendorId)}/record`, "POST", {}), "발주 완료로 처리했어요");
      else if (t.kind === "receive") openOrders();
      else if (t.kind === "naver") { btn.disabled = true; loadProducts({ fresh: 1 }); }
      else openVendorManager("assign");
    });
  });
  box.querySelectorAll("[data-rise-yes]").forEach((btn) => btn.addEventListener("click", () =>
    taskAction(btn, () => postJson(`/api/stock-rises/${encodeURIComponent(btn.dataset.riseYes)}/confirm`, "POST", {}), "발주 기록에 남겼어요")));
  box.querySelectorAll("[data-rise-no]").forEach((btn) => btn.addEventListener("click", () =>
    taskAction(btn, () => fetchJson(`/api/stock-rises/${encodeURIComponent(btn.dataset.riseNo)}`, { method: "DELETE" }), "알림을 지웠어요")));
  box.querySelectorAll("[data-task-alt]").forEach((btn) => {
    const t = tasks[Number(btn.dataset.taskAlt)];
    btn.addEventListener("click", () => {
      if (t.kind === "draft") {
        confirmClick(btn, "한 번 더 누르면 지우기", () =>
          taskAction(btn, () => fetchJson(`/api/order-drafts/${encodeURIComponent(t.draft.vendorId)}`, { method: "DELETE" }), "알림을 지웠어요"));
      }
    });
  });
}

// 할 일 카드의 버튼: 서버에 반영하고 목록을 다시 불러온다
async function taskAction(btn, fn, message) {
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    btn.disabled = false;
    toast(err.message || "처리하지 못했어요.", "error");
    return;
  }
  toast(message);
  await loadProducts();
}

function renderLoadError(message) {
  $("todayTasks").innerHTML = "";
  $("todayDate").textContent = todayDateText();
  $("pageTitle").textContent = "오늘 할 일";
  $("productList").innerHTML = `<div class="empty-note error-note"><strong>품목을 불러오지 못했어요</strong>${escapeHtml(message)}</div>`;
  $("criteriaText").textContent = "네이버 데이터를 불러오지 못했어요. 잠시 후 새로고침을 눌러주세요.";
}

function render() {
  const data = currentData;
  if (!data) return;
  $("mockBadge").hidden = !data.mockMode;
  renderLabelFilterOptions();

  const products = data.products;
  const unlabeledCount = getUnlabeledProducts().length;

  const badge = $("labelCountBadge");
  badge.hidden = unlabeledCount === 0;
  badge.textContent = unlabeledCount;
  const pendingCount = products.filter((p) => p.pendingOrder).length;
  $("pendingCountBadge").hidden = pendingCount === 0;
  $("pendingCountBadge").textContent = `입고 대기 ${pendingCount}`;
  const noVendorCount = getProductsWithoutVendor().length;
  $("vendorCountBadge").hidden = noVendorCount === 0;
  $("vendorCountBadge").textContent = noVendorCount;

  const now = new Date();
  $("criteriaText").textContent =
    `최근 ${data.settings.lookbackDays}일 판매 기준 · 안전 여유 ${data.settings.bufferDays}일 · 기본 발주 간격 ${data.settings.orderCycleDays ?? 0}일 · ` +
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} 기준`;

  renderTodayTasks();
  renderList();

  if (!hasAutoOpenedLabelPopup) {
    hasAutoOpenedLabelPopup = true;
    // 새 PC 설정 창을 띄울지 확인한 뒤에, 그 창이 없을 때만 (설정 창 위에 라벨 창이 겹치지 않게)
    setupChecked.then(() => { if (unlabeledCount && $("setupOverlay").hidden) openLabelManager(); });
  }
}

function renderList() {
  if (!currentData) return;
  const labelFilter = $("labelFilter").value;
  const query = $("searchInput").value.trim().toLowerCase();

  // 라벨/검색 필터는 탭 숫자에도 똑같이 적용
  const base = currentData.products.filter((p) => {
    if (labelFilter === "none" && p.labelId) return false;
    if (labelFilter !== "all" && labelFilter !== "none" && p.labelId !== labelFilter) return false;
    if (query && !p.name.toLowerCase().includes(query)) return false;
    return true;
  });
  const byTab = {
    reorder: base.filter((p) => p.needsReorder),
    soon: base.filter(isSoon),
    pending: base.filter((p) => p.pendingOrder),
    all: base,
  };
  $("tabCountReorder").textContent = byTab.reorder.length;
  $("tabCountSoon").textContent = byTab.soon.length;
  $("tabCountPending").textContent = byTab.pending.length;
  $("tabCountAll").textContent = byTab.all.length;

  document.querySelectorAll(".tab[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === activeTab));

  const list = sortByUrgency(byTab[activeTab]);
  const emptyText = {
    reorder: "<strong>지금 발주가 필요한 품목이 없어요</strong>재고가 넉넉해요.",
    soon: "<strong>곧 발주가 필요한 품목이 없어요</strong>",
    pending: "<strong>입고를 기다리는 품목이 없어요</strong>발주서에서, 또는 품목을 체크해서 '발주 완료로 처리'를 누르면 여기에 나와요.",
    all: "<strong>조건에 맞는 품목이 없어요</strong>",
  }[activeTab];
  const cards = listView === "cards";
  $("productList").classList.toggle("cards-view", cards);
  $("tableHead").hidden = cards;
  document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === listView));
  for (const id of picked) if (!currentData.products.some((p) => p.id === id)) picked.delete(id);
  visibleIds = list.map((p) => p.id);
  $("productList").innerHTML = list.length
    ? list.map(cards ? cardHtml : rowHtml).join("")
    : `<div class="empty-note">${query || labelFilter !== "all" ? "<strong>조건에 맞는 품목이 없어요</strong>검색어나 라벨 필터를 확인해주세요." : emptyText}</div>`;
  updatePickBar();
}

// ── 첫 화면에서 바로 발주 기록 ─────────────────────
// 전화 · 카톡처럼 발주서 없이 주문한 품목을 체크해서 "발주함"으로 기록한다.
// 업체별로 나눠 기록하고, 업체가 없는 품목은 "업체 미지정"으로 기록한다.

let visibleIds = []; // 지금 목록에 보이는 품목 (전체 선택용)

function updatePickBar() {
  const n = picked.size;
  $("pickBar").hidden = n === 0;
  $("pickCount").textContent = n;
  const all = $("pickAll");
  const shown = visibleIds.filter((id) => picked.has(id)).length;
  all.checked = visibleIds.length > 0 && shown === visibleIds.length;
  all.indeterminate = shown > 0 && shown < visibleIds.length;
}

function setPicked(id, on) {
  if (on) picked.add(id); else picked.delete(id);
  const el = document.querySelector(`#productList [data-id="${CSS.escape(id)}"]`);
  if (el) {
    el.classList.toggle("picked", on);
    el.querySelector(".pick-check").checked = on;
  }
  updatePickBar();
}

// 업체가 등록돼 있으면 그 업체, 아니면 "" (업체 미지정)
function recordVendorKey(p) {
  return p.vendorId && vendorById(p.vendorId) ? p.vendorId : "";
}

const quickRecord = { items: [] }; // [{ id, qty }]

function openQuickRecord(ids) {
  quickRecord.items = ids.map(productById).filter(Boolean).map((p) => ({ id: p.id, qty: Math.max(1, p.recommendedOrderQty || 0) }));
  if (!quickRecord.items.length) return;
  renderQuickRecord();
  openModal("quickRecordOverlay");
}

function quickRecordSummary() {
  const total = quickRecord.items.reduce((sum, it) => sum + it.qty, 0);
  return `${quickRecord.items.length}개 품목 · 총 <b>${total}</b>개`;
}

function renderQuickRecord() {
  const groups = new Map(); // 업체 → [{ it, p }]
  for (const it of quickRecord.items) {
    const p = productById(it.id);
    const key = recordVendorKey(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ it, p });
  }
  $("quickRecordBody").innerHTML = `
    <h3>발주 완료로 처리</h3>
    <p class="modal-desc">전화 · 카톡 등으로 이미 주문한 품목을 기록해요. 기록하면 '입고 대기'로 표시되고 발주 필요에서 빠져요. 메일은 보내지 않아요.</p>
    ${[...groups.entries()].map(([vid, rows]) => `
      <div class="qr-group">
        <div class="qr-vendor">${vid ? escapeHtml(vendorById(vid).name) : "업체 미지정"} <span class="muted small">${rows.length}개 품목</span></div>
        ${rows.map(({ it, p }) => `
          <div class="qr-row" data-qr-id="${escapeHtml(p.id)}">
            <span class="qr-name">
              <span class="name" title="${escapeHtml(p.name)}">${nameHtml(p)}</span>
              ${p.pendingOrder ? `<span class="pending-note">이미 발주함 · ${daysAgoText(p.pendingOrder.orderedAt)} ${p.pendingOrder.qty}개</span>` : ""}
            </span>
            <span class="num"><input class="input qr-qty" type="number" min="1" value="${it.qty}" aria-label="발주 수량" />개</span>
            <button type="button" class="btn-ghost btn-sm qr-remove" title="이 품목 빼기">빼기</button>
          </div>`).join("")}
      </div>`).join("")}
    <div class="order-footer">
      <span class="order-summary" id="qrSummary">${quickRecordSummary()}</span>
      <button class="btn-ghost" data-close-quick>취소</button>
      <button class="btn-primary" id="qrSubmit">발주 완료로 처리</button>
    </div>
  `;
  document.querySelectorAll("#quickRecordBody .qr-row").forEach((row) => {
    const it = quickRecord.items.find((x) => x.id === row.dataset.qrId);
    row.querySelector(".qr-qty").addEventListener("input", (e) => {
      const n = Math.floor(Number(e.target.value));
      it.qty = Number.isFinite(n) && n > 0 ? n : 0;
      $("qrSummary").innerHTML = quickRecordSummary();
    });
    row.querySelector(".qr-remove").addEventListener("click", () => {
      quickRecord.items = quickRecord.items.filter((x) => x !== it);
      if (!quickRecord.items.length) { closeModal("quickRecordOverlay"); return; }
      renderQuickRecord();
    });
  });
  document.querySelector("#quickRecordBody [data-close-quick]").addEventListener("click", () => closeModal("quickRecordOverlay"));
  $("qrSubmit").addEventListener("click", submitQuickRecord);
}

async function submitQuickRecord() {
  if (quickRecord.items.some((it) => !(it.qty > 0))) {
    toast("수량을 1 이상으로 입력해주세요.", "error");
    return;
  }
  const btn = $("qrSubmit");
  btn.disabled = true;
  const groups = new Map();
  for (const it of quickRecord.items) {
    const p = productById(it.id);
    const key = recordVendorKey(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ productId: p.id, name: p.name, vendorItemName: p.supplier?.vendorItemName || "", qty: it.qty, leadTimeDays: p.leadTimeDays, stockAtOrder: p.stockQuantity });
  }
  let done = 0;
  try {
    for (const [vendorId, items] of groups) {
      await postJson("/api/orders", "POST", { vendorId, items, direct: true });
      done += items.length;
      for (const i of items) picked.delete(i.productId);
      quickRecord.items = quickRecord.items.filter((it) => !items.some((i) => i.productId === it.id));
    }
  } catch (err) {
    toast(err.message || "기록하지 못했어요.", "error");
    if (done) {
      // 일부 업체만 기록됐으면 남은 품목만 다시 보여준다 (두 번 기록 방지)
      await loadProducts();
      renderQuickRecord();
    } else {
      btn.disabled = false;
    }
    return;
  }
  closeModal("quickRecordOverlay");
  toast(`${done}개 품목을 발주 완료로 처리했어요`);
  await loadProducts();
}

// ── 사진으로 보기 (품목 카드) ───────────────────────
// 표와 같은 목록·정렬·필터를 카드로 보여준다. 사진 · 남은 재고 막대 · 판매 그래프 · 권장 발주.

// 날짜별 판매량 → 작은 꺾은선 그래프
function sparklineSvg(values) {
  const w = 120, h = 30;
  if (!values?.length || values.every((v) => v === 0)) {
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="0" y1="${h - 2}" x2="${w}" y2="${h - 2}" stroke="#d9d8d3" stroke-width="1.5" stroke-dasharray="3 3"></line></svg>`;
  }
  const max = Math.max(...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="#4f6cf5" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"></polyline></svg>`;
}

// 남은 재고 막대: 입고까지 필요한 기간(리드타임 + 여유)의 두 배를 꽉 찬 막대로 본다
function stockBarPercent(p) {
  if (p.stockQuantity <= 0) return 0;
  if (p.daysLeft === null) return 100;
  const target = reorderPointOf(p) || 1;
  return Math.max(3, Math.min(100, Math.round((p.daysLeft / (target * 2)) * 100)));
}

// 네이버 상품 사진은 원본이 수 MB 라서, 네이버 이미지 서버의 축소본(가로·세로 최대 510px, 약 20KB)을 쓴다
function thumbnailUrl(url) {
  if (!url) return null;
  return /^https:\/\/shop-phinf\.pstatic\.net\//.test(url) && !url.includes("?") ? `${url}?type=m510` : url;
}

function cardHtml(p) {
  const s = statusOf(p);
  const tint = p.label?.color ? `${p.label.color}1f` : "#f0efec";
  const photo = p.imageUrl
    ? `<img src="${escapeHtml(thumbnailUrl(p.imageUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="card-photo-empty"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="9" cy="10" r="2"></circle><path d="M21 16l-5-5-8 9"></path></svg><span>사진 준비 중</span></div>`;
  const qty = p.recommendedOrderQty;
  return `
    <div class="product-card ${picked.has(p.id) ? "picked" : ""}" data-id="${escapeHtml(p.id)}" role="button" tabindex="0">
      <div class="card-photo" style="background:${tint};">
        ${photo}
        <label class="pick" title="선택"><input type="checkbox" class="pick-check" ${picked.has(p.id) ? "checked" : ""} aria-label="선택" /></label>
        <span class="status ${s.level} card-status">${s.text}</span>
      </div>
      <div class="card-body">
        <div class="card-name" title="${escapeHtml(p.name)}">${nameHtml(p)}</div>
        <div class="product-sub">${p.label ? labelChip(p.label) : ""}${pendingChip(p)}${spikeChip(p)}${p.vendor ? `<span class="vendor-chip">${escapeHtml(p.vendor.name)}</span>` : ""}</div>
        <div class="card-stock">
          <div class="card-stock-text"><span>재고 ${p.stockQuantity}개</span><span>하루 ${p.dailyVelocity}개</span></div>
          <div class="stock-bar"><div class="stock-bar-fill ${s.level}" style="width:${stockBarPercent(p)}%;"></div></div>
        </div>
        <div class="card-foot">
          <div class="card-spark"><span>최근 ${p.dailySales?.length || 0}일 판매</span>${sparklineSvg(p.dailySales)}</div>
          ${qty > 0
            ? `<div class="card-rec"><span>권장 발주</span><strong>${qty}개</strong></div>`
            : p.needsReorder ? `<div class="card-rec"><span>권장 발주</span><span class="qty-manual">직접 정하기</span></div>` : `<div class="card-rec none">발주 필요 없음</div>`}
        </div>
      </div>
    </div>`;
}

// 보기 방식(표 / 사진)은 PC 에 저장해서 다음에 켜도 그대로
let listView = "table";

async function loadListView() {
  try {
    listView = (await fetchJson("/api/ui-state")).listView || "table";
  } catch {
    listView = "table";
  }
  renderList();
}

async function setListView(view) {
  if (view === listView) return;
  listView = view;
  renderList();
  try {
    await postJson("/api/ui-state", "POST", { listView: view });
  } catch {
    // 저장에 실패해도 지금 화면은 바뀐 채로 두고, 다음에 켤 때만 원래대로
  }
}

function rowHtml(p) {
  const s = statusOf(p);
  const qty = p.recommendedOrderQty;
  return `
    <div class="product-row ${picked.has(p.id) ? "picked" : ""}" data-id="${escapeHtml(p.id)}" role="button" tabindex="0">
      <label class="pick" title="선택"><input type="checkbox" class="pick-check" ${picked.has(p.id) ? "checked" : ""} aria-label="선택" /></label>
      <div>
        <div class="product-name" title="${escapeHtml(p.name)}">${nameHtml(p)}</div>
        <div class="product-sub">${p.label ? labelChip(p.label) : ""}${pendingChip(p)}${spikeChip(p)}${p.vendor ? `<span class="vendor-chip">${escapeHtml(p.vendor.name)}</span>` : ""}</div>
      </div>
      <div class="num"><span class="cell-label">재고</span>${p.stockQuantity}개</div>
      <div class="num"><span class="cell-label">일평균 판매</span>${p.dailyVelocity}개</div>
      <div class="status-cell"><span class="status ${s.level}">${s.text}</span></div>
      <div class="num"><span class="cell-label">권장 발주</span>${qty > 0 ? `<span class="qty-strong">${qty}개</span>` : p.needsReorder ? `<span class="qty-manual">직접 정하기</span>` : `<span class="qty-zero">–</span>`}</div>
    </div>
  `;
}

function renderLabelFilterOptions() {
  const select = $("labelFilter");
  const prev = select.value || "all";
  select.innerHTML =
    `<option value="all">모든 라벨</option>` +
    currentLabels.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join("") +
    `<option value="none">라벨 없음</option>`;
  const valid = prev === "all" || prev === "none" || currentLabels.some((l) => l.id === prev);
  select.value = valid ? prev : "all";
}

function getUnlabeledProducts() {
  if (!currentData?.products) return [];
  return currentData.products.filter((p) => !p.labelId);
}

function getProductsWithoutVendor() {
  if (!currentData?.products) return [];
  return currentData.products.filter((p) => !p.vendorId);
}

function setTab(tab) {
  activeTab = tab;
  renderList();
}

// ── 품목 상세 ───────────────────────────────────────

function openDetail(productId) {
  const p = currentData?.products.find((x) => x.id === productId);
  if (!p) return;

  const supplier = p.supplier || {};
  const s = statusOf(p);
  const labelLeadTime = p.label ? p.label.leadTimeDays : null;
  $("detailBody").innerHTML = `
    <div class="detail-head">
      <h3>${nameHtml(p)}</h3>
      <div class="detail-meta">
        <span class="status ${s.level}">${s.text}</span>
        ${labelChip(p.label)}
        ${pendingChip(p)}
        <span>품목 ID ${escapeHtml(p.id)}</span>
      </div>
    </div>

    <div class="detail-stats">
      <div class="stat-box"><div class="label">현재 재고</div><div class="value">${p.stockQuantity}개</div></div>
      <div class="stat-box"><div class="label">일평균 판매</div><div class="value">${p.dailyVelocity}개</div></div>
      <div class="stat-box"><div class="label">리드타임</div><div class="value">${p.leadTimeDays}일</div></div>
      <div class="stat-box highlight"><div class="label">권장 발주</div><div class="value">${p.recommendedOrderQty > 0 || !p.needsReorder ? `${p.recommendedOrderQty}개` : "직접"}</div></div>
    </div>
    ${orderRuleNoteHtml(p)}${spikeNoteHtml(p)}${p.needsReorder && p.recommendedOrderQty <= 0 ? `<div class="warn-box"><span>품절인데 최근 판매 기록이 없어서 권장 수량을 계산할 수 없어요. 발주서에서 수량을 직접 정해주세요.</span></div>` : ""}

    <h4>거래 업체 · 입고유형</h4>
    <div class="form-grid">
      <label class="field span-2">거래 업체
        <div class="select-with-action">
          <select id="detailVendor" class="input">
            <option value="">업체 없음</option>
            ${currentVendors.map((v) => `<option value="${escapeHtml(v.id)}" ${v.id === p.vendorId ? "selected" : ""}>${escapeHtml(v.name)}${v.email ? ` (${escapeHtml(v.email)})` : ""}</option>`).join("")}
          </select>
          <button type="button" class="btn-ghost btn-sm" id="detailOpenVendors">업체 관리</button>
        </div>
        <small>${cycleNoteText(p)}</small>
      </label>
      <label class="field">입고유형 라벨
        <select id="detailLabel" class="input" style="width:100%;">
          <option value="">라벨 없음</option>
          ${currentLabels.map((l) => `<option value="${escapeHtml(l.id)}" ${l.id === p.labelId ? "selected" : ""}>${escapeHtml(l.name)} (${l.leadTimeDays}일)</option>`).join("")}
        </select>
      </label>
      <label class="field">이 품목만의 리드타임
        <div class="input-suffix"><input id="productLeadTime" class="input" type="number" min="0" value="${supplier.leadTimeDays ?? ""}" placeholder="${labelLeadTime ?? ""}" /><span>일</span></div>
        <small>비워두면 라벨의 리드타임을 사용해요</small>
      </label>
      <label class="field span-2">업체용 품명 (선택)
        <input id="vendorItemName" class="input" value="${escapeHtml(supplier.vendorItemName || "")}" placeholder="예: Sun catcher acrylic plate M / 亚克力板 M / 모델번호 SP05" />
        <small>업체가 알아보는 이름이나 모델번호를 적으면 발주서에 이 이름이 들어가요. 해외 업체에 영어·중국어 이름으로 보낼 때 쓰세요. 비워두면 원래 품명을 써요.</small>
      </label>
      <label class="field">최소 주문 수량 (선택)
        <div class="input-suffix"><input id="minOrderQty" class="input" type="number" min="1" value="${supplier.minOrderQty ?? ""}" placeholder="없음" /><span>개</span></div>
        <small>업체가 이보다 적게는 안 팔면 적어주세요</small>
      </label>
      <label class="field">묶음 단위 (선택)
        <div class="input-suffix"><input id="packSize" class="input" type="number" min="1" value="${supplier.packSize ?? ""}" placeholder="낱개" /><span>개씩</span></div>
        <small>예: 10개 단위로만 팔면 10. 권장 수량을 이 단위로 올려요</small>
      </label>
    </div>

    <div class="detail-footer">
      <span class="autosave-note" id="detailSaveState">바꾸면 바로 저장돼요</span>
      <button class="btn-outline" id="recordFromDetail" title="전화 · 카톡 등으로 이미 주문했을 때">발주 완료로 처리</button>
      <button class="btn-primary" id="orderFromDetail">이 업체에 발주서 만들기</button>
    </div>
  `;

  for (const id of ["detailVendor", "detailLabel", "productLeadTime", "vendorItemName", "minOrderQty", "packSize"]) {
    $(id).addEventListener("change", () => saveSupplier(p.id));
  }
  for (const id of ["productLeadTime", "vendorItemName", "minOrderQty", "packSize"]) {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  }
  $("detailOpenVendors").addEventListener("click", () => { closeModal("detailOverlay"); openVendorManager("list"); });
  $("recordFromDetail").addEventListener("click", () => {
    closeModal("detailOverlay");
    openQuickRecord([p.id]);
  });
  $("orderFromDetail").addEventListener("click", () => {
    closeModal("detailOverlay");
    // 저장하지 않고 고른 업체라도 그 업체로 발주서를 연다
    openOrder({ vendorId: $("detailVendor")?.value || p.vendorId || "", productId: p.id });
  });
  openModal("detailOverlay");
}

async function saveSupplier(productId) {
  const payload = {
    vendorId: $("detailVendor").value,
    vendorItemName: $("vendorItemName").value,
    leadTimeDays: $("productLeadTime").value,
    labelId: $("detailLabel").value,
    minOrderQty: $("minOrderQty").value,
    packSize: $("packSize").value,
  };
  $("detailSaveState").textContent = "저장 중…";
  try {
    await postJson(`/api/suppliers/${productId}`, "POST", payload);
  } catch (err) {
    $("detailSaveState").textContent = "저장하지 못했어요";
    toast(err.message || "저장에 실패했어요.", "error");
    return;
  }
  // 다시 그려도 입력하던 칸은 그대로 (다음 칸으로 넘어가던 중이면 그 칸에)
  const focusedId = document.activeElement?.id;
  await loadProducts();
  if ($("detailOverlay").hidden) return;
  openDetail(productId);
  $("detailSaveState").textContent = "저장했어요 ✓";
  $("detailSaveState").classList.add("saved");
  if (focusedId && $(focusedId)) $(focusedId).focus();
}

function fillTemplate(template, values) {
  return template.replace(/\{\{(.+?)\}\}/g, (match, key) => {
    const v = values[key.trim()];
    return v === undefined || v === null ? "" : String(v);
  });
}

// 클립보드 복사 (localhost 는 navigator.clipboard 사용 가능, 안 되면 예전 방식으로)
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function todayText() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── 발주서 만들기 ───────────────────────────────────
// 1) 업체 선택 화면 → 2) 그 업체 품목 화면(발주 필요 품목은 미리 체크, 위쪽에 선택 요약·다음 버튼 고정) → 3) 메일.
// 수량을 고쳐서
// 메일 한 통 분량의 받는 사람 · 제목 · 본문을 만든다. 매장은 Gmail 을 써서, 이 내용이 채워진 Gmail 쓰기 창을 연다.
// (Gmail 에서 안 채워지거나 다른 메일을 쓸 때를 위해 칸마다 복사 버튼도 둔다)

const order = {
  vendorId: "",
  items: new Map(), // productId -> { checked, qty }
  extraIds: [], // 업체에 연결되지 않았지만 직접 추가한 품목
  step: "vendor", // vendor(업체 선택) → items(품목) → mail
  addSearch: "",
  recorded: false, // 이 발주서를 이미 발주 기록으로 남겼는지 (두 번 기록 방지)
};

function productById(id) {
  return currentData?.products.find((p) => p.id === id);
}

function vendorById(id) {
  return currentVendors.find((v) => v.id === id);
}

function orderRowIds() {
  const own = (currentData?.products || []).filter((p) => order.vendorId && p.vendorId === order.vendorId).map((p) => p.id);
  const ids = [...own, ...order.extraIds.filter((id) => !own.includes(id))];
  return sortByUrgency(ids.map(productById).filter(Boolean)).map((p) => p.id);
}

function ensureOrderItem(id, checked) {
  if (order.items.has(id)) return;
  const p = productById(id);
  if (!p) return;
  order.items.set(id, { checked, qty: Math.max(1, p.recommendedOrderQty || 0) });
}

function selectOrderVendor(vendorId, preselectId) {
  order.vendorId = vendorId;
  order.items = new Map();
  order.extraIds = [];
  order.step = vendorId ? "items" : "vendor";
  order.addSearch = "";
  order.recorded = false;
  if (preselectId) {
    const p = productById(preselectId);
    if (p && p.vendorId !== vendorId) order.extraIds.push(preselectId);
  }
  for (const id of orderRowIds()) ensureOrderItem(id, !!productById(id)?.needsReorder || id === preselectId);
}

function openOrder({ vendorId = "", productId = "" } = {}) {
  if (!currentData) {
    toast("품목을 불러온 뒤에 발주서를 만들 수 있어요. 새로고침을 눌러주세요.", "error");
    return;
  }
  selectOrderVendor(vendorId, productId);
  renderOrder();
  openModal("orderOverlay");
}

function selectedOrderLines() {
  return orderRowIds()
    .map((id) => ({ p: productById(id), item: order.items.get(id) }))
    .filter(({ p, item }) => p && item?.checked && item.qty > 0);
}

// 발주서에 쓸 품명: 품목에 '업체용 품명'이 있으면 그것, 없으면 원래 품명
function orderItemName(p) {
  return p.supplier?.vendorItemName || p.name;
}

function buildOrderMail() {
  const vendor = vendorById(order.vendorId);
  const lang = langInfo(vendor?.lang || "ko");
  const lines = selectedOrderLines();
  const values = {
    업체명: vendor?.name || "",
    // 한국어는 "5개", 영어·중국어는 "5 pcs" / "5 件"
    품목목록: lines.map(({ p, item }, i) => `${i + 1}. ${orderItemName(p)} — ${item.qty}${lang.code === "ko" ? "" : " "}${lang.unit}`).join("\n"),
    품목수: lines.length,
    총수량: lines.reduce((sum, { item }) => sum + item.qty, 0),
    날짜: todayText(),
    보내는사람: senderNames[lang.code] || senderNames.ko,
  };
  const t = mailTemplates[lang.code] || mailTemplates.ko || { subject: "[발주 요청] {{날짜}}", body: "{{품목목록}}" };
  return { to: vendor?.email || "", subject: fillTemplate(t.subject, values), body: fillTemplate(t.body, values), lang };
}

function renderOrder() {
  const modal = $("orderOverlay").querySelector(".modal");
  if (order.step === "mail") {
    modal.classList.add("order-fixed");
    return renderOrderMail();
  }
  const vendor = vendorById(order.vendorId);
  if (order.step === "items" && vendor) return renderOrderItems(vendor, modal);
  modal.classList.remove("order-fixed");

  const needsByVendor = new Map();
  for (const p of currentData?.products || []) {
    if (p.vendorId && p.needsReorder) needsByVendor.set(p.vendorId, (needsByVendor.get(p.vendorId) || 0) + 1);
  }
  const vendorPicker = currentVendors.length
    ? `<div class="vendor-picker">
        ${currentVendors.map((v) => `
          <button type="button" class="vendor-card ${v.id === order.vendorId ? "active" : ""}" data-order-vendor="${escapeHtml(v.id)}">
            <span class="vendor-name">${escapeHtml(v.name)}${v.lang && v.lang !== "ko" ? ` <span class="lang-badge">${escapeHtml(langInfo(v.lang).label)}</span>` : ""}</span>
            <span class="vendor-meta">${needsByVendor.get(v.id) ? `<b>발주 필요 ${needsByVendor.get(v.id)}</b>` : "발주 필요 없음"}</span>
          </button>`).join("")}
      </div>`
    : `<div class="hint-box">등록된 업체가 없어요. <button type="button" class="btn-outline btn-sm" data-open-vendors>업체 관리</button>에서 업체를 먼저 등록해주세요.</div>`;

  $("orderBody").innerHTML = `
    <h3>발주서 만들기</h3>
    <p class="modal-desc">발주할 업체를 골라주세요. 그 업체 품목이 나오고, 발주가 필요한 품목은 미리 체크돼 있어요.</p>
    ${vendorPicker}
  `;
  bindOrderEvents();
}

// 품목 화면: 위쪽(업체 · 선택 요약 · 메일 내용 만들기)은 고정, 품목 목록만 스크롤
function renderOrderItems(vendor, modal) {
  const oldPane = document.querySelector("#orderBody .order-pane");
  const keepTop = modal.classList.contains("order-fixed") && oldPane?.dataset.vendor === vendor.id ? oldPane.scrollTop : 0;
  modal.classList.add("order-fixed");
  const ids = orderRowIds();
  for (const id of ids) ensureOrderItem(id, false);

  $("orderBody").innerHTML = `
    <div class="order-top">
      <h3>발주서 만들기</h3>
      <div class="order-vendor-line">
        <span class="order-vendor-current" data-current-vendor="${escapeHtml(vendor.id)}">${escapeHtml(vendor.name)}${vendor.lang && vendor.lang !== "ko" ? ` <span class="lang-badge">${escapeHtml(langInfo(vendor.lang).label)}</span>` : ""}</span>
        <button type="button" class="btn-ghost btn-sm" id="orderChangeVendor">업체 바꾸기</button>
        <div class="order-add">
          <input id="orderAddSearch" class="input" type="search" placeholder="다른 품목 추가 (이름 검색)" value="${escapeHtml(order.addSearch)}" autocomplete="off" />
          <div id="orderAddResults" class="order-add-results"></div>
        </div>
      </div>
      <div class="order-bar">
        <span id="orderSummary" class="order-summary"></span>
        <button class="btn-primary" id="orderToMail">메일 내용 만들기</button>
      </div>
    </div>
    <div class="order-pane" data-vendor="${escapeHtml(vendor.id)}">
      ${vendor.email ? "" : `<div class="warn-box">이 업체의 이메일이 없어요. 받는 사람은 비워진 채로 만들어져요. <button type="button" class="btn-ghost btn-sm" data-open-vendors>업체 관리에서 입력</button></div>`}
      <div class="order-table">
        <div class="order-head"><span></span><span>품목</span><span class="num">재고</span><span>남은 기간</span><span class="num">발주 수량</span></div>
        ${ids.length ? ids.map((id) => orderRowHtml(productById(id), order.items.get(id))).join("") : `<div class="empty-note">이 업체에 연결된 품목이 없어요. 위 '다른 품목 추가'에서 품목을 찾아 넣거나, 업체 관리에서 품목을 연결해주세요.</div>`}
      </div>
    </div>
  `;
  if (keepTop) document.querySelector("#orderBody .order-pane").scrollTop = keepTop;
  if (order.justAdded) {
    const row = document.querySelector(`#orderBody .order-row[data-order-id="${CSS.escape(order.justAdded)}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.classList.add("just-added");
    order.justAdded = null;
  }
  updateOrderSummary();
  renderOrderAddResults();
  bindOrderEvents();
  $("orderChangeVendor").addEventListener("click", () => { order.step = "vendor"; renderOrder(); });
}

function orderRowHtml(p, item) {
  const s = statusOf(p);
  return `
    <div class="order-row ${item.checked ? "checked" : ""}" data-order-id="${escapeHtml(p.id)}">
      <input type="checkbox" class="order-check" ${item.checked ? "checked" : ""} />
      <span class="order-name">
        <span class="name" title="${escapeHtml(p.name)}">${nameHtml(p)}</span>
        ${p.supplier?.vendorItemName ? `<span class="vendor-item-name">업체용 품명: ${escapeHtml(p.supplier.vendorItemName)}</span>` : ""}
        ${spikeInfo(p) ? `<span class="spike-note">하루 ${spikeInfo(p).max}개 대량 주문 포함 · 제외하면 권장 ${spikeInfo(p).rec}개</span>` : ""}
        ${p.pendingOrder ? `<span class="pending-note">이미 발주함 · ${daysAgoText(p.pendingOrder.orderedAt)} ${p.pendingOrder.qty}개 (${shortDate(p.pendingOrder.expectedAt)} 입고 예정)</span>` : ""}
        ${p.vendorId !== order.vendorId ? `<span class="vendor-chip other">${p.vendor ? `${escapeHtml(p.vendor.name)} 품목` : "업체 미지정"}</span>` : ""}
      </span>
      <span class="num">${p.stockQuantity}개</span>
      <span><span class="status ${s.level}">${s.text}</span></span>
      <span class="num"><input class="input order-qty" type="number" min="1" value="${item.qty}" aria-label="발주 수량" />개</span>
    </div>`;
}

function updateOrderSummary() {
  const el = $("orderSummary");
  if (!el) return;
  const lines = selectedOrderLines();
  const total = lines.reduce((sum, { item }) => sum + item.qty, 0);
  el.innerHTML = order.vendorId ? `선택 <b>${lines.length}</b>개 품목 · 총 <b>${total}</b>개` : "";
  const btn = $("orderToMail");
  if (btn) btn.disabled = !order.vendorId || lines.length === 0;
}

function renderOrderAddResults() {
  const box = $("orderAddResults");
  if (!box) return;
  const q = order.addSearch.trim().toLowerCase();
  if (!q) { box.innerHTML = ""; return; }
  const inList = new Set(orderRowIds());
  const matches = currentData.products.filter((p) => !inList.has(p.id) && p.name.toLowerCase().includes(q)).slice(0, 6);
  box.innerHTML = matches.length
    ? matches.map((p) => `<button type="button" class="order-add-item" data-add-id="${escapeHtml(p.id)}"><span class="name">${nameHtml(p)}</span><span class="muted">${p.vendor ? escapeHtml(p.vendor.name) : "업체 미지정"}</span></button>`).join("")
    : `<div class="muted order-add-empty">추가할 수 있는 품목이 없어요</div>`;
}

function bindOrderEvents() {
  document.querySelectorAll("[data-order-vendor]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectOrderVendor(btn.dataset.orderVendor);
      renderOrder();
    });
  });
  document.querySelectorAll("#orderBody [data-open-vendors]").forEach((btn) => {
    btn.addEventListener("click", () => { closeModal("orderOverlay"); openVendorManager("list"); });
  });
  document.querySelectorAll(".order-row").forEach((row) => {
    const item = order.items.get(row.dataset.orderId);
    const check = row.querySelector(".order-check");
    const setChecked = (v) => {
      item.checked = v;
      check.checked = v;
      row.classList.toggle("checked", v);
      updateOrderSummary();
    };
    check.addEventListener("change", () => setChecked(check.checked));
    // 행의 빈 곳이나 이름을 눌러도 체크 (수량 칸을 누를 때는 제외)
    row.addEventListener("click", (e) => {
      if (e.target.closest("input")) return;
      setChecked(!item.checked);
    });
    const qty = row.querySelector(".order-qty");
    qty.addEventListener("input", () => {
      const n = Math.floor(Number(qty.value));
      item.qty = Number.isFinite(n) && n > 0 ? n : 0;
      // 수량을 넣으면 자동으로 체크
      if (item.qty > 0 && !item.checked) setChecked(true);
      else updateOrderSummary();
    });
  });
  const search = $("orderAddSearch");
  if (search) {
    search.addEventListener("input", () => {
      order.addSearch = search.value;
      renderOrderAddResults();
    });
    // 검색 결과는 목록 위에 겹쳐 뜨므로, 다른 곳을 누르면 접고 검색칸을 다시 누르면 편다
    search.addEventListener("blur", () => { $("orderAddResults").hidden = true; });
    search.addEventListener("focus", () => { $("orderAddResults").hidden = false; });
    $("orderAddResults").addEventListener("mousedown", (e) => e.preventDefault()); // 결과를 누를 때 접히지 않게
  }
  $("orderAddResults")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-add-id]");
    if (!btn) return;
    order.extraIds.push(btn.dataset.addId);
    ensureOrderItem(btn.dataset.addId, true);
    order.items.get(btn.dataset.addId).checked = true;
    order.addSearch = "";
    order.justAdded = btn.dataset.addId;
    renderOrder();
    toast("품목을 추가했어요");
  });
  $("orderToMail")?.addEventListener("click", () => {
    if (selectedOrderLines().length === 0) {
      toast("보낼 품목을 하나 이상 체크하고 수량을 넣어주세요.", "error");
      return;
    }
    order.step = "mail";
    renderOrder();
  });
}

// 발주서로 만든 품목·수량을 발주 기록으로 남긴다 (입고 대기 표시, 중복 발주 방지)
function orderRecordItems() {
  return selectedOrderLines().map(({ p, item }) => ({
    productId: p.id,
    name: p.name,
    vendorItemName: p.supplier?.vendorItemName || "",
    qty: item.qty,
    leadTimeDays: p.leadTimeDays,
    stockAtOrder: p.stockQuantity,
  }));
}

// 메일을 복사하거나 메일 창을 열면 "보내려는 발주서"로 저장해 둔다.
// '발주 완료로 처리'를 깜빡하면 첫 화면 '오늘 할 일'에 알림이 뜬다 (처리하면 서버가 지운다).
async function saveOrderDraft() {
  if (order.recorded || order.draftSaved) return;
  order.draftSaved = true;
  try {
    await postJson("/api/order-drafts", "POST", { vendorId: order.vendorId, items: orderRecordItems() });
  } catch {
    order.draftSaved = false; // 저장 못 해도 메일 쓰기는 계속
  }
}

async function recordCurrentOrder() {
  const btn = $("orderRecord");
  const lines = selectedOrderLines();
  if (!lines.length || order.recorded) return;
  btn.disabled = true;
  try {
    await postJson("/api/orders", "POST", { vendorId: order.vendorId, items: orderRecordItems() });
  } catch (err) {
    btn.disabled = false;
    toast(err.message || "기록하지 못했어요.", "error");
    return;
  }
  order.recorded = true;
  toast(`${lines.length}개 품목을 발주 완료로 처리했어요`);
  // 메일 화면에서 고친 내용이 지워지지 않게, 발주서 창은 다시 그리지 않고 기록 영역만 바꾼다
  const bar = btn.closest(".record-bar");
  bar.classList.add("done");
  bar.querySelector("strong").textContent = "발주 완료로 처리했어요";
  bar.querySelector(".record-text span").textContent = "이 품목들은 '입고 대기'로 표시돼요. 입고되면 '발주 기록'에서 입고 완료를 눌러주세요.";
  btn.textContent = "처리됨 ✓";
  await loadProducts();
}

const GMAIL_URL_MAX = 7000; // Gmail 쓰기 주소 길이 한도 (여유 있게)
const GMAIL_PASTE_HINT = "[발주 내용이 길어서 복사해 뒀어요. 이 칸을 누르고 Ctrl + A 를 누른 다음 Ctrl + V 를 누르세요]";

function renderOrderMail() {
  const mail = buildOrderMail();
  const vendor = vendorById(order.vendorId);
  $("orderBody").innerHTML = `
    <div class="order-top">
    <h3>발주 메일 — ${escapeHtml(vendor?.name || "")} <span class="lang-badge">${escapeHtml(mail.lang.label)}</span></h3>
    <div class="order-vendor-line">
      <button class="btn-ghost btn-sm" id="orderBack">← 품목 다시 고르기</button>
      <span class="spacer"></span>
      <button class="btn-ghost btn-sm" id="orderMailto">PC 메일 프로그램으로 열기</button>
      <a class="btn-primary btn-sm" id="orderOpenGmail" href="https://mail.google.com/" target="_blank" rel="noopener">Gmail로 보내기</a>
    </div>
    <div class="record-bar ${order.recorded ? "done" : ""}">
      <div class="record-text">
        <strong>${order.recorded ? "발주 완료로 처리했어요" : "메일을 보냈으면 발주 완료로 처리해 주세요"}</strong>
        <span>${order.recorded ? "이 품목들은 '입고 대기'로 표시돼요. 입고되면 '발주 기록'에서 입고 완료를 눌러주세요." : "기록하면 '입고 대기'로 표시되고, 같은 품목을 또 발주하지 않게 알려줘요."}</span>
      </div>
      <button class="btn-primary" id="orderRecord" ${order.recorded ? "disabled" : ""}>${order.recorded ? "처리됨 ✓" : "발주 완료로 처리"}</button>
    </div>
    </div>
    <div class="order-pane">
    <ol class="mail-steps">
      <li>위 <b>Gmail로 보내기</b>를 누르면 받는 사람 · 제목 · 본문이 채워진 Gmail 쓰기 창이 열려요.</li>
      <li>내용을 확인하고 Gmail에서 <b>보내기</b>를 눌러요. 품목이 많으면 본문은 복사만 돼 있어요. Gmail 본문 칸을 누르고 <b>Ctrl + A</b>, <b>Ctrl + V</b>를 누르세요.</li>
      <li>보냈으면 위 <b>발주 완료로 처리</b>를 눌러요.</li>
    </ol>
    <div class="mail-field">
      <div class="mail-field-head"><span>받는 사람</span><button type="button" class="btn-outline btn-sm" data-copy="orderTo">복사</button></div>
      <input id="orderTo" class="input" value="${escapeHtml(mail.to)}" placeholder="업체 이메일이 없어요" />
    </div>
    <div class="mail-field">
      <div class="mail-field-head"><span>제목</span><button type="button" class="btn-outline btn-sm" data-copy="orderSubject">복사</button></div>
      <input id="orderSubject" class="input" value="${escapeHtml(mail.subject)}" />
    </div>
    <div class="mail-field">
      <div class="mail-field-head"><span>본문</span><button type="button" class="btn-outline btn-sm" data-copy="orderMailBody">복사</button></div>
      <textarea id="orderMailBody" class="input" rows="12">${escapeHtml(mail.body)}</textarea>
    </div>
    <p class="muted small">여기서 내용을 고쳐도 돼요. 고친 내용 그대로 복사돼요. 매번 쓰는 문구는 상단 <b>메일 양식</b>에서 바꿀 수 있어요.</p>
    </div>
  `;
  $("orderRecord").addEventListener("click", recordCurrentOrder);
  order.draftSaved = false; // 품목을 다시 골랐을 수 있으니 이 메일 화면에서 다시 저장
  // 누르는 순간의 칸 내용(고친 내용 포함)으로 Gmail 쓰기 창을 연다.
  // Gmail 은 주소가 너무 길면(실측 8천 자는 되고 1만2천 자는 400 오류) 거부해서, 본문이 길면
  // 받는 사람 · 제목만 채워 열고 본문은 복사해 둔 뒤 붙여넣으라고 알려준다 (한글은 주소에서 한 글자가 9자)
  $("orderOpenGmail").addEventListener("click", async (e) => {
    e.preventDefault();
    const link = e.currentTarget; // await 뒤에는 e.currentTarget 이 비어 있어서 미리 잡아 둔다
    saveOrderDraft();
    const enc = encodeURIComponent;
    const base = `https://mail.google.com/mail/?view=cm&fs=1&to=${enc($("orderTo").value.trim())}&su=${enc($("orderSubject").value)}`;
    const full = `${base}&body=${enc($("orderMailBody").value)}`;
    if (full.length <= GMAIL_URL_MAX) {
      link.href = full;
      window.open(full, "_blank", "noopener");
      return;
    }
    const copied = await copyText($("orderMailBody").value);
    // Gmail 본문 칸에 할 일을 적어 둔다 (전체 선택 후 붙여넣으면 이 글은 사라지고 발주 내용이 들어감)
    const hint = copied ? `&body=${enc(GMAIL_PASTE_HINT)}` : "";
    link.href = base + hint;
    window.open(base + hint, "_blank", "noopener");
    toast(copied
      ? "본문이 길어서 Gmail에 다 못 넣었어요. 본문을 복사해 뒀으니 Gmail 본문 칸을 누르고 Ctrl + V 를 누르세요"
      : "본문이 길어서 Gmail에 다 못 넣었어요. 아래 본문 '복사'를 눌러 Gmail 본문 칸에 붙여넣으세요", copied ? "info" : "error");
  });
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      saveOrderDraft();
      const ok = await copyText($(btn.dataset.copy).value);
      if (!ok) { toast("복사하지 못했어요. 직접 선택해서 복사해주세요.", "error"); return; }
      btn.textContent = "복사됨 ✓";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "복사"; btn.classList.remove("copied"); }, 1800);
    });
  });
  $("orderBack").addEventListener("click", () => { order.step = "items"; renderOrder(); });
  $("orderMailto").addEventListener("click", () => {
    saveOrderDraft();
    window.location.href = `mailto:${encodeURIComponent($("orderTo").value.trim())}?subject=${encodeURIComponent($("orderSubject").value)}&body=${encodeURIComponent($("orderMailBody").value)}`;
  });
}

// ── 라벨 · 업체 관리 공통: "품목 지정" 탭 ────────────
// 라벨 관리와 업체 관리는 똑같이 [목록 관리] [품목 지정] 두 탭으로 나뉜다.
// 품목 지정 탭: 지정 안 된 품목만 / 전체 품목을 보고, 골라서 한 번에 지정 · 변경 · 해제한다.

// 팝업 안 목록을 다시 그려도 스크롤 위치를 유지한다. 같은 화면(탭·보기)일 때만 유지하고, 탭을 바꾸면 맨 위부터.
// 사용: const top = paneScrollBefore(id, key); ...innerHTML 다시 그리기...; paneScrollAfter(id, top)
function paneScrollBefore(bodyId, viewKey) {
  const pane = document.querySelector(`#${bodyId} .manager-pane`);
  return pane && pane.dataset.view === viewKey ? pane.scrollTop : 0;
}
function paneScrollAfter(bodyId, top) {
  const pane = document.querySelector(`#${bodyId} .manager-pane`);
  if (pane && top) pane.scrollTop = top;
}

// 팝업을 새로 열 때는 지난번 스크롤 위치를 쓰지 않는다
function resetPaneScroll(bodyId) {
  const pane = document.querySelector(`#${bodyId} .manager-pane`);
  if (pane) pane.dataset.view = "";
}

function newManagerState() {
  return { tab: "list", selected: new Set(), search: "", filter: "none", listSearch: "" };
}

// cfg: { prefix, bodyId, state, field, noun, obj(목적격 "라벨을"), subj(주격 "라벨이"), verb, options, chip, assignUrl }
function assignPaneHtml(cfg) {
  const { state, prefix, field, noun, verb, options } = cfg;
  const products = currentData?.products || [];
  if (!options.length) {
    return `<div class="hint-box">'${noun} 목록' 탭에서 ${cfg.obj} 먼저 추가하면, 여기서 품목을 골라 한 번에 ${verb}할 수 있어요.</div>`;
  }
  if (!products.length) return `<div class="hint-box">품목을 불러온 뒤에 ${verb}할 수 있어요.</div>`;

  const base = state.filter === "none" ? products.filter((p) => !p[field]) : products;
  const query = state.search.trim().toLowerCase();
  const visible = query ? base.filter((p) => p.name.toLowerCase().includes(query)) : base;
  const allChecked = visible.length > 0 && visible.every((p) => state.selected.has(p.id));

  return `
    <div class="bulk-bar">
      <select id="${prefix}AssignFilter" class="input" aria-label="보기">
        <option value="none" ${state.filter === "none" ? "selected" : ""}>${noun} 없는 품목만</option>
        <option value="all" ${state.filter === "all" ? "selected" : ""}>전체 품목</option>
      </select>
      <input id="${prefix}AssignSearch" class="input search" type="search" placeholder="품목 검색" value="${escapeHtml(state.search)}" />
      <label class="check"><input type="checkbox" id="${prefix}AssignCheckAll" ${allChecked ? "checked" : ""} /> 전체 선택</label>
      <div class="bulk-actions">
      <span class="muted small">선택한 품목을</span>
      <select id="${prefix}AssignTarget" class="input" aria-label="${noun} 선택">
        <option value="">${noun} 선택</option>
        ${options.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join("")}
        <option value="__none__">(${noun} 해제)</option>
      </select>
      <button class="btn-primary btn-sm" id="${prefix}AssignBtn" ${state.selected.size ? "" : "disabled"}>선택한 ${state.selected.size}개 ${verb}</button>
      </div>
    </div>
    <div class="unlabeled-list">
      ${visible.length
        ? visible.map((p) => `
          <div class="unlabeled-row assign-row ${state.selected.has(p.id) ? "checked" : ""}" data-product-id="${escapeHtml(p.id)}">
            <input type="checkbox" ${state.selected.has(p.id) ? "checked" : ""} aria-label="선택" />
            <span class="name" title="${escapeHtml(p.name)}">${nameHtml(p)}</span>
            ${state.filter === "all" ? `<span class="assign-current">${cfg.chip(p)}</span>` : ""}
          </div>`).join("")
        : `<div class="empty-note">${query ? "검색 결과가 없어요" : state.filter === "none" ? `모든 품목에 ${cfg.subj} 지정돼 있어요. '전체 품목'으로 바꾸면 이미 지정된 품목도 바꿀 수 있어요.` : "품목이 없어요"}</div>`}
    </div>`;
}

function bindAssignPane(cfg, rerender) {
  const { state, prefix } = cfg;
  const products = currentData?.products || [];
  const base = state.filter === "none" ? products.filter((p) => !p[cfg.field]) : products;
  const query = state.search.trim().toLowerCase();
  const visible = query ? base.filter((p) => p.name.toLowerCase().includes(query)) : base;

  $(`${prefix}AssignFilter`)?.addEventListener("change", (e) => {
    state.filter = e.target.value;
    state.selected.clear();
    rerender();
  });
  const search = $(`${prefix}AssignSearch`);
  search?.addEventListener("input", () => {
    state.search = search.value;
    rerender();
    const again = $(`${prefix}AssignSearch`);
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  });
  $(`${prefix}AssignCheckAll`)?.addEventListener("change", (e) => {
    for (const p of visible) {
      if (e.target.checked) state.selected.add(p.id);
      else state.selected.delete(p.id);
    }
    rerender();
  });
  // 품목을 누를 때는 목록을 다시 그리지 않고 그 줄과 버튼만 바꾼다
  // (다시 그리면 스크롤이 맨 위로 튀어서, 긴 목록 아래쪽을 고를 때마다 다시 내려가야 했음)
  const refreshSelectionUi = () => {
    const btn = $(`${prefix}AssignBtn`);
    if (btn) {
      btn.disabled = state.selected.size === 0;
      btn.textContent = `선택한 ${state.selected.size}개 ${cfg.verb}`;
    }
    const all = $(`${prefix}AssignCheckAll`);
    if (all) all.checked = visible.length > 0 && visible.every((p) => state.selected.has(p.id));
  };
  document.querySelectorAll(`#${cfg.bodyId} .assign-row`).forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.productId;
      const on = !state.selected.has(id);
      if (on) state.selected.add(id);
      else state.selected.delete(id);
      row.classList.toggle("checked", on);
      row.querySelector("input[type=checkbox]").checked = on;
      refreshSelectionUi();
    });
  });
  $(`${prefix}AssignBtn`)?.addEventListener("click", async () => {
    const target = $(`${prefix}AssignTarget`).value;
    const productIds = [...state.selected];
    if (!target) {
      toast(`${cfg.obj} 선택해주세요.`, "error");
      return;
    }
    const clear = target === "__none__";
    try {
      await postJson(cfg.assignUrl, "POST", { productIds, [cfg.field]: clear ? "" : target });
    } catch (err) {
      toast(err.message || `${cfg.noun} ${cfg.verb}에 실패했어요.`, "error");
      return;
    }
    state.selected.clear();
    // 검색 결과를 다 처리하고 나면 빈 목록만 남으므로, 검색을 풀어 남은 품목을 보여준다
    state.search = "";
    toast(clear ? `${productIds.length}개 품목의 ${cfg.obj} 해제했어요` : `${productIds.length}개 품목에 ${cfg.obj} ${cfg.verb}했어요`);
    await refreshAfterLabelChange();
  });
}

// 두 탭 머리글
function managerTabsHtml(state, listLabel, listCount, assignLabel, unassignedCount) {
  return `
    <div class="tabs manager-tabs" role="tablist">
      <button type="button" class="tab ${state.tab === "list" ? "active" : ""}" data-mgr-tab="list">${listLabel} <span class="tab-count">${listCount}</span></button>
      <button type="button" class="tab ${state.tab === "assign" ? "active" : ""}" data-mgr-tab="assign">${assignLabel} ${unassignedCount ? `<span class="dot-badge">${unassignedCount}</span>` : ""}</button>
    </div>`;
}

function bindManagerTabs(bodyId, state, rerender) {
  document.querySelectorAll(`#${bodyId} [data-mgr-tab]`).forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.mgrTab !== state.tab && !confirmDiscardEdits($(bodyId))) return;
      state.tab = b.dataset.mgrTab;
      rerender();
    });
  });
  // 목록 탭 검색: 다시 그리지 않고 줄만 숨긴다 (입력 중 커서 유지)
  const listSearch = document.querySelector(`#${bodyId} .list-search`);
  listSearch?.addEventListener("input", () => {
    state.listSearch = listSearch.value;
    const q = listSearch.value.trim().toLowerCase();
    document.querySelectorAll(`#${bodyId} [data-search-text]`).forEach((row) => {
      row.hidden = q && !row.dataset.searchText.includes(q);
    });
  });
}

// ── 목록 줄 고치기: 고친 줄에만 "변경 저장" 버튼이 나타난다 ─────────
// 줄: [data-edit-id], 칸: [data-field], 저장 버튼: .row-save-btn
function editRowValues(row) {
  return Object.fromEntries([...row.querySelectorAll("[data-field]")].map((el) => [el.dataset.field, el.value]));
}

function updateRowDirty(row) {
  const now = editRowValues(row);
  const dirty = Object.keys(now).some((k) => now[k] !== row.querySelector(`[data-field="${k}"]`).dataset.orig);
  row.classList.toggle("dirty", dirty);
  const btn = row.querySelector(".row-save-btn");
  btn.disabled = !dirty;
  btn.style.visibility = dirty ? "" : "hidden"; // 자리는 남겨서 줄 모양이 흔들리지 않게
}

function bindEditRows(bodyId, save) {
  document.querySelectorAll(`#${bodyId} [data-edit-id]`).forEach((row) => {
    row.querySelectorAll("[data-field]").forEach((el) => {
      el.dataset.orig ??= el.value;
      el.addEventListener("input", () => updateRowDirty(row));
      el.addEventListener("change", () => updateRowDirty(row));
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" && row.classList.contains("dirty")) save(row); });
    });
    row.querySelector(".row-save-btn").addEventListener("click", () => save(row));
    updateRowDirty(row);
  });
}

// 다시 그리기 전에 저장 안 한 줄의 입력값을 챙겨 두었다가 되살린다 (다른 줄을 저장해도 안 사라지게)
function captureDirtyRows(bodyId) {
  const saved = new Map();
  if ($(bodyId).closest(".overlay")?.hidden) return saved; // 닫혀 있던 창은 새로 시작
  document.querySelectorAll(`#${bodyId} [data-edit-id].dirty`).forEach((row) => saved.set(row.dataset.editId, editRowValues(row)));
  return saved;
}

function restoreDirtyRows(bodyId, saved) {
  for (const [id, values] of saved) {
    const row = document.querySelector(`#${bodyId} [data-edit-id="${CSS.escape(id)}"]`);
    if (!row) continue;
    for (const [k, v] of Object.entries(values)) {
      const el = row.querySelector(`[data-field="${k}"]`);
      if (el) el.value = v;
    }
    updateRowDirty(row);
  }
}

// 저장 안 한 줄이 있으면 첫 번째는 알려주고 막는다. 4초 안에 한 번 더 하면 버리고 진행
function confirmDiscardEdits(container) {
  const dirty = container.querySelectorAll("[data-edit-id].dirty");
  if (!dirty.length || container.dataset.discardOk) {
    delete container.dataset.discardOk;
    return true;
  }
  container.dataset.discardOk = "1";
  setTimeout(() => delete container.dataset.discardOk, 4000);
  dirty.forEach((row) => row.classList.add("dirty-flash"));
  setTimeout(() => dirty.forEach((row) => row.classList.remove("dirty-flash")), 1200);
  dirty[0].scrollIntoView({ block: "nearest" });
  toast("저장 안 한 내용이 있어요. '변경 저장'을 누르거나, 버리려면 한 번 더 눌러주세요.", "error");
  return false;
}

// 목록이 길어지면 찾기 쉽게 검색칸을 보여준다
function listSearchHtml(count, placeholder, value) {
  return count > 5 ? `<input class="input search list-search" type="search" placeholder="${placeholder}" value="${escapeHtml(value)}" />` : "";
}

function matchesListSearch(state, text) {
  const q = state.listSearch.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

// ── 업체 관리 ───────────────────────────────────────

// 업체의 발주서 언어 고르기 상자
function langSelectHtml(className, selected, id, field) {
  return `<select class="${className}" ${id ? `id="${id}"` : ""} ${field ? `data-field="${field}"` : ""} aria-label="발주서 언어" title="발주서 언어">
    ${mailLanguages.map((l) => `<option value="${l.code}" ${l.code === selected ? "selected" : ""}>${escapeHtml(l.label)}</option>`).join("")}
  </select>`;
}

const vendorManagerState = newManagerState();

function vendorAssignCfg() {
  return {
    prefix: "vendor",
    bodyId: "vendorManagerBody",
    state: vendorManagerState,
    field: "vendorId",
    noun: "업체",
    obj: "업체를",
    subj: "업체가",
    verb: "연결",
    options: currentVendors,
    chip: (p) => (p.vendor ? `<span class="vendor-chip">${escapeHtml(p.vendor.name)}</span>` : `<span class="label-chip none">업체 없음</span>`),
    assignUrl: "/api/vendors/assign",
  };
}

// tab: "list" | "assign" (생략하면 연결 안 된 품목이 있을 때 품목 연결 탭부터)
function openVendorManager(tab) {
  const s = vendorManagerState;
  s.selected.clear();
  s.search = "";
  s.listSearch = "";
  s.filter = "none";
  s.tab = tab || (currentVendors.length && getProductsWithoutVendor().length ? "assign" : "list");
  resetPaneScroll("vendorManagerBody");
  renderVendorManagerBody();
  openModal("vendorOverlay");
}

function renderVendorManagerBody() {
  const s = vendorManagerState;
  const unassigned = getProductsWithoutVendor();
  const countByVendor = new Map();
  for (const p of currentData?.products || []) if (p.vendorId) countByVendor.set(p.vendorId, (countByVendor.get(p.vendorId) || 0) + 1);

  const listPane = `
    <div class="vendor-edit-row new">
      <input id="newVendorName" class="input" type="text" placeholder="새 업체 이름 (예: 글라스월드)" />
      <input id="newVendorEmail" class="input" type="email" placeholder="이메일 (예: order@glass.co.kr)" />
      ${langSelectHtml("input", "ko", "newVendorLang")}
      ${cycleInputHtml("", "newVendorCycle")}
      <span></span>
      <div class="label-row-actions"><button class="btn-primary btn-sm" id="createVendorBtn">업체 추가</button></div>
    </div>
    ${listSearchHtml(currentVendors.length, "업체 검색", s.listSearch)}
    <div class="label-list">
      ${currentVendors.length ? currentVendors.map((v) => `
        <div class="vendor-edit-row" data-vendor-id="${escapeHtml(v.id)}" data-edit-id="${escapeHtml(v.id)}" data-search-text="${escapeHtml(`${v.name} ${v.email || ""}`.toLowerCase())}" ${matchesListSearch(s, `${v.name} ${v.email || ""}`) ? "" : "hidden"}>
          <input class="input vendor-edit-name" data-field="name" type="text" value="${escapeHtml(v.name)}" aria-label="업체 이름" />
          <input class="input vendor-edit-email" data-field="email" type="email" value="${escapeHtml(v.email || "")}" placeholder="이메일" aria-label="이메일" />
          ${langSelectHtml("input vendor-edit-lang", v.lang || "ko", null, "lang")}
          ${cycleInputHtml(v.orderCycleDays ?? "", null, v.learnedCycle)}
          <span class="muted small nowrap">품목 ${countByVendor.get(v.id) || 0}개</span>
          <div class="label-row-actions">
            <button class="btn-primary btn-sm row-save-btn update-vendor-btn" style="visibility:hidden" disabled>변경 저장</button>
            <button class="btn-danger-ghost btn-sm delete-vendor-btn">삭제</button>
          </div>
        </div>`).join("") : `<div class="empty-note">아직 등록된 업체가 없어요. 위 칸에서 추가해주세요.</div>`}
    </div>`;

  const cfg = vendorAssignCfg();
  const keepTop = paneScrollBefore("vendorManagerBody", `${s.tab}|${s.filter}`);
  const unsaved = captureDirtyRows("vendorManagerBody");
  $("vendorManagerBody").innerHTML = `
    <h3>거래 업체</h3>
    <p class="modal-desc">발주를 보내는 업체와 이메일을 등록하고, 품목을 업체에 연결해요. 발주서를 만들 때 업체를 고르면 연결된 품목이 나와요.
      <b>발주 간격</b>은 '발주 완료로 처리'한 기록을 보고 자동으로 계산해요(업체마다 발주 3번부터). 계산이 이상할 때만 직접 적어주세요.</p>
    ${managerTabsHtml(s, "업체 목록", currentVendors.length, "품목 연결", unassigned.length)}
    <div class="manager-pane" data-view="${s.tab}|${s.filter}">${s.tab === "list" ? listPane : assignPaneHtml(cfg)}</div>
  `;

  paneScrollAfter("vendorManagerBody", keepTop);
  const rerender = () => renderVendorManagerBody();
  bindManagerTabs("vendorManagerBody", s, rerender);
  if (s.tab === "assign") {
    bindAssignPane(cfg, rerender);
    return;
  }

  $("createVendorBtn").addEventListener("click", createVendorFromForm);
  for (const id of ["newVendorName", "newVendorEmail"]) {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") createVendorFromForm(); });
  }
  bindEditRows("vendorManagerBody", async (row) => {
    const name = row.querySelector(".vendor-edit-name").value.trim();
    const email = row.querySelector(".vendor-edit-email").value.trim();
    const lang = row.querySelector(".vendor-edit-lang").value;
    const orderCycleDays = row.querySelector(".vendor-edit-cycle").value;
    try {
      await postJson(`/api/vendors/${row.dataset.vendorId}`, "PUT", { name, email, lang, orderCycleDays });
    } catch (err) {
      toast(err.message || "업체 저장에 실패했어요.", "error");
      return;
    }
    row.classList.remove("dirty");
    toast("업체를 저장했어요");
    await refreshAfterLabelChange();
  });
  restoreDirtyRows("vendorManagerBody", unsaved);
  document.querySelectorAll(".delete-vendor-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".vendor-edit-row");
      confirmClick(btn, "한 번 더 누르면 삭제", async () => {
        try {
          await fetchJson(`/api/vendors/${row.dataset.vendorId}`, { method: "DELETE" });
        } catch (err) {
          toast(err.message || "업체 삭제에 실패했어요.", "error");
          return;
        }
        toast("업체를 삭제했어요");
        await refreshAfterLabelChange();
      });
    });
  });
}

// 업체별 발주 간격 칸. 비워두면 발주 기록에서 알아낸 간격(자동), 기록이 적으면 기본값. 자동이 틀릴 때만 적는다
function cycleInputHtml(value, id, learned) {
  const def = currentData?.settings?.orderCycleDays ?? 14;
  const hint = learned ? `자동 ${learned.days}` : String(def);
  const title = learned ? `최근 발주 ${learned.orders}번을 보면 약 ${learned.days}일마다 발주했어요. 비워두면 이 값을 써요` : `발주 기록이 3번 쌓이면 자동으로 계산해요. 그 전에는 기본 ${def}일`;
  return `<div class="input-suffix cycle-input" title="${escapeHtml(title)}">
    <input class="input vendor-edit-cycle" ${id ? `id="${id}"` : 'data-field="orderCycleDays"'} type="number" min="0" value="${escapeHtml(String(value))}" placeholder="${hint}" aria-label="발주 간격" /><span>일마다</span>
  </div>`;
}

// 품목 상세: 어떤 발주 간격으로 계산했는지
function cycleNoteText(p) {
  const d = p.orderCycleDays ?? 0;
  if (p.orderCycleSource === "vendor") return `발주 간격 ${d}일 (업체 관리에서 직접 정한 값)`;
  if (p.orderCycleSource === "auto") return `발주 간격 약 ${d}일 (이 업체 발주 기록에서 자동으로 계산)`;
  return `발주 간격 ${d}일 (기본값 · 이 업체에 발주 기록이 3번 쌓이면 자동으로 맞춰요)`;
}

async function createVendorFromForm() {
  const name = $("newVendorName").value.trim();
  const email = $("newVendorEmail").value.trim();
  const lang = $("newVendorLang").value;
  const orderCycleDays = $("newVendorCycle").value;
  if (!name) {
    toast("업체 이름을 입력해주세요.", "error");
    return;
  }
  try {
    await postJson("/api/vendors", "POST", { name, email, lang, orderCycleDays });
  } catch (err) {
    toast(err.message || "업체 추가에 실패했어요.", "error");
    return;
  }
  toast(`'${name}' 업체를 추가했어요`);
  await refreshAfterLabelChange();
}

// ── 발주 기록 ───────────────────────────────────────
// 입고 대기(아직 안 들어온 발주) / 전체 기록 두 탭. 품목별 또는 발주 전체를 입고 처리하고, 잘못 기록한 발주는 취소한다.

const ordersState = { tab: "pending", vendor: "all", orders: [] };

async function openOrders() {
  ordersState.tab = "pending";
  ordersState.vendor = "all";
  resetPaneScroll("ordersBody");
  await reloadOrders();
  openModal("ordersOverlay");
}

async function reloadOrders() {
  try {
    ordersState.orders = await fetchJson("/api/orders");
  } catch (err) {
    toast(err.message || "발주 기록을 불러오지 못했어요.", "error");
  }
  renderOrders();
}

function isOpenOrder(o) {
  return o.items.some((i) => !i.receivedAt);
}

// 지금 스토어에서 파는 품목인지 (옵션으로 나누기 전 상품번호로 기록한 것도 포함). 품목을 못 불러왔으면 있다고 본다.
// 스토어에서 지우거나 판매중지한 품목의 발주는 자동 입고가 안 되므로 '빼기'로 정리하게 알려준다
function inStore(productId) {
  const products = currentData?.products;
  if (!products) return true;
  return products.some((p) => p.id === productId || p.parentId === productId);
}

// 입고 대기 숫자: 스토어에 없는 품목만 남은 발주는 세지 않는다
function waitingOrderCount(orders) {
  return orders.filter((o) => o.items.some((i) => !i.receivedAt && inStore(i.productId))).length;
}

function renderOrders() {
  const s = ordersState;
  const all = s.orders;
  const open = all.filter(isOpenOrder);
  const source = s.tab === "pending" ? open : all;
  const list = s.vendor === "all" ? source : source.filter((o) => o.vendorId === s.vendor);
  const vendorIds = [...new Set(all.map((o) => o.vendorId))];

  const cards = list.map((o) => {
    const received = o.items.filter((i) => i.receivedAt).length;
    const done = received === o.items.length;
    return `
      <div class="order-card ${done ? "done" : ""}" data-order-id="${escapeHtml(o.id)}">
        <div class="order-card-head">
          <strong>${escapeHtml(vendorById(o.vendorId)?.name || o.vendorName || "업체 미지정")}</strong>${o.direct ? `<span class="direct-badge" title="발주서 없이 첫 화면에서 기록">직접 기록</span>` : ""}${o.lateRecord ? `<span class="direct-badge" title="재고가 늘어난 걸 보고 나중에 기록했어요. 발주일은 리드타임으로 짐작한 날짜예요">나중에 기록</span>` : ""}
          <span class="muted small">${shortDate(o.createdAt)} 발주 · ${daysAgoText(o.createdAt)} · ${o.items.length}개 품목</span>
          <span class="status ${done ? "ok" : received ? "warn" : "none"}">${done ? "입고 완료" : `입고 ${received}/${o.items.length}`}</span>
          <span class="spacer"></span>
          ${done ? "" : `<button class="btn-outline btn-sm" data-receive-all>모두 입고 완료</button>`}
          <button class="btn-danger-ghost btn-sm" data-cancel-order>발주 취소</button>
        </div>
        <div class="order-card-items">
          ${o.items.map((i) => {
            const gone = !i.receivedAt && !inStore(i.productId);
            const late = !i.receivedAt && !gone && isLate(i.expectedAt);
            return `
            <div class="order-item" data-product-id="${escapeHtml(i.productId)}">
              <span class="name">${escapeHtml(i.name)}${i.vendorItemName ? `<small>업체용: ${escapeHtml(i.vendorItemName)}</small>` : ""}${i.autoReceived ? `<small class="arrived-note">스마트스토어 재고가 늘어서 자동 입고 (${i.stockAtOrder}개 → ${i.stockAtReceive}개)</small>` : ""}</span>
              <span class="num">${i.receivedAt ? `${i.qty}개` : `<input class="input order-item-qty" type="number" min="1" value="${i.qty}" aria-label="발주 수량" />개`}</span>
              <span class="order-item-state ${i.receivedAt ? "received" : late || gone ? "late" : ""}" ${gone ? 'title="스토어에서 지웠거나 판매중지한 품목이라 자동 입고가 안 돼요. 더 안 받을 거면 빼기를 누르세요"' : ""}>${i.receivedAt ? `입고 ${shortDate(i.receivedAt)}` : gone ? "스토어에 없는 품목" : late ? `입고 지연 (${shortDate(i.expectedAt)} 예정)` : `${shortDate(i.expectedAt)} 입고 예정`}</span>
              <span class="order-item-actions">${i.receivedAt ? `<button class="btn-ghost btn-sm" data-unreceive>되돌리기</button>` : gone ? `<button class="btn-danger-ghost btn-sm" data-remove-item>빼기</button>` : `<button class="btn-outline btn-sm" data-receive>입고</button><button class="btn-danger-ghost btn-sm" data-remove-item>빼기</button>`}</span>
            </div>`;
          }).join("")}
        </div>
      </div>`;
  }).join("");

  const keepTop = paneScrollBefore("ordersBody", `${s.tab}|${s.vendor}`);
  $("ordersBody").innerHTML = `
    <h3>발주 기록</h3>
    <p class="modal-desc">발주서나 첫 화면에서 '발주 완료로 처리'한 내용이에요. 물건이 들어와 <b>스마트스토어 재고를 올리면 자동으로 입고 처리</b>돼요. 수량이 틀렸으면 그 칸을 고치고, 잘못 넣은 품목은 <b>빼기</b>를 누르세요.</p>
    <div class="orders-toolbar">
      <div class="tabs manager-tabs" role="tablist">
        <button type="button" class="tab ${s.tab === "pending" ? "active" : ""}" data-orders-tab="pending">입고 대기 ${waitingOrderCount(open) ? `<span class="dot-badge">${waitingOrderCount(open)}</span>` : ""}</button>
        <button type="button" class="tab ${s.tab === "all" ? "active" : ""}" data-orders-tab="all">전체 기록 <span class="tab-count">${all.length}</span></button>
      </div>
      ${vendorIds.length > 1 ? `
        <select id="ordersVendorFilter" class="input" aria-label="업체">
          <option value="all">모든 업체</option>
          ${vendorIds.map((id) => `<option value="${escapeHtml(id)}" ${s.vendor === id ? "selected" : ""}>${escapeHtml(vendorById(id)?.name || all.find((o) => o.vendorId === id).vendorName || "업체 미지정")}</option>`).join("")}
        </select>` : ""}
    </div>
    <div class="manager-pane" data-view="${s.tab}|${s.vendor}">
      ${list.length ? cards : `<div class="empty-note">${s.tab === "pending" ? "<strong>입고를 기다리는 발주가 없어요</strong>발주서를 보낸 뒤 '발주 완료로 처리'를 누르면 여기에 나와요." : "<strong>발주 기록이 없어요</strong>"}</div>`}
    </div>
  `;

  paneScrollAfter("ordersBody", keepTop);
  document.querySelectorAll("[data-orders-tab]").forEach((b) => {
    b.addEventListener("click", () => { s.tab = b.dataset.ordersTab; renderOrders(); });
  });
  $("ordersVendorFilter")?.addEventListener("change", (e) => { s.vendor = e.target.value; renderOrders(); });

  const act = async (fn, message) => {
    try {
      await fn();
    } catch (err) {
      toast(err.message || "처리하지 못했어요.", "error");
      return;
    }
    if (message) toast(message);
    await reloadOrders();
    await loadProducts();
  };
  document.querySelectorAll("#ordersBody .order-card").forEach((card) => {
    const id = card.dataset.orderId;
    card.querySelector("[data-receive-all]")?.addEventListener("click", () =>
      act(() => postJson(`/api/orders/${id}/receive`, "POST", {}), "모두 입고 완료로 표시했어요"));
    const cancel = card.querySelector("[data-cancel-order]");
    cancel.addEventListener("click", () =>
      confirmClick(cancel, "한 번 더 누르면 취소", () => act(() => fetchJson(`/api/orders/${id}`, { method: "DELETE" }), "발주 기록을 취소했어요")));
    card.querySelectorAll(".order-item").forEach((row) => {
      const productId = row.dataset.productId;
      row.querySelector("[data-receive]")?.addEventListener("click", () =>
        act(() => postJson(`/api/orders/${id}/receive`, "POST", { productIds: [productId] }), "입고 완료로 표시했어요"));
      row.querySelector("[data-unreceive]")?.addEventListener("click", () =>
        act(() => postJson(`/api/orders/${id}/unreceive`, "POST", { productId }), "입고 표시를 되돌렸어요"));
      const qty = row.querySelector(".order-item-qty");
      qty?.addEventListener("change", () => {
        const n = Math.floor(Number(qty.value));
        if (!(n > 0)) { toast("수량은 1 이상으로 입력해주세요.", "error"); qty.value = qty.defaultValue; return; }
        act(() => postJson(`/api/orders/${id}/items/${encodeURIComponent(productId)}`, "PUT", { qty: n }), "발주 수량을 고쳤어요");
      });
      qty?.addEventListener("keydown", (e) => { if (e.key === "Enter") qty.blur(); });
      const remove = row.querySelector("[data-remove-item]");
      remove?.addEventListener("click", () =>
        confirmClick(remove, "한 번 더 누르면 빼기", () => act(() => fetchJson(`/api/orders/${id}/items/${encodeURIComponent(productId)}`, { method: "DELETE" }), "품목을 발주 기록에서 뺐어요")));
    });
  });
}

// ── 판단 기준 ───────────────────────────────────────

function openSettings() {
  if (currentData) {
    $("lookbackDays").value = currentData.settings.lookbackDays;
    $("bufferDays").value = currentData.settings.bufferDays;
    $("orderCycleDays").value = currentData.settings.orderCycleDays ?? "";
  }
  openModal("settingsOverlay");
}

async function applySettings() {
  const lookbackDays = $("lookbackDays").value;
  const bufferDays = $("bufferDays").value;
  const orderCycleDays = $("orderCycleDays").value;
  if (!(Number(lookbackDays) >= 1) || bufferDays === "" || Number(bufferDays) < 0 || orderCycleDays === "" || Number(orderCycleDays) < 0) {
    toast("판매 속도 계산 기간은 1일 이상, 안전 여유일수와 발주 간격은 0일 이상으로 입력해주세요.", "error");
    return;
  }
  const btn = $("applySettings");
  btn.disabled = true;
  btn.textContent = "적용 중…";
  try {
    const ok = await loadProducts({ lookbackDays, bufferDays, orderCycleDays });
    if (ok) {
      closeModal("settingsOverlay");
      toast("판단 기준을 적용했어요");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "적용";
  }
}

// ── 메일 양식 ───────────────────────────────────────

function langInfo(code) {
  return mailLanguages.find((l) => l.code === code) || mailLanguages[0];
}

// 언어 탭을 바꿀 때 고치던 내용은 저장 전이라도 잃지 않게 따로 들고 있는다
function showTemplateLang(lang) {
  templateDrafts[templateLang] = { subject: $("mtSubject").value, body: $("mtBody").value };
  templateLang = lang;
  const t = templateDrafts[lang] && templateDrafts[lang].body !== undefined && templateDrafts[lang].body !== "" ? templateDrafts[lang] : mailTemplates[lang];
  $("mtSubject").value = t?.subject || "";
  $("mtBody").value = t?.body || "";
  document.querySelectorAll("[data-template-lang]").forEach((b) => b.classList.toggle("active", b.dataset.templateLang === lang));
}

function openMailTemplate() {
  // 창을 새로 열면 저장하지 않은 내용은 버리고 저장된 양식을 보여준다
  for (const k of Object.keys(templateDrafts)) delete templateDrafts[k];
  $("mtSubject").value = "";
  $("mtBody").value = "";
  showTemplateLang(templateLang);
  delete templateDrafts[templateLang];
  openModal("mailOverlay");
}

async function saveTemplate() {
  const lang = templateLang;
  try {
    mailTemplates[lang] = await postJson("/api/mail-template", "POST", {
      lang,
      subject: $("mtSubject").value,
      body: $("mtBody").value,
    });
  } catch (err) {
    toast(err.message || "양식 저장에 실패했어요.", "error");
    return;
  }
  delete templateDrafts[lang];
  toast(`${langInfo(lang).label} 메일 양식을 저장했어요`);
}

// 자리표시자 버튼을 누르면 마지막으로 선택했던 입력칸의 커서 위치에 넣는다
let lastTemplateField = null;
function insertPlaceholder(key) {
  const field = lastTemplateField || $("mtBody");
  const text = `{{${key}}}`;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = field.value.slice(0, start) + text + field.value.slice(end);
  field.focus();
  field.setSelectionRange(start + text.length, start + text.length);
}

// ── 라벨 관리 ───────────────────────────────────────

const labelManagerState = newManagerState();

function labelAssignCfg() {
  return {
    prefix: "label",
    bodyId: "labelManagerBody",
    state: labelManagerState,
    field: "labelId",
    noun: "라벨",
    obj: "라벨을",
    subj: "라벨이",
    verb: "지정",
    options: currentLabels,
    chip: (p) => labelChip(p.label),
    assignUrl: "/api/labels/assign",
  };
}

// tab: "list" | "assign" (생략하면 라벨 없는 품목이 있을 때 품목 지정 탭부터)
function openLabelManager(tab) {
  const s = labelManagerState;
  s.selected.clear();
  s.search = "";
  s.listSearch = "";
  s.filter = "none";
  s.tab = tab || (currentLabels.length && getUnlabeledProducts().length ? "assign" : "list");
  resetPaneScroll("labelManagerBody");
  renderLabelManagerBody();
  openModal("labelOverlay");
}

function renderLabelManagerBody() {
  const s = labelManagerState;
  const unlabeled = getUnlabeledProducts();
  const countByLabel = new Map();
  for (const p of currentData?.products || []) if (p.labelId) countByLabel.set(p.labelId, (countByLabel.get(p.labelId) || 0) + 1);

  const listPane = `
    <div class="label-edit-row new">
      <span class="swatch" style="background:var(--line-strong);"></span>
      <input id="newLabelName" class="input" type="text" placeholder="새 라벨 이름 (예: 중국수입)" />
      <div class="input-suffix"><input id="newLabelLeadTime" class="input" type="number" min="0" placeholder="예: 20" /><span>일</span></div>
      <span></span>
      <div class="label-row-actions"><button class="btn-primary btn-sm" id="createLabelBtn">라벨 추가</button></div>
    </div>
    ${listSearchHtml(currentLabels.length, "라벨 검색", s.listSearch)}
    <div class="label-list">
      ${currentLabels.length ? currentLabels.map((l) => `
        <div class="label-edit-row" data-label-id="${escapeHtml(l.id)}" data-edit-id="${escapeHtml(l.id)}" data-search-text="${escapeHtml(l.name.toLowerCase())}" ${matchesListSearch(s, l.name) ? "" : "hidden"}>
          <span class="swatch" style="background:${l.color || "#888"};"></span>
          <input class="input label-edit-name" data-field="name" type="text" value="${escapeHtml(l.name)}" aria-label="라벨 이름" />
          <div class="input-suffix"><input class="input label-edit-leadtime" data-field="leadTimeDays" type="number" min="0" value="${l.leadTimeDays}" aria-label="리드타임" /><span>일</span></div>
          <span class="muted small nowrap">품목 ${countByLabel.get(l.id) || 0}개</span>
          <div class="label-row-actions">
            <button class="btn-primary btn-sm row-save-btn update-label-btn" style="visibility:hidden" disabled>변경 저장</button>
            <button class="btn-danger-ghost btn-sm delete-label-btn">삭제</button>
          </div>
        </div>`).join("") : `<div class="empty-note">아직 만든 라벨이 없어요. 위 칸에서 추가해주세요.</div>`}
    </div>`;

  const cfg = labelAssignCfg();
  const keepTop = paneScrollBefore("labelManagerBody", `${s.tab}|${s.filter}`);
  const unsaved = captureDirtyRows("labelManagerBody");
  $("labelManagerBody").innerHTML = `
    <h3>입고유형 라벨</h3>
    <p class="modal-desc">국내/수입처럼 입고까지 걸리는 기간이 다른 품목을 라벨로 나눠요. 라벨의 리드타임으로 발주 시점을 계산해요.</p>
    ${managerTabsHtml(s, "라벨 목록", currentLabels.length, "품목에 지정", unlabeled.length)}
    <div class="manager-pane" data-view="${s.tab}|${s.filter}">${s.tab === "list" ? listPane : assignPaneHtml(cfg)}</div>
  `;

  paneScrollAfter("labelManagerBody", keepTop);
  const rerender = () => renderLabelManagerBody();
  bindManagerTabs("labelManagerBody", s, rerender);
  if (s.tab === "assign") {
    bindAssignPane(cfg, rerender);
    return;
  }

  $("createLabelBtn").addEventListener("click", createLabelFromForm);
  for (const id of ["newLabelName", "newLabelLeadTime"]) {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") createLabelFromForm(); });
  }
  bindEditRows("labelManagerBody", (row) => {
    const name = row.querySelector(".label-edit-name").value.trim();
    const leadTimeDays = row.querySelector(".label-edit-leadtime").value;
    if (!name || leadTimeDays === "") {
      toast("라벨 이름과 리드타임을 모두 입력해주세요.", "error");
      return;
    }
    updateLabelRequest(row.dataset.labelId, name, leadTimeDays);
  });
  restoreDirtyRows("labelManagerBody", unsaved);
  document.querySelectorAll(".delete-label-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".label-edit-row");
      confirmClick(btn, "한 번 더 누르면 삭제", () => deleteLabelRequest(row.dataset.labelId));
    });
  });
}

async function createLabelFromForm() {
  const name = $("newLabelName").value.trim();
  const leadTimeDays = $("newLabelLeadTime").value;
  if (!name || leadTimeDays === "") {
    toast("라벨 이름과 리드타임을 모두 입력해주세요.", "error");
    return;
  }
  try {
    await postJson("/api/labels", "POST", { name, leadTimeDays });
  } catch (err) {
    toast(err.message || "라벨 추가에 실패했어요.", "error");
    return;
  }
  toast(`'${name}' 라벨을 추가했어요`);
  await refreshAfterLabelChange();
}

async function updateLabelRequest(labelId, name, leadTimeDays) {
  try {
    await postJson(`/api/labels/${labelId}`, "PUT", { name, leadTimeDays });
  } catch (err) {
    toast(err.message || "라벨 수정에 실패했어요.", "error");
    return;
  }
  document.querySelector(`[data-edit-id="${CSS.escape(labelId)}"]`)?.classList.remove("dirty");
  toast("라벨을 저장했어요");
  await refreshAfterLabelChange();
}

async function deleteLabelRequest(labelId) {
  try {
    await fetchJson(`/api/labels/${labelId}`, { method: "DELETE" });
  } catch (err) {
    toast(err.message || "라벨 삭제에 실패했어요.", "error");
    return;
  }
  toast("라벨을 삭제했어요");
  await refreshAfterLabelChange();
}

// ── 업데이트 내용 · 가이드 ──────────────────────────

let whatsNew = null;

async function loadWhatsNew() {
  whatsNew = await fetchJson("/api/whats-new");
  renderWhatsNewIndicators();
}

// 새 소식이 있으면 가이드 버튼을 강조하고 안내 띠를 보여준다
function renderWhatsNewIndicators() {
  const hasNew = !!whatsNew?.hasNew;
  $("openGuide").classList.toggle("has-new", hasNew);
  $("guideBtnText").textContent = hasNew ? "새 업데이트" : "가이드";
  $("whatsNewBanner").hidden = !hasNew;
  if (hasNew) $("whatsNewBannerTitle").textContent = whatsNew.entries[0].title;
}

function renderGuideUpdates() {
  const newIds = new Set(whatsNew?.newIds || []);
  $("guideUpdates").innerHTML = (whatsNew?.entries || [])
    .map((e) => `
      <article class="changelog-entry ${newIds.has(e.id) ? "is-new" : ""}">
        <div class="changelog-head">
          ${newIds.has(e.id) ? `<span class="new-badge">NEW</span>` : ""}
          <h4>${escapeHtml(e.title)}</h4>
          <span class="changelog-date">${escapeHtml(e.date)}</span>
        </div>
        <ul>${e.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
      </article>`)
    .join("") || `<div class="empty-note">업데이트 기록이 없어요</div>`;
}

function setGuideTab(tab) {
  document.querySelectorAll("[data-guide-tab]").forEach((t) => t.classList.toggle("active", t.dataset.guideTab === tab));
  $("guideUpdates").hidden = tab !== "updates";
  $("guideHowto").hidden = tab !== "howto";
  $("guideMove").hidden = tab !== "move";
  if (tab === "move") renderMovePane();
}

async function openGuide() {
  if (!whatsNew) await loadWhatsNew().catch(() => {});
  // 새 소식이 있으면 업데이트 내용부터, 없으면 사용 가이드부터 보여준다
  setGuideTab(whatsNew?.hasNew ? "updates" : "howto");
  renderGuideUpdates();
  openModal("guideOverlay");

  // 열어본 순간 "확인함"으로 저장 → 버튼/안내 띠는 원래대로 (팝업 안의 NEW 표시는 닫을 때까지 유지)
  if (whatsNew?.hasNew) {
    try {
      await postJson("/api/whats-new/seen", "POST", {});
      whatsNew = { ...whatsNew, hasNew: false };
      renderWhatsNewIndicators();
    } catch {
      // 저장에 실패하면 다음에 다시 강조될 뿐이라 조용히 넘어간다
    }
  }
}

// ── 백업 · 새 PC 설정 ───────────────────────────────
// 매일 백업(이 PC + 구글 드라이브). 새 PC 에서는 구글 드라이브의 '새PC-설치하기'로 설치한 뒤
// 처음 열 때 '새 PC 설정' 창이 떠서 백업을 가져오고, 네이버 API 키(백업에 없음)는 관리자에게 요청한다.

let setupState = null; // /api/setup 결과
let setupChecked = Promise.resolve(); // 처음 열 때 새 PC 설정 확인이 끝나면 풀림
let setupIp = null; // 이 PC 인터넷 주소 (관리자에게 보낼 메시지용)

async function loadSetupStatus() {
  setupState = await fetchJson("/api/setup");
  return setupState;
}

// 새로 설치한 PC: API 키가 없거나(샘플 모드 아님), 데이터가 없는데 구글 드라이브에 백업이 있을 때
function needsSetup(s) {
  return (!s.keysSet && !s.mockMode) || (!s.hasData && (s.driveBackups || []).length > 0);
}

async function checkSetup() {
  try {
    if (needsSetup(await loadSetupStatus())) openSetup();
  } catch {
    // 확인을 못 해도 평소 화면은 그대로 쓴다
  }
}

async function openSetup() {
  if (!setupState) await loadSetupStatus().catch(() => {});
  renderSetup();
  openModal("setupOverlay");
  if (!setupIp) {
    fetchJson("/api/setup/ip").then((r) => {
      setupIp = r.ip;
      if (!$("setupOverlay").hidden && $("setupAdminMsg")) $("setupAdminMsg").value = adminMessage(setupState || {});
    }).catch(() => {});
  }
}

function backupLabel(b) {
  return `${b.date.slice(5).replace("-", "/")} · ${b.pc || "PC"} · 업체 ${b.vendors}곳 · 품목 ${b.items}개 · 발주 기록 ${b.orders}건`;
}

function adminMessage(s) {
  const ip = setupIp || "(확인 중)";
  if (s.keysSet && s.naver && s.naver.ok === false) {
    return `재고 발주 도우미를 새 PC(${s.pc})로 옮겼는데 네이버 연결이 안 돼요.\n${s.naver.message}\n이 PC 인터넷 주소: ${ip}`;
  }
  return `재고 발주 도우미를 새 PC(${s.pc})에 설치했어요. 네이버 API 키를 넣어 주세요.\n이 PC 인터넷 주소: ${ip}`;
}

function renderSetup() {
  const s = setupState || {};
  const dataDone = !!s.hasData;
  const naverDone = !!s.mockMode || (!!s.keysSet && s.naver?.ok !== false);
  const backups = (s.driveBackups || []).slice(0, 5);
  const backupList = s.drive
    ? backups.length
      ? `<div class="setup-backups">${backups.map((b, i) => `
          <div class="setup-backup">
            <span>${escapeHtml(backupLabel(b))}${i === 0 ? ` <span class="new-badge">최신</span>` : ""}</span>
            <button class="${i === 0 && !dataDone ? "btn-primary" : "btn-outline"} btn-sm" data-restore-date="${escapeHtml(b.date)}">가져오기</button>
          </div>`).join("")}</div>`
      : `<p class="muted small">구글 드라이브에 백업이 아직 없어요. 예전 PC에서 프로그램을 한 번 켜면 백업돼요.</p>`
    : `<div class="warn-box"><span>구글 드라이브를 찾지 못했어요. 구글 드라이브 앱을 설치하고 예전 PC와 <b>같은 계정</b>으로 로그인한 뒤 <b>다시 찾기</b>를 누르세요.</span><button class="btn-outline btn-sm" id="setupRecheck">다시 찾기</button></div>`;
  $("setupBody").innerHTML = `
    <h3>새 PC 설정</h3>
    <p class="modal-desc">예전 PC의 데이터를 가져오고 네이버 연결을 확인해요. 두 가지가 모두 ✓가 되면 끝이에요.</p>
    <section class="setup-step ${dataDone ? "done" : ""}">
      <h4><span class="step-mark">${dataDone ? "✓" : "1"}</span>예전 PC 데이터 가져오기</h4>
      ${dataDone ? `<p class="muted small">데이터가 들어 있어요. 다른 백업으로 바꾸려면 아래에서 고르세요.</p>` : ""}
      ${backupList}
      <details class="setup-more">
        <summary>USB 등 파일로 가져오기</summary>
        <p class="muted small">백업 폴더(구글 드라이브 '아틀리에말리 백업' 또는 프로그램 폴더의 data\\backups) 안 날짜 폴더의 .json 파일을 <b>모두</b> 고르세요.</p>
        <input type="file" id="setupFiles" accept=".json,application/json" multiple />
      </details>
    </section>
    <section class="setup-step ${naverDone ? "done" : ""}">
      <h4><span class="step-mark">${naverDone ? "✓" : "2"}</span>네이버 연결 (관리자에게 요청)</h4>
      ${naverDone
        ? `<p class="muted small">${s.mockMode ? "샘플 데이터로 실행 중이에요." : "네이버와 연결돼 있어요."}</p>`
        : `<p class="muted small">네이버 API 키는 백업에 들어 있지 않아요. 아래 메시지를 복사해서 관리자에게 카톡으로 보내주세요.</p>
          <div class="setup-message">
            <textarea id="setupAdminMsg" class="input" rows="3" readonly>${escapeHtml(adminMessage(s))}</textarea>
            <button class="btn-primary btn-sm" id="setupCopyMsg">메시지 복사</button>
          </div>`}
      <details class="setup-more" ${!naverDone && s.keysSet ? "open" : ""}>
        <summary>관리자용: 네이버 API 키 넣기</summary>
        <div class="form-grid">
          <label class="field">client_id<input id="setupClientId" class="input" autocomplete="off" /></label>
          <label class="field">client_secret<input id="setupClientSecret" class="input" type="password" autocomplete="off" /></label>
        </div>
        <div class="setup-key-actions">
          <button class="btn-outline btn-sm" id="setupSaveKeys">저장하고 연결 확인</button>
          <span class="muted small" id="setupKeyState"></span>
        </div>
      </details>
    </section>
    <div class="modal-actions"><button class="btn-primary" id="setupDone">${dataDone && naverDone ? "시작하기" : "나중에 할게요"}</button></div>
  `;

  document.querySelectorAll("#setupBody [data-restore-date]").forEach((btn) => {
    const run = () => restoreBackup(btn, { source: "drive", date: btn.dataset.restoreDate });
    // 이미 데이터가 있으면 덮어쓰니까 한 번 더 확인
    btn.addEventListener("click", () => (dataDone ? confirmClick(btn, "한 번 더 누르면 바꾸기", run) : run()));
  });
  $("setupRecheck")?.addEventListener("click", async () => {
    await loadSetupStatus().catch(() => {});
    renderSetup();
  });
  $("setupFiles").addEventListener("change", async (e) => {
    const files = {};
    for (const file of e.target.files) files[file.name] = await file.text();
    if (Object.keys(files).length) restoreBackup(e.target, { files });
  });
  $("setupCopyMsg")?.addEventListener("click", async () => {
    const ok = await copyText($("setupAdminMsg").value);
    toast(ok ? "메시지를 복사했어요. 카톡에 붙여넣어 관리자에게 보내주세요" : "복사하지 못했어요. 글자를 직접 선택해서 복사해주세요", ok ? undefined : "error");
  });
  $("setupSaveKeys").addEventListener("click", saveSetupKeys);
  $("setupDone").addEventListener("click", () => {
    closeModal("setupOverlay");
    if (dataDone && naverDone) loadProducts({ fresh: 1 });
  });
}

async function restoreBackup(el, body) {
  el.disabled = true;
  try {
    const r = await postJson("/api/setup/restore", "POST", body);
    toast(`예전 PC 데이터를 가져왔어요 (${r.restored.length}개 파일)`);
  } catch (err) {
    toast(err.message || "가져오지 못했어요.", "error");
    el.disabled = false;
    return;
  }
  await loadSetupStatus().catch(() => {});
  renderSetup();
  loadProducts();
}

async function saveSetupKeys() {
  const btn = $("setupSaveKeys");
  btn.disabled = true;
  $("setupKeyState").textContent = "연결 확인 중…";
  let r;
  try {
    r = await postJson("/api/setup/naver-keys", "POST", { clientId: $("setupClientId").value, clientSecret: $("setupClientSecret").value });
  } catch (err) {
    $("setupKeyState").textContent = err.message || "저장하지 못했어요.";
    btn.disabled = false;
    return;
  }
  if (r.ip) setupIp = r.ip;
  await loadSetupStatus().catch(() => {});
  if (r.ok) {
    toast("네이버와 연결됐어요");
    renderSetup();
    loadProducts({ fresh: 1 });
  } else {
    // 키는 저장됐지만 연결 실패 (주로 허용 IP) → 메시지에 이유 · 주소가 들어가게
    setupState = { ...setupState, naver: { ok: false, message: r.message } };
    renderSetup();
    $("setupKeyState").textContent = `키는 저장했어요. 하지만 연결이 안 돼요: ${r.message}`;
  }
}

// 가이드 창 '백업 · PC 옮기기' 탭
async function renderMovePane() {
  const box = $("guideMove");
  box.innerHTML = `<div class="empty-note">확인하는 중…</div>`;
  let s;
  try {
    s = await loadSetupStatus();
  } catch (err) {
    box.innerHTML = `<div class="empty-note error-note"><strong>백업 상태를 불러오지 못했어요</strong>${escapeHtml(err.message || "")}</div>`;
    return;
  }
  const last = s.driveBackups[0] || null;
  box.innerHTML = `
    <section class="guide-section">
      <h4>자동 백업</h4>
      ${s.drive
        ? `<div class="info-box"><span>✓ 매일 <b>구글 드라이브</b>에도 백업하고 있어요 · 마지막 ${last ? escapeHtml(last.date) : "아직 없음"}<br><span class="muted small">${escapeHtml(s.driveFolder)}</span></span></div>`
        : `<div class="warn-box"><span>이 PC에서 구글 드라이브를 찾지 못해서 <b>이 PC 안에만</b> 백업하고 있어요. PC가 고장 나면 데이터가 사라질 수 있어요. 구글 드라이브 앱을 설치하고 로그인하면 구글 드라이브에도 자동으로 백업돼요.</span></div>`}
      <p class="muted small">업체 · 라벨 · 품목 연결 · 발주 기록 · 메일 양식 · 판단 기준을 하루에 한 번 백업해요. 네이버 API 키는 백업하지 않아요.</p>
      <button class="btn-outline btn-sm" id="backupNow">지금 백업하기</button>
    </section>
    <section class="guide-section">
      <h4>새 PC로 옮기는 방법</h4>
      <ol>
        <li>새 PC에 <b>구글 드라이브</b> 앱을 설치하고 이 PC와 <b>같은 계정</b>으로 로그인해요.</li>
        <li>구글 드라이브의 <b>'아틀리에말리 백업'</b> 폴더에서 <b>'새PC-설치하기'</b>를 더블클릭해요. 파란 경고 창이 뜨면 <b>추가 정보 → 실행</b>. 설치가 끝나면 프로그램이 저절로 열려요.</li>
        <li>열린 <b>'새 PC 설정'</b> 창에서 가장 최근 백업의 <b>가져오기</b>를 눌러요.</li>
        <li>같은 창에서 <b>메시지 복사</b>를 눌러 관리자에게 카톡으로 보내요. 관리자가 네이버 연결을 마무리해 줘요.</li>
        <li>새 PC에서 잘 되면 이 PC는 더 쓰지 않아요. 두 PC에서 같이 쓰면 발주 기록이 따로 쌓여요.</li>
      </ol>
      <p class="muted small">구글 드라이브를 쓸 수 없으면: <a href="/api/setup/installer" download>설치 파일 받기</a>와 이 PC의 백업 폴더(${escapeHtml(s.localFolder || "")})를 USB로 옮긴 뒤, 새 PC 설정 창의 '파일로 가져오기'를 쓰세요.</p>
      <button class="btn-ghost btn-sm" id="openSetupFromGuide">새 PC 설정 창 열기</button>
    </section>`;
  $("backupNow").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const r = await postJson("/api/backup/now", "POST", {});
      toast(r.drive ? "구글 드라이브와 이 PC에 백업했어요" : r.drive === false ? "이 PC에는 백업했는데 구글 드라이브 백업은 실패했어요" : "이 PC에 백업했어요");
    } catch (err) {
      toast(err.message || "백업하지 못했어요.", "error");
    }
    renderMovePane();
  });
  $("openSetupFromGuide").addEventListener("click", () => {
    closeModal("guideOverlay");
    openSetup();
  });
}

// ── 이벤트 연결 ─────────────────────────────────────

$("openGuide").addEventListener("click", openGuide);
$("whatsNewBannerBtn").addEventListener("click", openGuide);
document.querySelectorAll("[data-guide-tab]").forEach((t) => {
  t.addEventListener("click", () => setGuideTab(t.dataset.guideTab));
});

$("openLabelManager").addEventListener("click", () => openLabelManager());
$("openVendorManager").addEventListener("click", () => openVendorManager());
$("openOrderBtn").addEventListener("click", () => openOrder());
$("openOrdersBtn").addEventListener("click", () => openOrders());
$("openMailTemplate").addEventListener("click", openMailTemplate);
$("mtLangTabs").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-template-lang]");
  if (btn) showTemplateLang(btn.dataset.templateLang);
});
$("openSettings").addEventListener("click", openSettings);
$("applySettings").addEventListener("click", applySettings);
$("saveTemplate").addEventListener("click", saveTemplate);
$("refreshBtn").addEventListener("click", () => loadProducts({ fresh: 1 }));

$("placeholderHint").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-key]");
  if (btn) insertPlaceholder(btn.dataset.key);
});
for (const id of ["mtSubject", "mtBody"]) {
  $(id).addEventListener("focus", () => (lastTemplateField = $(id)));
}

document.querySelectorAll("[data-tab]").forEach((el) => {
  el.addEventListener("click", () => setTab(el.dataset.tab));
});
$("searchInput").addEventListener("input", renderList);
$("labelFilter").addEventListener("change", renderList);
$("productList").addEventListener("click", (e) => {
  if (e.target.closest(".pick")) return; // 체크 칸은 아래 change 에서 처리 (상세를 열지 않음)
  const row = e.target.closest(".product-row, .product-card");
  if (row) openDetail(row.dataset.id);
});
$("productList").addEventListener("change", (e) => {
  if (!e.target.classList.contains("pick-check")) return;
  setPicked(e.target.closest("[data-id]").dataset.id, e.target.checked);
});
$("productList").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target.closest(".pick")) return;
  const row = e.target.closest(".product-row, .product-card");
  if (row) openDetail(row.dataset.id);
});
$("pickAll").addEventListener("change", (e) => {
  for (const id of visibleIds) if (e.target.checked) picked.add(id); else picked.delete(id);
  renderList();
});
$("pickClear").addEventListener("click", () => { picked.clear(); renderList(); });
$("pickRecord").addEventListener("click", () => openQuickRecord([...picked]));
document.querySelectorAll(".view-btn").forEach((b) => {
  b.addEventListener("click", () => setListView(b.dataset.view));
});

// 닫기 버튼 / 바깥 영역 클릭 / Esc 키로 팝업 닫기
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});
document.querySelectorAll(".overlay").forEach((overlay) => {
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = [...document.querySelectorAll(".overlay")].filter((o) => !o.hidden);
  if (open.length) closeModal(open[open.length - 1].id);
});

// 목록 위쪽(탭·검색)이 상단 바 바로 아래에 붙도록 상단 바 높이를 CSS 에 알려준다
function syncTopbarHeight() {
  const bar = document.querySelector(".topbar");
  if (bar) document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`);
}
syncTopbarHeight();
window.addEventListener("resize", syncTopbarHeight);

setupChecked = checkSetup();
loadProducts();
loadWhatsNew().catch((err) => console.error("업데이트 기록을 불러오지 못했어요:", err));
loadListView();
loadMailTemplate().catch((err) => console.error("메일 양식을 불러오지 못했어요:", err));
