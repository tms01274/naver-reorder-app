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
function closeModal(id) { $(id).hidden = true; }

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
  if (p.daysLeft <= p.leadTimeDays + p.bufferDays) return { level: "warn", text: `${formatDays(p.daysLeft)} 남음` };
  return { level: "ok", text: `${formatDays(p.daysLeft)} 남음` };
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

// "발주함 50개 · 10/5 예정" (예정일이 지나면 "입고 지연")
function pendingChip(po) {
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

function renderLoadError(message) {
  $("productList").innerHTML = `<div class="empty-note error-note"><strong>품목을 불러오지 못했어요</strong>${escapeHtml(message)}</div>`;
  for (const id of ["statReorder", "statSoon", "statAll", "statUnlabeled"]) $(id).textContent = "–";
  $("criteriaText").textContent = "네이버 데이터를 불러오지 못했어요. 잠시 후 새로고침을 눌러주세요.";
}

function render() {
  const data = currentData;
  if (!data) return;
  $("mockBadge").hidden = !data.mockMode;
  renderLabelFilterOptions();

  const products = data.products;
  const reorder = products.filter((p) => p.needsReorder);
  const soon = products.filter(isSoon);
  const unlabeledCount = getUnlabeledProducts().length;

  $("statReorder").textContent = reorder.length;
  $("statSoon").textContent = soon.length;
  $("statAll").textContent = products.length;
  $("statUnlabeled").textContent = unlabeledCount;

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
    `최근 ${data.settings.lookbackDays}일 판매 기준 · 안전 여유 ${data.settings.bufferDays}일 · ` +
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} 기준`;

  renderList();

  if (!hasAutoOpenedLabelPopup) {
    hasAutoOpenedLabelPopup = true;
    if (unlabeledCount) openLabelManager();
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
    pending: "<strong>입고를 기다리는 품목이 없어요</strong>발주서를 보낸 뒤 '발주 완료로 기록'을 누르면 여기에 나와요.",
    all: "<strong>조건에 맞는 품목이 없어요</strong>",
  }[activeTab];
  $("productList").innerHTML = list.length
    ? list.map(rowHtml).join("")
    : `<div class="empty-note">${query || labelFilter !== "all" ? "<strong>조건에 맞는 품목이 없어요</strong>검색어나 라벨 필터를 확인해주세요." : emptyText}</div>`;
}

function rowHtml(p) {
  const s = statusOf(p);
  const qty = p.recommendedOrderQty;
  return `
    <button class="product-row" data-id="${escapeHtml(p.id)}">
      <div>
        <div class="product-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
        <div class="product-sub">${labelChip(p.label)}${pendingChip(p.pendingOrder)}${p.vendor ? `<span class="vendor-chip">${escapeHtml(p.vendor.name)}</span>` : ""}</div>
      </div>
      <div class="num"><span class="cell-label">재고</span>${p.stockQuantity}개</div>
      <div class="num"><span class="cell-label">일평균 판매</span>${p.dailyVelocity}개</div>
      <div class="status-cell"><span class="status ${s.level}">${s.text}</span></div>
      <div class="num"><span class="cell-label">권장 발주</span>${qty > 0 ? `<span class="qty-strong">${qty}개</span>` : `<span class="qty-zero">–</span>`}</div>
    </button>
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
      <h3>${escapeHtml(p.name)}</h3>
      <div class="detail-meta">
        <span class="status ${s.level}">${s.text}</span>
        ${labelChip(p.label)}
        ${pendingChip(p.pendingOrder)}
        <span>품목 ID ${escapeHtml(p.id)}</span>
      </div>
    </div>

    <div class="detail-stats">
      <div class="stat-box"><div class="label">현재 재고</div><div class="value">${p.stockQuantity}개</div></div>
      <div class="stat-box"><div class="label">일평균 판매</div><div class="value">${p.dailyVelocity}개</div></div>
      <div class="stat-box"><div class="label">리드타임</div><div class="value">${p.leadTimeDays}일</div></div>
      <div class="stat-box highlight"><div class="label">권장 발주</div><div class="value">${p.recommendedOrderQty}개</div></div>
    </div>

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
    </div>

    <div class="detail-footer">
      <button class="btn-outline" id="saveSupplier">저장</button>
      <button class="btn-primary" id="orderFromDetail">이 업체에 발주서 만들기</button>
    </div>
  `;

  $("saveSupplier").addEventListener("click", () => saveSupplier(p.id));
  $("detailOpenVendors").addEventListener("click", () => { closeModal("detailOverlay"); openVendorManager("list"); });
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
  };
  try {
    await postJson(`/api/suppliers/${productId}`, "POST", payload);
  } catch (err) {
    toast(err.message || "저장에 실패했어요.", "error");
    return;
  }
  await loadProducts();
  openDetail(productId);
  toast("저장했어요");
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
// 업체를 고르면 그 업체 품목이 나오고(발주 필요 품목은 미리 체크), 수량을 고쳐서
// 메일 한 통 분량의 받는 사람 · 제목 · 본문을 만든다. 웹메일에 붙여넣기 쉽게 각각 복사 버튼을 둔다.

const order = {
  vendorId: "",
  items: new Map(), // productId -> { checked, qty }
  extraIds: [], // 업체에 연결되지 않았지만 직접 추가한 품목
  step: "items",
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
  order.step = "items";
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
  if (order.step === "mail") return renderOrderMail();
  const vendor = vendorById(order.vendorId);
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

  let itemsHtml = "";
  if (vendor) {
    const ids = orderRowIds();
    for (const id of ids) ensureOrderItem(id, false);
    itemsHtml = `
      ${vendor.email ? "" : `<div class="warn-box">이 업체의 이메일이 없어요. 받는 사람은 비워진 채로 만들어져요. <button type="button" class="btn-ghost btn-sm" data-open-vendors>업체 관리에서 입력</button></div>`}
      <div class="order-table">
        <div class="order-head"><span></span><span>품목</span><span class="num">재고</span><span>남은 기간</span><span class="num">발주 수량</span></div>
        ${ids.length ? ids.map((id) => orderRowHtml(productById(id), order.items.get(id))).join("") : `<div class="empty-note">이 업체에 연결된 품목이 없어요. 아래에서 품목을 추가하거나, 업체 관리에서 품목을 연결해주세요.</div>`}
      </div>
      <div class="order-add">
        <input id="orderAddSearch" class="input" type="search" placeholder="다른 품목 추가 (이름 검색)" value="${escapeHtml(order.addSearch)}" autocomplete="off" />
        <div id="orderAddResults" class="order-add-results"></div>
      </div>`;
  }

  $("orderBody").innerHTML = `
    <h3>발주서 만들기</h3>
    <p class="modal-desc">업체를 고르면 그 업체 품목이 나와요. 발주가 필요한 품목은 미리 체크돼 있고, 수량은 고칠 수 있어요.</p>
    <h4>1. 업체 선택</h4>
    ${vendorPicker}
    ${vendor ? `<h4>2. 보낼 품목과 수량</h4>${itemsHtml}` : ""}
    <div class="order-footer">
      <span id="orderSummary" class="order-summary"></span>
      <button class="btn-primary" id="orderToMail" ${vendor ? "" : "disabled"}>메일 내용 만들기</button>
    </div>
  `;
  updateOrderSummary();
  renderOrderAddResults();
  bindOrderEvents();
}

function orderRowHtml(p, item) {
  const s = statusOf(p);
  return `
    <div class="order-row ${item.checked ? "checked" : ""}" data-order-id="${escapeHtml(p.id)}">
      <input type="checkbox" class="order-check" ${item.checked ? "checked" : ""} />
      <span class="order-name">
        <span class="name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        ${p.supplier?.vendorItemName ? `<span class="vendor-item-name">업체용 품명: ${escapeHtml(p.supplier.vendorItemName)}</span>` : ""}
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
    ? matches.map((p) => `<button type="button" class="order-add-item" data-add-id="${escapeHtml(p.id)}"><span class="name">${escapeHtml(p.name)}</span><span class="muted">${p.vendor ? escapeHtml(p.vendor.name) : "업체 미지정"}</span></button>`).join("")
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
  }
  $("orderAddResults")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-add-id]");
    if (!btn) return;
    order.extraIds.push(btn.dataset.addId);
    ensureOrderItem(btn.dataset.addId, true);
    order.items.get(btn.dataset.addId).checked = true;
    order.addSearch = "";
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
async function recordCurrentOrder() {
  const btn = $("orderRecord");
  const lines = selectedOrderLines();
  if (!lines.length || order.recorded) return;
  btn.disabled = true;
  try {
    await postJson("/api/orders", "POST", {
      vendorId: order.vendorId,
      items: lines.map(({ p, item }) => ({
        productId: p.id,
        name: p.name,
        vendorItemName: p.supplier?.vendorItemName || "",
        qty: item.qty,
        leadTimeDays: p.leadTimeDays,
      })),
    });
  } catch (err) {
    btn.disabled = false;
    toast(err.message || "기록하지 못했어요.", "error");
    return;
  }
  order.recorded = true;
  toast(`${lines.length}개 품목의 발주를 기록했어요`);
  // 메일 화면에서 고친 내용이 지워지지 않게, 발주서 창은 다시 그리지 않고 기록 영역만 바꾼다
  const bar = btn.closest(".record-bar");
  bar.classList.add("done");
  bar.querySelector("strong").textContent = "발주를 기록했어요";
  bar.querySelector(".record-text span").textContent = "이 품목들은 '입고 대기'로 표시돼요. 입고되면 '발주 기록'에서 입고 완료를 눌러주세요.";
  btn.textContent = "기록됨 ✓";
  await loadProducts();
}

function renderOrderMail() {
  const mail = buildOrderMail();
  const vendor = vendorById(order.vendorId);
  $("orderBody").innerHTML = `
    <h3>발주 메일 — ${escapeHtml(vendor?.name || "")} <span class="lang-badge">${escapeHtml(mail.lang.label)}</span></h3>
    <ol class="mail-steps">
      <li><b>네이버 메일 열기</b>를 눌러 메일 쓰기 화면을 열어요.</li>
      <li>아래 <b>받는 사람 · 제목 · 본문</b>을 차례로 <b>복사</b>해서 붙여넣어요.</li>
      <li>내용을 확인하고 네이버 메일에서 <b>보내기</b>를 눌러요.</li>
      <li>보냈으면 맨 아래 <b>발주 완료로 기록</b>을 눌러요.</li>
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
    <div class="order-footer">
      <button class="btn-ghost" id="orderBack">← 품목 다시 고르기</button>
      <span class="spacer"></span>
      <button class="btn-ghost btn-sm" id="orderMailto">PC 메일 프로그램으로 열기</button>
      <a class="btn-primary" id="orderOpenNaver" href="https://mail.naver.com/" target="_blank" rel="noopener">네이버 메일 열기</a>
    </div>
    <div class="record-bar ${order.recorded ? "done" : ""}">
      <div class="record-text">
        <strong>${order.recorded ? "발주를 기록했어요" : "메일을 보냈으면 기록해 두세요"}</strong>
        <span>${order.recorded ? "이 품목들은 '입고 대기'로 표시돼요. 입고되면 '발주 기록'에서 입고 완료를 눌러주세요." : "기록하면 '입고 대기'로 표시되고, 같은 품목을 또 발주하지 않게 알려줘요."}</span>
      </div>
      <button class="btn-primary" id="orderRecord" ${order.recorded ? "disabled" : ""}>${order.recorded ? "기록됨 ✓" : "발주 완료로 기록"}</button>
    </div>
  `;
  $("orderRecord").addEventListener("click", recordCurrentOrder);
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await copyText($(btn.dataset.copy).value);
      if (!ok) { toast("복사하지 못했어요. 직접 선택해서 복사해주세요.", "error"); return; }
      btn.textContent = "복사됨 ✓";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "복사"; btn.classList.remove("copied"); }, 1800);
    });
  });
  $("orderBack").addEventListener("click", () => { order.step = "items"; renderOrder(); });
  $("orderMailto").addEventListener("click", () => {
    window.location.href = `mailto:${encodeURIComponent($("orderTo").value.trim())}?subject=${encodeURIComponent($("orderSubject").value)}&body=${encodeURIComponent($("orderMailBody").value)}`;
  });
}

// ── 라벨 · 업체 관리 공통: "품목 지정" 탭 ────────────
// 라벨 관리와 업체 관리는 똑같이 [목록 관리] [품목 지정] 두 탭으로 나뉜다.
// 품목 지정 탭: 지정 안 된 품목만 / 전체 품목을 보고, 골라서 한 번에 지정 · 변경 · 해제한다.

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
            <span class="name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
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
  document.querySelectorAll(`#${cfg.bodyId} .assign-row`).forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.productId;
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      rerender();
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
function langSelectHtml(className, selected, id) {
  return `<select class="${className}" ${id ? `id="${id}"` : ""} aria-label="발주서 언어" title="발주서 언어">
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
      <span></span>
      <div class="label-row-actions"><button class="btn-primary btn-sm" id="createVendorBtn">업체 추가</button></div>
    </div>
    ${listSearchHtml(currentVendors.length, "업체 검색", s.listSearch)}
    <div class="label-list">
      ${currentVendors.length ? currentVendors.map((v) => `
        <div class="vendor-edit-row" data-vendor-id="${escapeHtml(v.id)}" data-search-text="${escapeHtml(`${v.name} ${v.email || ""}`.toLowerCase())}" ${matchesListSearch(s, `${v.name} ${v.email || ""}`) ? "" : "hidden"}>
          <input class="input vendor-edit-name" type="text" value="${escapeHtml(v.name)}" aria-label="업체 이름" />
          <input class="input vendor-edit-email" type="email" value="${escapeHtml(v.email || "")}" placeholder="이메일" aria-label="이메일" />
          ${langSelectHtml("input vendor-edit-lang", v.lang || "ko")}
          <span class="muted small nowrap">품목 ${countByVendor.get(v.id) || 0}개</span>
          <div class="label-row-actions">
            <button class="btn-outline btn-sm update-vendor-btn">저장</button>
            <button class="btn-danger-ghost btn-sm delete-vendor-btn">삭제</button>
          </div>
        </div>`).join("") : `<div class="empty-note">아직 등록된 업체가 없어요. 위 칸에서 추가해주세요.</div>`}
    </div>`;

  const cfg = vendorAssignCfg();
  $("vendorManagerBody").innerHTML = `
    <h3>거래 업체</h3>
    <p class="modal-desc">발주를 보내는 업체와 이메일을 등록하고, 품목을 업체에 연결해요. 발주서를 만들 때 업체를 고르면 연결된 품목이 나와요.</p>
    ${managerTabsHtml(s, "업체 목록", currentVendors.length, "품목 연결", unassigned.length)}
    <div class="manager-pane">${s.tab === "list" ? listPane : assignPaneHtml(cfg)}</div>
  `;

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
  document.querySelectorAll(".update-vendor-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".vendor-edit-row");
      const name = row.querySelector(".vendor-edit-name").value.trim();
      const email = row.querySelector(".vendor-edit-email").value.trim();
      const lang = row.querySelector(".vendor-edit-lang").value;
      try {
        await postJson(`/api/vendors/${row.dataset.vendorId}`, "PUT", { name, email, lang });
      } catch (err) {
        toast(err.message || "업체 저장에 실패했어요.", "error");
        return;
      }
      toast("업체를 저장했어요");
      await refreshAfterLabelChange();
    });
  });
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

async function createVendorFromForm() {
  const name = $("newVendorName").value.trim();
  const email = $("newVendorEmail").value.trim();
  const lang = $("newVendorLang").value;
  if (!name) {
    toast("업체 이름을 입력해주세요.", "error");
    return;
  }
  try {
    await postJson("/api/vendors", "POST", { name, email, lang });
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
          <strong>${escapeHtml(vendorById(o.vendorId)?.name || o.vendorName)}</strong>
          <span class="muted small">${shortDate(o.createdAt)} 발주 · ${daysAgoText(o.createdAt)} · ${o.items.length}개 품목</span>
          <span class="status ${done ? "ok" : received ? "warn" : "none"}">${done ? "입고 완료" : `입고 ${received}/${o.items.length}`}</span>
          <span class="spacer"></span>
          ${done ? "" : `<button class="btn-outline btn-sm" data-receive-all>모두 입고 완료</button>`}
          <button class="btn-danger-ghost btn-sm" data-cancel-order>발주 취소</button>
        </div>
        <div class="order-card-items">
          ${o.items.map((i) => {
            const late = !i.receivedAt && isLate(i.expectedAt);
            return `
            <div class="order-item" data-product-id="${escapeHtml(i.productId)}">
              <span class="name">${escapeHtml(i.name)}${i.vendorItemName ? `<small>업체용: ${escapeHtml(i.vendorItemName)}</small>` : ""}</span>
              <span class="num">${i.qty}개</span>
              <span class="order-item-state ${i.receivedAt ? "received" : late ? "late" : ""}">${i.receivedAt ? `입고 ${shortDate(i.receivedAt)}` : late ? `입고 지연 (${shortDate(i.expectedAt)} 예정)` : `${shortDate(i.expectedAt)} 입고 예정`}</span>
              ${i.receivedAt ? `<button class="btn-ghost btn-sm" data-unreceive>되돌리기</button>` : `<button class="btn-outline btn-sm" data-receive>입고</button>`}
            </div>`;
          }).join("")}
        </div>
      </div>`;
  }).join("");

  $("ordersBody").innerHTML = `
    <h3>발주 기록</h3>
    <p class="modal-desc">발주서에서 '발주 완료로 기록'한 내용이에요. 물건이 들어오면 <b>입고</b>를 눌러주세요. 입고 전까지는 발주한 수량을 들어올 재고로 계산해서, 같은 품목이 다시 '발주 필요'로 뜨지 않아요.</p>
    <div class="orders-toolbar">
      <div class="tabs manager-tabs" role="tablist">
        <button type="button" class="tab ${s.tab === "pending" ? "active" : ""}" data-orders-tab="pending">입고 대기 ${open.length ? `<span class="dot-badge">${open.length}</span>` : ""}</button>
        <button type="button" class="tab ${s.tab === "all" ? "active" : ""}" data-orders-tab="all">전체 기록 <span class="tab-count">${all.length}</span></button>
      </div>
      ${vendorIds.length > 1 ? `
        <select id="ordersVendorFilter" class="input" aria-label="업체">
          <option value="all">모든 업체</option>
          ${vendorIds.map((id) => `<option value="${escapeHtml(id)}" ${s.vendor === id ? "selected" : ""}>${escapeHtml(vendorById(id)?.name || all.find((o) => o.vendorId === id).vendorName)}</option>`).join("")}
        </select>` : ""}
    </div>
    <div class="manager-pane">
      ${list.length ? cards : `<div class="empty-note">${s.tab === "pending" ? "<strong>입고를 기다리는 발주가 없어요</strong>발주서를 보낸 뒤 '발주 완료로 기록'을 누르면 여기에 나와요." : "<strong>발주 기록이 없어요</strong>"}</div>`}
    </div>
  `;

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
    });
  });
}

// ── 판단 기준 ───────────────────────────────────────

function openSettings() {
  if (currentData) {
    $("lookbackDays").value = currentData.settings.lookbackDays;
    $("bufferDays").value = currentData.settings.bufferDays;
  }
  openModal("settingsOverlay");
}

async function applySettings() {
  const lookbackDays = $("lookbackDays").value;
  const bufferDays = $("bufferDays").value;
  if (!(Number(lookbackDays) >= 1) || bufferDays === "" || Number(bufferDays) < 0) {
    toast("판매 속도 계산 기간은 1일 이상, 안전 여유일수는 0일 이상으로 입력해주세요.", "error");
    return;
  }
  const btn = $("applySettings");
  btn.disabled = true;
  btn.textContent = "적용 중…";
  try {
    const ok = await loadProducts({ lookbackDays, bufferDays });
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
        <div class="label-edit-row" data-label-id="${escapeHtml(l.id)}" data-search-text="${escapeHtml(l.name.toLowerCase())}" ${matchesListSearch(s, l.name) ? "" : "hidden"}>
          <span class="swatch" style="background:${l.color || "#888"};"></span>
          <input class="input label-edit-name" type="text" value="${escapeHtml(l.name)}" aria-label="라벨 이름" />
          <div class="input-suffix"><input class="input label-edit-leadtime" type="number" min="0" value="${l.leadTimeDays}" aria-label="리드타임" /><span>일</span></div>
          <span class="muted small nowrap">품목 ${countByLabel.get(l.id) || 0}개</span>
          <div class="label-row-actions">
            <button class="btn-outline btn-sm update-label-btn">저장</button>
            <button class="btn-danger-ghost btn-sm delete-label-btn">삭제</button>
          </div>
        </div>`).join("") : `<div class="empty-note">아직 만든 라벨이 없어요. 위 칸에서 추가해주세요.</div>`}
    </div>`;

  const cfg = labelAssignCfg();
  $("labelManagerBody").innerHTML = `
    <h3>입고유형 라벨</h3>
    <p class="modal-desc">국내/수입처럼 입고까지 걸리는 기간이 다른 품목을 라벨로 나눠요. 라벨의 리드타임으로 발주 시점을 계산해요.</p>
    ${managerTabsHtml(s, "라벨 목록", currentLabels.length, "품목에 지정", unlabeled.length)}
    <div class="manager-pane">${s.tab === "list" ? listPane : assignPaneHtml(cfg)}</div>
  `;

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
  document.querySelectorAll(".update-label-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".label-edit-row");
      const name = row.querySelector(".label-edit-name").value.trim();
      const leadTimeDays = row.querySelector(".label-edit-leadtime").value;
      if (!name || leadTimeDays === "") {
        toast("라벨 이름과 리드타임을 모두 입력해주세요.", "error");
        return;
      }
      updateLabelRequest(row.dataset.labelId, name, leadTimeDays);
    });
  });
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
$("statUnlabeledCard").addEventListener("click", () => openLabelManager("assign"));
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
  const row = e.target.closest(".product-row");
  if (row) openDetail(row.dataset.id);
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

loadProducts();
loadWhatsNew().catch((err) => console.error("업데이트 기록을 불러오지 못했어요:", err));
loadMailTemplate().catch((err) => console.error("메일 양식을 불러오지 못했어요:", err));
