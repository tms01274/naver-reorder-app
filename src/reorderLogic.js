// 판매 속도 기반 재주문 필요 여부 계산
//
//   발주 시점 = 리드타임 + 안전 여유일수 안에 재고가 바닥날 때 (여유분까지 버티려면 지금 주문해야 함)
//   권장 수량 = 하루 판매량 × (리드타임 + 안전 여유 + 발주 간격) − 지금 재고
//               (발주 간격: 다음 발주까지 며칠 쉴지. 그동안 팔 양을 미리 채운다. 업체마다 다를 수 있음)
//               → 업체의 최소 주문 수량 · 묶음 단위에 맞춰 올림

// 업체 주문 규칙에 맞춘 수량. 필요 없으면(0 이하) 0
function roundOrderQty(qty, rule = {}) {
  if (!(qty > 0)) return 0;
  const min = Number(rule.minOrderQty) > 0 ? Number(rule.minOrderQty) : 0;
  const pack = Number(rule.packSize) > 1 ? Number(rule.packSize) : 1;
  return Math.ceil(Math.max(qty, min) / pack) * pack;
}

/**
 * @param {Array} products [{id, name, stockQuantity, salePrice}]
 * @param {Array} orders [{productId, quantity, orderedAt}]
 * @param {Object} settings { lookbackDays, leadTimeDays, bufferDays, orderCycleDays }
 * @param {Object} leadTimeOverrides { [productId]: number } 품목별 리드타임 재정의
 * @param {Object} orderRules { [productId]: { minOrderQty?, packSize? } } 업체 주문 규칙
 * @param {Object} cycleOverrides { [productId]: number } 업체별 발주 간격 (없으면 settings.orderCycleDays)
 */
function computeReorderList(products, orders, settings, leadTimeOverrides = {}, orderRules = {}, cycleOverrides = {}) {
  const { lookbackDays, leadTimeDays, bufferDays, orderCycleDays = 0 } = settings;

  const soldByProduct = {};
  for (const o of orders) {
    soldByProduct[o.productId] = (soldByProduct[o.productId] || 0) + o.quantity;
  }

  return products.map((p) => {
    const totalSold = soldByProduct[p.id] || 0;
    const dailyVelocity = totalSold / lookbackDays; // 하루 평균 판매량
    const effectiveLeadTime = leadTimeOverrides[p.id] ?? leadTimeDays;
    const reorderPointDays = effectiveLeadTime + bufferDays; // 재고가 이 기간보다 짧게 남으면 발주
    const cycleDays = cycleOverrides[p.id] ?? orderCycleDays;
    const coverDays = reorderPointDays + cycleDays; // 발주하면 이만큼 버틸 재고를 채운다

    const daysLeft = dailyVelocity > 0 ? p.stockQuantity / dailyVelocity : Infinity;
    const targetStock = Math.ceil(dailyVelocity * coverDays);
    const orderRule = orderRules[p.id] || {};
    const neededQty = Math.max(0, targetStock - p.stockQuantity);

    const needsReorder = dailyVelocity > 0
      ? daysLeft <= reorderPointDays
      : p.stockQuantity === 0; // 판매 이력이 없는데 재고가 0인 경우만 표시

    return {
      ...p,
      dailyVelocity: Number(dailyVelocity.toFixed(2)),
      daysLeft: Number.isFinite(daysLeft) ? Number(daysLeft.toFixed(1)) : null,
      leadTimeDays: effectiveLeadTime,
      bufferDays,
      reorderPointDays,
      orderCycleDays: cycleDays,
      coverDays,
      targetStock,
      orderRule,
      neededQty,
      recommendedOrderQty: roundOrderQty(neededQty, orderRule),
      needsReorder,
    };
  });
}

module.exports = { computeReorderList, roundOrderQty };
