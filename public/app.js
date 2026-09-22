let currentData = null;
let currentTemplate = null;

async function loadMailTemplate() {
  const res = await fetch("/api/mail-template");
  const data = await res.json();
  currentTemplate = data.template;

  document.getElementById("mtSubject").value = data.template.subject;
  document.getElementById("mtBody").value = data.template.body;

  document.getElementById("placeholderHint").innerHTML =
    "넣을 수 있는 자리표시자: " +
    data.placeholders.map((p) => `<code>{{${p.key}}}</code> (${p.desc})`).join(" · ");
}

document.getElementById("saveTemplate").addEventListener("click", async () => {
  const subject = document.getElementById("mtSubject").value;
  const body = document.getElementById("mtBody").value;
  const res = await fetch("/api/mail-template", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, body }),
  });
  if (res.ok) {
    currentTemplate = await res.json();
    const note = document.getElementById("templateSavedNote");
    note.hidden = false;
    setTimeout(() => (note.hidden = true), 2000);
  }
});

function fillTemplate(template, values) {
  return template.replace(/\{\{(.+?)\}\}/g, (match, key) => {
    const v = values[key.trim()];
    return v === undefined || v === null ? "" : String(v);
  });
}

async function loadProducts(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/products${qs ? "?" + qs : ""}`);
  const data = await res.json();
  currentData = data;
  render(data);
}

function render(data) {
  document.getElementById("lookbackDays").value = data.settings.lookbackDays;
  document.getElementById("leadTimeDays").value = data.settings.leadTimeDays;
  document.getElementById("bufferDays").value = data.settings.bufferDays;
  document.getElementById("mockBadge").hidden = !data.mockMode;

  const needsReorder = data.products.filter((p) => p.needsReorder);
  document.getElementById("reorderCount").textContent = `${needsReorder.length}건`;

  const reorderList = document.getElementById("reorderList");
  reorderList.innerHTML = needsReorder.length
    ? needsReorder.map(rowHtml).join("")
    : `<div class="empty-note">지금 발주가 필요한 품목이 없어요.</div>`;

  const allList = document.getElementById("allList");
  allList.innerHTML = data.products.map(rowHtml).join("");

  document.querySelectorAll(".product-row").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.id));
  });
}

function rowHtml(p) {
  const daysLeftText = p.daysLeft === null ? "판매 이력 없음" : `약 ${p.daysLeft}일분 남음`;
  return `
    <div class="product-row ${p.needsReorder ? "urgent" : ""}" data-id="${p.id}">
      <div>
        <div class="product-name">${escapeHtml(p.name)}</div>
        <div class="product-meta">현재 재고 ${p.stockQuantity}개 · 일평균 판매 ${p.dailyVelocity}개</div>
      </div>
      <div class="days-left ${p.needsReorder ? "" : "safe"}">${daysLeftText}</div>
    </div>
  `;
}

function openDetail(productId) {
  const p = currentData.products.find((x) => x.id === productId);
  if (!p) return;

  const supplier = p.supplier || {};
  document.getElementById("detailBody").innerHTML = `
    <h3>${escapeHtml(p.name)}</h3>
    <div class="product-meta">품목 ID: ${p.id}</div>

    <div class="detail-stats">
      <div class="stat-box"><div class="label">현재 재고</div><div class="value">${p.stockQuantity}개</div></div>
      <div class="stat-box"><div class="label">일평균 판매</div><div class="value">${p.dailyVelocity}개</div></div>
      <div class="stat-box"><div class="label">예상 소진</div><div class="value">${p.daysLeft === null ? "-" : p.daysLeft + "일 후"}</div></div>
      <div class="stat-box"><div class="label">권장 발주 수량</div><div class="value">${p.recommendedOrderQty}개</div></div>
    </div>

    <div class="supplier-form">
      <h4>공급업체 정보</h4>
      <label>업체명
        <input id="supplierName" value="${escapeAttr(supplier.supplierName || "")}" placeholder="예: OO상사" />
      </label>
      <label>이메일
        <input id="supplierEmail" type="email" value="${escapeAttr(supplier.supplierEmail || "")}" placeholder="order@supplier.com" />
      </label>
      <label>이 품목만의 리드타임(일) — 비워두면 기본값 사용
        <input id="productLeadTime" type="number" min="0" value="${supplier.leadTimeDays || ""}" />
      </label>
      <div class="form-actions">
        <button class="btn-secondary" id="saveSupplier" style="width:auto;">저장</button>
        <span id="savedNote" class="saved-note" hidden>저장됨</span>
      </div>
    </div>

    <div class="form-actions">
      <button class="btn-primary" id="sendMailBtn">발주 메일 작성하기</button>
    </div>
  `;

  document.getElementById("saveSupplier").addEventListener("click", () => saveSupplier(p.id));
  document.getElementById("sendMailBtn").addEventListener("click", () => sendReorderMail(p));

  document.getElementById("detailOverlay").hidden = false;
}

async function saveSupplier(productId) {
  const supplierName = document.getElementById("supplierName").value.trim();
  const supplierEmail = document.getElementById("supplierEmail").value.trim();
  const leadTimeDays = document.getElementById("productLeadTime").value;

  const res = await fetch(`/api/suppliers/${productId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ supplierName, supplierEmail, leadTimeDays }),
  });
  if (res.ok) {
    document.getElementById("savedNote").hidden = false;
    await loadProducts(currentSettingsParams());
    openDetail(productId);
  }
}

function sendReorderMail(p) {
  const supplierEmail = document.getElementById("supplierEmail").value.trim();
  if (!supplierEmail) {
    alert("먼저 공급업체 이메일을 입력하고 저장해주세요.");
    return;
  }

  const values = {
    품목명: p.name,
    수량: p.recommendedOrderQty,
    재고: p.stockQuantity,
    일평균판매: p.dailyVelocity,
    소진예상: p.daysLeft === null ? "알 수 없음" : `${p.daysLeft}일 후`,
    업체명: document.getElementById("supplierName").value.trim() || "",
  };

  const template = currentTemplate || { subject: "[발주 요청] {{품목명}} {{수량}}개", body: "" };
  const subject = fillTemplate(template.subject, values);
  const body = fillTemplate(template.body, values);

  const mailto = `mailto:${encodeURIComponent(supplierEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailto;
}

function currentSettingsParams() {
  return {
    lookbackDays: document.getElementById("lookbackDays").value,
    leadTimeDays: document.getElementById("leadTimeDays").value,
    bufferDays: document.getElementById("bufferDays").value,
  };
}

document.getElementById("applySettings").addEventListener("click", () => {
  loadProducts(currentSettingsParams());
});

document.getElementById("closeDetail").addEventListener("click", () => {
  document.getElementById("detailOverlay").hidden = true;
});
document.getElementById("detailOverlay").addEventListener("click", (e) => {
  if (e.target.id === "detailOverlay") e.target.hidden = true;
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

loadProducts();
loadMailTemplate();
