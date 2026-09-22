// 판매 속도 기반 재주문 필요 여부 계산

/**
 * @param {Array} products [{id, name, stockQuantity, salePrice}]
 * @param {Array} orders [{productId, quantity, orderedAt}]
 * @param {Object} settings { lookbackDays, leadTimeDays, bufferDays }
 * @param {Object} leadTimeOverrides { [productId]: number } 품목별 리드타임 재정의
 */
function computeReorderList(products, orders, settings, leadTimeOverrides = {}) {
  const { lookbackDays, leadTimeDays, bufferDays } = settings;

  const soldByProduct = {};
  for (const o of orders) {
    soldByProduct[o.productId] = (soldByProduct[o.productId] || 0) + o.quantity;
  }

  return products.map((p) => {
    const totalSold = soldByProduct[p.id] || 0;
    const dailyVelocity = totalSold / lookbackDays; // 하루 평균 판매량
    const effectiveLeadTime = leadTimeOverrides[p.id] ?? leadTimeDays;
    const coverDays = effectiveLeadTime + bufferDays; // 이만큼의 재고를 항상 보유하고 싶음

    const daysLeft = dailyVelocity > 0 ? p.stockQuantity / dailyVelocity : Infinity;
    const targetStock = Math.ceil(dailyVelocity * coverDays);
    const recommendedOrderQty = Math.max(0, targetStock - p.stockQuantity);

    // 발주 필요: 리드타임 내에 재고가 바닥날 것으로 예상되는 경우
    const needsReorder = dailyVelocity > 0
      ? daysLeft <= effectiveLeadTime
      : p.stockQuantity === 0; // 판매 이력이 없는데 재고가 0인 경우만 표시

    return {
      ...p,
      dailyVelocity: Number(dailyVelocity.toFixed(2)),
      daysLeft: Number.isFinite(daysLeft) ? Number(daysLeft.toFixed(1)) : null,
      leadTimeDays: effectiveLeadTime,
      bufferDays,
      recommendedOrderQty,
      needsReorder,
    };
  });
}

module.exports = { computeReorderList };
