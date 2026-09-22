// MOCK_MODE=true 일 때 사용되는 샘플 데이터.
// 실제 API 연동 전에 화면/로직을 확인해보는 용도입니다.

const MOCK_PRODUCTS = [
  { id: "1001", name: "라벤더 룸스프레이 200ml", stockQuantity: 18, salePrice: 15900 },
  { id: "1002", name: "핸드크림 세트 3종", stockQuantity: 62, salePrice: 22000 },
  { id: "1003", name: "디퓨저 리필 300ml", stockQuantity: 6, salePrice: 18500 },
  { id: "1004", name: "천연 비누 선물세트", stockQuantity: 130, salePrice: 12900 },
  { id: "1005", name: "아로마 캔들 미니 4종", stockQuantity: 9, salePrice: 24900 },
];

// 최근 14일치 가상 주문 내역 (판매 속도 계산용)
function buildMockOrders(days) {
  const orders = [];
  const now = Date.now();
  const dailySales = {
    1001: 2.4,
    1002: 1.1,
    1003: 1.8,
    1004: 0.6,
    1005: 1.5,
  };
  for (const [productId, avgPerDay] of Object.entries(dailySales)) {
    for (let d = 0; d < days; d++) {
      const qty = Math.max(0, Math.round(avgPerDay + (Math.random() - 0.5)));
      if (qty > 0) {
        orders.push({
          productId,
          quantity: qty,
          orderedAt: new Date(now - d * 24 * 60 * 60 * 1000).toISOString(),
        });
      }
    }
  }
  return orders;
}

module.exports = {
  fetchProducts: async () => MOCK_PRODUCTS,
  fetchRecentOrders: async (days) => buildMockOrders(days),
};
