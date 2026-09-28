let currentData = null;
let currentTemplate = null;
let currentLabels = [];
let hasAutoOpenedLabelPopup = false;
let activeTab = "reorder";

// 라벨 관리 팝업에서 체크한 품목 / 검색어 (다시 그려도 유지)
const labelManagerState = { selected: new Set(), search: "" };

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

function isSoon(p) {
  return statusOf(p).level === "warn";
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
    render();
    return true;
  } catch (err) {
    // 품목을 못 불러와도 라벨 관리 등 나머지 기능은 쓸 수 있게 라벨만 따로 불러온다
    renderLoadError(err.message);
    await loadLabels().catch(() => {});
    return false;
  } finally {
    setListLoading(false);
  }
}

async function loadLabels() {
  currentLabels = await fetchJson("/api/labels");
  renderLabelFilterOptions();
}

async function loadMailTemplate() {
  const data = await fetchJson("/api/mail-template");
  currentTemplate = data.template;
  $("mtSubject").value = data.template.subject;
  $("mtBody").value = data.template.body;
  $("placeholderHint").innerHTML = data.placeholders
    .map((p) => `<button type="button" data-key="${escapeHtml(p.key)}" title="${escapeHtml(p.desc)}"><code>{{${escapeHtml(p.key)}}}</code> ${escapeHtml(p.desc)}</button>`)
    .join("");
}

// 라벨 추가/수정/삭제/지정 후 화면 전체를 새로 그린다
async function refreshAfterLabelChange() {
  await loadProducts();
  if (!$("labelOverlay").hidden) renderLabelManagerBody();
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
    all: base,
  };
  $("tabCountReorder").textContent = byTab.reorder.length;
  $("tabCountSoon").textContent = byTab.soon.length;
  $("tabCountAll").textContent = byTab.all.length;

  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === activeTab));

  const list = sortByUrgency(byTab[activeTab]);
  const emptyText = {
    reorder: "<strong>지금 발주가 필요한 품목이 없어요</strong>재고가 넉넉해요.",
    soon: "<strong>곧 발주가 필요한 품목이 없어요</strong>",
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
        <div class="product-sub">${labelChip(p.label)}</div>
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
        <span>품목 ID ${escapeHtml(p.id)}</span>
      </div>
    </div>

    <div class="detail-stats">
      <div class="stat-box"><div class="label">현재 재고</div><div class="value">${p.stockQuantity}개</div></div>
      <div class="stat-box"><div class="label">일평균 판매</div><div class="value">${p.dailyVelocity}개</div></div>
      <div class="stat-box"><div class="label">리드타임</div><div class="value">${p.leadTimeDays}일</div></div>
      <div class="stat-box highlight"><div class="label">권장 발주</div><div class="value">${p.recommendedOrderQty}개</div></div>
    </div>

    <h4>입고유형 · 공급업체</h4>
    <div class="form-grid">
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
      <label class="field">업체명
        <input id="supplierName" class="input" value="${escapeHtml(supplier.supplierName || "")}" placeholder="예: OO상사" />
      </label>
      <label class="field">이메일
        <input id="supplierEmail" class="input" type="email" value="${escapeHtml(supplier.supplierEmail || "")}" placeholder="order@supplier.com" />
      </label>
    </div>

    <div class="detail-footer">
      <button class="btn-outline" id="saveSupplier">저장</button>
      <button class="btn-primary" id="sendMailBtn">발주 메일 작성</button>
    </div>
  `;

  $("saveSupplier").addEventListener("click", () => saveSupplier(p.id));
  $("sendMailBtn").addEventListener("click", () => sendReorderMail(p));
  openModal("detailOverlay");
}

async function saveSupplier(productId) {
  const payload = {
    supplierName: $("supplierName").value.trim(),
    supplierEmail: $("supplierEmail").value.trim(),
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

function sendReorderMail(p) {
  const supplierEmail = $("supplierEmail").value.trim();
  if (!supplierEmail) {
    toast("공급업체 이메일을 먼저 입력해주세요.", "error");
    $("supplierEmail").focus();
    return;
  }

  const values = {
    품목명: p.name,
    수량: p.recommendedOrderQty,
    재고: p.stockQuantity,
    일평균판매: p.dailyVelocity,
    소진예상: p.daysLeft === null ? "알 수 없음" : `${p.daysLeft}일 후`,
    업체명: $("supplierName").value.trim() || "",
  };

  const template = currentTemplate || { subject: "[발주 요청] {{품목명}} {{수량}}개", body: "" };
  const subject = fillTemplate(template.subject, values);
  const body = fillTemplate(template.body, values);

  window.location.href = `mailto:${encodeURIComponent(supplierEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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

async function saveTemplate() {
  try {
    currentTemplate = await postJson("/api/mail-template", "POST", {
      subject: $("mtSubject").value,
      body: $("mtBody").value,
    });
  } catch (err) {
    toast(err.message || "양식 저장에 실패했어요.", "error");
    return;
  }
  closeModal("mailOverlay");
  toast("메일 양식을 저장했어요");
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

function openLabelManager() {
  labelManagerState.selected.clear();
  labelManagerState.search = "";
  renderLabelManagerBody();
  openModal("labelOverlay");
}

function renderLabelManagerBody() {
  const unlabeled = getUnlabeledProducts();
  const { selected } = labelManagerState;
  // 이미 라벨이 지정돼 목록에서 빠진 품목은 선택에서도 뺀다
  for (const id of [...selected]) if (!unlabeled.some((p) => p.id === id)) selected.delete(id);

  const query = labelManagerState.search.trim().toLowerCase();
  const visible = query ? unlabeled.filter((p) => p.name.toLowerCase().includes(query)) : unlabeled;
  const allVisibleChecked = visible.length > 0 && visible.every((p) => selected.has(p.id));

  const labelRows = currentLabels
    .map(
      (l) => `
      <div class="label-edit-row" data-label-id="${escapeHtml(l.id)}">
        <span class="swatch" style="background:${l.color || "#888"};"></span>
        <input class="input label-edit-name" type="text" value="${escapeHtml(l.name)}" aria-label="라벨 이름" />
        <div class="input-suffix"><input class="input label-edit-leadtime" type="number" min="0" value="${l.leadTimeDays}" aria-label="리드타임" /><span>일</span></div>
        <div class="label-row-actions">
          <button class="btn-outline btn-sm update-label-btn">저장</button>
          <button class="btn-danger-ghost btn-sm delete-label-btn">삭제</button>
        </div>
      </div>`
    )
    .join("");

  $("labelManagerBody").innerHTML = `
    <h3>입고유형 라벨</h3>
    <p class="modal-desc">국내/수입처럼 입고까지 걸리는 기간이 다른 품목을 라벨로 나눠요. 라벨의 리드타임으로 발주 시점을 계산해요.</p>

    <div class="label-list">
      ${labelRows}
      <div class="label-edit-row new">
        <span class="swatch" style="background:var(--line-strong);"></span>
        <input id="newLabelName" class="input" type="text" placeholder="새 라벨 이름 (예: 중국수입)" />
        <div class="input-suffix"><input id="newLabelLeadTime" class="input" type="number" min="0" placeholder="예: 20" /><span>일</span></div>
        <div class="label-row-actions">
          <button class="btn-primary btn-sm" id="createLabelBtn">라벨 추가</button>
        </div>
      </div>
    </div>

    <h4>라벨이 없는 품목 <span class="dot-badge" ${unlabeled.length ? "" : "hidden"}>${unlabeled.length}</span></h4>
    ${
      !unlabeled.length
        ? `<div class="hint-box">모든 품목에 라벨이 지정돼 있어요. 품목의 라벨을 바꾸려면 목록에서 품목을 눌러 상세 화면에서 바꿔주세요.</div>`
        : !currentLabels.length
          ? `<div class="hint-box">위에서 라벨을 먼저 만들면, 여기서 품목을 골라 한 번에 지정할 수 있어요.</div>`
          : `
      <div class="bulk-bar">
        <label class="check"><input type="checkbox" id="checkAllUnlabeled" ${allVisibleChecked ? "checked" : ""} /> 전체 선택</label>
        <input id="unlabeledSearch" class="input search" type="search" placeholder="품목 검색" value="${escapeHtml(labelManagerState.search)}" />
        <span class="spacer"></span>
        <select id="bulkLabelSelect" class="input">
          <option value="">라벨 선택</option>
          ${currentLabels.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join("")}
        </select>
        <button class="btn-primary btn-sm" id="bulkAssignBtn" ${selected.size ? "" : "disabled"}>선택한 ${selected.size}개에 지정</button>
      </div>
      <div class="unlabeled-list">
        ${
          visible.length
            ? visible
                .map(
                  (p) => `
          <div class="unlabeled-row ${selected.has(p.id) ? "checked" : ""}" data-product-id="${escapeHtml(p.id)}">
            <input type="checkbox" class="unlabeled-check" ${selected.has(p.id) ? "checked" : ""} aria-label="선택" />
            <span class="name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          </div>`
                )
                .join("")
            : `<div class="empty-note">검색 결과가 없어요</div>`
        }
      </div>`
    }
  `;

  bindLabelManagerEvents(visible);
}

function bindLabelManagerEvents(visible) {
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

  const search = $("unlabeledSearch");
  if (search) {
    search.addEventListener("input", () => {
      labelManagerState.search = search.value;
      renderLabelManagerBody();
      const again = $("unlabeledSearch");
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    });
  }

  const checkAll = $("checkAllUnlabeled");
  if (checkAll) {
    checkAll.addEventListener("change", () => {
      for (const p of visible) {
        if (checkAll.checked) labelManagerState.selected.add(p.id);
        else labelManagerState.selected.delete(p.id);
      }
      renderLabelManagerBody();
    });
  }

  document.querySelectorAll(".unlabeled-row").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.productId;
      const { selected } = labelManagerState;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      renderLabelManagerBody();
    });
  });

  const bulkBtn = $("bulkAssignBtn");
  if (bulkBtn) bulkBtn.addEventListener("click", bulkAssignLabel);
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

async function bulkAssignLabel() {
  const labelId = $("bulkLabelSelect").value;
  const productIds = [...labelManagerState.selected];
  if (!labelId) {
    toast("지정할 라벨을 선택해주세요.", "error");
    return;
  }
  if (!productIds.length) return;
  try {
    await postJson("/api/labels/assign", "POST", { productIds, labelId });
  } catch (err) {
    toast(err.message || "라벨 지정에 실패했어요.", "error");
    return;
  }
  labelManagerState.selected.clear();
  // 검색 결과를 다 지정하고 나면 빈 목록만 남으므로, 검색을 풀어 남은 품목을 보여준다
  labelManagerState.search = "";
  toast(`${productIds.length}개 품목에 라벨을 지정했어요`);
  await refreshAfterLabelChange();
}

// ── 이벤트 연결 ─────────────────────────────────────

$("openLabelManager").addEventListener("click", openLabelManager);
$("statUnlabeledCard").addEventListener("click", openLabelManager);
$("openMailTemplate").addEventListener("click", () => openModal("mailOverlay"));
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
loadMailTemplate().catch((err) => console.error("메일 양식을 불러오지 못했어요:", err));
