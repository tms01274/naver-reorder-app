// 옵션 상품(색상 등)을 옵션마다 한 줄로 나눈 뒤, 주문 · 예전 기록을 그 줄에 맞춘다.
// 옵션 줄: { id: "상품번호_옵션번호", parentId: 상품번호, optionNames: [...] } (src/naverClient.js 의 splitByOption)

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

// 주문의 옵션 글자("색상: 021 Yellow" / "종: 종X / 포장: 필요없음")에 옵션 이름이 모두 들어 있는 줄 중
// 가장 길게 맞는 줄 ("1 베이지"와 "11 베이지"가 둘 다 맞으면 "11 베이지")
function matchOptionRow(rows, optionText) {
  const text = norm(optionText);
  if (!text) return null;
  let best = null;
  let bestLen = -1;
  for (const r of rows) {
    const names = (r.optionNames || []).map(norm).filter(Boolean);
    if (!names.length || !names.every((n) => text.includes(n))) continue;
    const len = names.reduce((a, n) => a + n.length, 0);
    if (len > bestLen) { best = r; bestLen = len; }
  }
  return best;
}

// 주문의 productId 를 옵션 줄 id 로 바꾸고 parentId 를 남긴다 (옵션이 안 맞으면 상품번호 그대로)
function assignOrdersToOptionRows(products, orders) {
  const rowsByParent = {};
  for (const p of products) if (p.parentId) (rowsByParent[p.parentId] ||= []).push(p);
  return orders.map((o) => {
    const rows = rowsByParent[o.productId];
    if (!rows) return o;
    const row = matchOptionRow(rows, o.optionText);
    return { ...o, parentId: o.productId, productId: row ? row.id : o.productId };
  });
}

// 옵션 줄에 아직 정보가 없으면 업체 · 라벨 · 리드타임을 이어받는다:
// 옵션으로 나누기 전에 상품에 지정해 둔 정보, 없으면 (나중에 추가된 색상처럼) 같은 상품의 다른 옵션 정보
function inheritParentInfo(products, suppliers) {
  let changed = false;
  for (const p of products) {
    if (!p.parentId || suppliers[p.id]) continue;
    const sibling = products.find((s) => s.parentId === p.parentId && s.id !== p.id && suppliers[s.id]);
    if (suppliers[p.parentId]) suppliers[p.id] = { ...suppliers[p.parentId] };
    else if (sibling) {
      // 다른 옵션에서는 업체 · 라벨 · 리드타임만 (업체용 품명 · 수량 규칙은 옵션마다 다를 수 있어서)
      const { vendorItemName, minOrderQty, packSize, ...shared } = suppliers[sibling.id];
      suppliers[p.id] = shared;
    } else continue;
    changed = true;
  }
  return changed;
}

module.exports = { matchOptionRow, assignOrdersToOptionRows, inheritParentInfo };
