let currentData = null;
let currentTemplate = null;
let currentLabels = [];
let hasAutoOpenedLabelPopup = false;

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
  try {
    currentTemplate = await postJson("/api/mail-template", "POST", { subject, body });
  } catch (err) {
    alert(err.message || "양식 저장에 실패했어요.");
    return;
  }
  const note = document.getElementById("templateSavedNote");
  note.hidden = false;
  setTimeout(() => (note.hidden = true), 2000);
});

function fillTemplate(template, values) {
  return template.replace(/\{\{(.+?)\}\}/g, (match, key) => {
    const v = values[key.trim()];
    return v === undefined || v === null ? "" : String(v);
  });
}

function setListLoading(isLoading) {
  document.getElementById("listLoadingOverlay").hidden = !isLoading;
}

// 서버 응답이 실패면 서버가 보낸 에러 메시지로 예외를 던진다
async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

async function loadProducts(params = {}) {
  setListLoading(true);
  const qs = new URLSearchParams(params).toString();
  try {
    const data = await fetchJson(`/api/products${qs ? "?" + qs : ""}`);
    currentData = data;
    render(data);
  } catch (err) {
    // 품목을 못 불러와도 라벨 관리 등 나머지 기능은 쓸 수 있게 라벨만 따로 불러온다
    document.getElementById("reorderList").innerHTML =
      `<div class="empty-note">품목을 불러오지 못했어요: ${escapeHtml(err.message)}</div>`;
    document.getElementById("reorderCount").textContent = "–";
    await loadLabels().catch(() => {});
  } finally {
    setListLoading(false);
  }
}

async function loadLabels() {
  currentLabels = await fetchJson("/api/labels");
  renderLabelFilterOptions();
}

// 라벨 추가/수정/삭제/지정 후 화면 전체를 새로 그린다
async function refreshAfterLabelChange() {
  await loadProducts(currentSettingsParams());
  renderLabelManagerBody();
}

function render(data) {
  document.getElementById("lookbackDays").value = data.settings.lookbackDays;
  document.getElementById("bufferDays").value = data.settings.bufferDays;
  document.getElementById("mockBadge").hidden = !data.mockMode;

  currentLabels = data.labels || [];
  renderLabelFilterOptions();

  const selectedLabel = document.getElementById("labelFilter").value;
  const filtered = selectedLabel === "all"
    ? data.products
    : data.products.filter((p) => p.labelId === selectedLabel);

  const needsReorder = filtered.filter((p) => p.needsReorder);
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

  const unlabeledCount = getUnlabeledProducts().length;
  const labelBadge = document.getElementById("labelCountBadge");
  labelBadge.hidden = unlabeledCount === 0;
  labelBadge.textContent = `미분류 ${unlabeledCount}`;

  if (!hasAutoOpenedLabelPopup) {
    hasAutoOpenedLabelPopup = true;
    if (getUnlabeledProducts().length) openLabelManager();
  }
}

function renderLabelFilterOptions() {
  const select = document.getElementById("labelFilter");
  const prevValue = select.value || "all";
  select.innerHTML =
    `<option value="all">전체</option>` +
    currentLabels.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join("");
  select.value = currentLabels.some((l) => l.id === prevValue) ? prevValue : "all";
}

function getUnlabeledProducts() {
  if (!currentData?.products) return [];
  return currentData.products.filter((p) => !p.labelId);
}

function rowHtml(p) {
  const daysLeftText = p.daysLeft === null ? "판매 이력 없음" : `약 ${p.daysLeft}일분 남음`;
  const color = p.label?.color;
  const rowStyle = color && !p.needsReorder ? `style="border-left-color:${color};"` : "";
  const chip = p.label
    ? `<span class="label-chip" style="background:${color}1a; color:${color}; border-color:${color}4d;"><span class="label-dot" style="background:${color};"></span>${escapeHtml(p.label.name)}</span>`
    : "";
  return `
    <div class="product-row ${p.needsReorder ? "urgent" : ""}" data-id="${p.id}" ${rowStyle}>
      <div>
        <div class="product-name">${escapeHtml(p.name)}${chip}</div>
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
      <label>이 품목만의 리드타임(일) — 비워두면 입고유형 라벨의 리드타임 사용
        <input id="productLeadTime" type="number" min="0" value="${supplier.leadTimeDays ?? ""}" />
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

  try {
    await postJson(`/api/suppliers/${productId}`, "POST", { supplierName, supplierEmail, leadTimeDays });
  } catch (err) {
    alert(err.message || "저장에 실패했어요.");
    return;
  }
  await loadProducts(currentSettingsParams());
  openDetail(productId);
  // openDetail 이 화면을 새로 그리므로 저장됨 표시는 그 뒤에 켠다
  const note = document.getElementById("savedNote");
  if (note) {
    note.hidden = false;
    setTimeout(() => (note.hidden = true), 2000);
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
    bufferDays: document.getElementById("bufferDays").value,
  };
}

document.getElementById("applySettings").addEventListener("click", async () => {
  const { lookbackDays, bufferDays } = currentSettingsParams();
  if (!(Number(lookbackDays) >= 1) || bufferDays === "" || Number(bufferDays) < 0) {
    alert("판매 속도 계산 기간은 1일 이상, 안전 여유일수는 0일 이상으로 입력해주세요.");
    return;
  }
  const btn = document.getElementById("applySettings");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "적용 중…";
  try {
    await loadProducts(currentSettingsParams());
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

document.getElementById("closeDetail").addEventListener("click", () => {
  document.getElementById("detailOverlay").hidden = true;
});
document.getElementById("detailOverlay").addEventListener("click", (e) => {
  if (e.target.id === "detailOverlay") e.target.hidden = true;
});

function openLabelManager() {
  renderLabelManagerBody();
  document.getElementById("labelOverlay").hidden = false;
}

function renderLabelManagerBody() {
  const unlabeled = getUnlabeledProducts();

  document.getElementById("labelManagerBody").innerHTML = `
    <h3>입고유형 라벨 관리</h3>

    <div class="label-create-form">
      <label>라벨 이름
        <input id="newLabelName" type="text" placeholder="예: 수입" />
      </label>
      <label>리드타임(일)
        <input id="newLabelLeadTime" type="number" min="0" style="width:80px;" />
      </label>
      <button class="btn-secondary" id="createLabelBtn" style="width:auto;">라벨 추가</button>
    </div>

    <h4>현재 라벨</h4>
    <div class="label-grid">
    ${currentLabels.length
      ? currentLabels
          .map(
            (l) => `
        <div class="unlabeled-row label-edit-row" data-label-id="${l.id}" style="border-left:4px solid ${l.color};">
          <label>라벨명
            <input class="label-edit-name" type="text" value="${escapeAttr(l.name)}" style="width:120px;" />
          </label>
          <label>리드타임(일)
            <input class="label-edit-leadtime" type="number" min="0" value="${l.leadTimeDays}" style="width:70px;" />
          </label>
          <div class="form-actions" style="margin-top:0;">
            <button class="btn-secondary update-label-btn" style="width:auto;">저장</button>
            <button class="btn-secondary delete-label-btn" style="width:auto; color:var(--danger-ink);">삭제</button>
          </div>
        </div>`
          )
          .join("")
      : `<div class="product-meta" style="margin-bottom:16px;">아직 만든 라벨이 없어요. 위에서 먼저 만들어주세요.</div>`}
    </div>

    <h4>입고유형 라벨이 없는 품목 (${unlabeled.length}개)</h4>
    ${unlabeled.length
      ? unlabeled
          .map(
            (p) => `
        <div class="unlabeled-row" data-product-id="${p.id}">
          <div class="product-name">${escapeHtml(p.name)}</div>
          <div style="display:flex; gap:8px; align-items:center;">
            <select class="unlabeled-select">
              <option value="">라벨 선택</option>
              ${currentLabels.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join("")}
            </select>
            <button class="btn-secondary assign-label-btn" style="width:auto;">저장</button>
          </div>
        </div>`
          )
          .join("")
      : `<div class="empty-note">모든 품목에 라벨이 지정돼 있어요.</div>`}
  `;

  document.getElementById("createLabelBtn").addEventListener("click", createLabelFromForm);
  document.querySelectorAll(".update-label-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const row = e.target.closest(".unlabeled-row");
      const name = row.querySelector(".label-edit-name").value.trim();
      const leadTimeDays = row.querySelector(".label-edit-leadtime").value;
      if (!name || leadTimeDays === "") {
        alert("라벨 이름과 리드타임을 모두 입력해주세요.");
        return;
      }
      updateLabelRequest(row.dataset.labelId, name, leadTimeDays);
    });
  });
  document.querySelectorAll(".delete-label-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const row = e.target.closest(".unlabeled-row");
      if (!confirm("이 라벨을 삭제할까요? 지정돼 있던 품목은 라벨 없음 상태로 돌아가요.")) return;
      deleteLabelRequest(row.dataset.labelId);
    });
  });
  document.querySelectorAll(".assign-label-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const row = e.target.closest(".unlabeled-row");
      const labelId = row.querySelector(".unlabeled-select").value;
      if (!labelId) {
        alert("라벨을 선택해주세요.");
        return;
      }
      assignLabel(row.dataset.productId, labelId);
    });
  });
}

function postJson(url, method, payload) {
  return fetchJson(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function updateLabelRequest(labelId, name, leadTimeDays) {
  try {
    await postJson(`/api/labels/${labelId}`, "PUT", { name, leadTimeDays });
  } catch (err) {
    alert(err.message || "라벨 수정에 실패했어요.");
    return;
  }
  await refreshAfterLabelChange();
}

async function deleteLabelRequest(labelId) {
  try {
    await fetchJson(`/api/labels/${labelId}`, { method: "DELETE" });
  } catch (err) {
    alert(err.message || "라벨 삭제에 실패했어요.");
    return;
  }
  await refreshAfterLabelChange();
}

async function createLabelFromForm() {
  const name = document.getElementById("newLabelName").value.trim();
  const leadTimeDays = document.getElementById("newLabelLeadTime").value;
  if (!name || leadTimeDays === "") {
    alert("라벨 이름과 리드타임을 모두 입력해주세요.");
    return;
  }

  try {
    await postJson("/api/labels", "POST", { name, leadTimeDays });
  } catch (err) {
    alert(err.message || "라벨 추가에 실패했어요.");
    return;
  }
  await refreshAfterLabelChange();
}

async function assignLabel(productId, labelId) {
  try {
    await postJson(`/api/suppliers/${productId}`, "POST", { labelId });
  } catch (err) {
    alert(err.message || "라벨 지정에 실패했어요.");
    return;
  }
  await refreshAfterLabelChange();
}

document.getElementById("openLabelManager").addEventListener("click", openLabelManager);
document.getElementById("closeLabelManager").addEventListener("click", () => {
  document.getElementById("labelOverlay").hidden = true;
});
document.getElementById("labelOverlay").addEventListener("click", (e) => {
  if (e.target.id === "labelOverlay") e.target.hidden = true;
});
document.getElementById("labelFilter").addEventListener("change", () => render(currentData));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

loadProducts();
loadMailTemplate().catch((err) => console.error("메일 양식을 불러오지 못했어요:", err));
