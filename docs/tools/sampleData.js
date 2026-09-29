// 설명서 캡처용 샘플 품목 (글라스아트 재료 18개). build-manual.js 가 앱의 mockData.js 대신 끼워 쓴다.
const names = ["중사이즈 글라스아트 썬캐쳐 모빌 만들기 아크릴판 반제","소형사이즈 글라스아트 썬캐쳐 모빌 만들기 아크릴판 반제","SP05 스테인드글라스 글라스아트 재료 시트지 필름 세미 불투명 파스텔 마블","미니사이즈 글라스아트 썬캐쳐 모빌 만들기 아크릴판 반제","언그레이드 체험 교육용 구리종 30개 벌크팩 만들기 연습용","SP07 스테인드글라스 글라스아트 재료 시트지 필름 세미 불투명 파스텔 마블","글라스아트 납선 테이프 3mm 50m","글라스아트 전용 스퀴지 헤라 세트","스테인드글라스 유리 컬러 필름 A4 투명 레드","스테인드글라스 유리 컬러 필름 A4 투명 블루","썬캐쳐 크리스탈 프리즘 20mm 10개입","글라스아트 도안 50종 PDF + 인쇄본","리드라인 납선 6mm 금색 30m","체험키트 썬캐쳐 만들기 1인 세트","글라스아트 커터칼 정밀형","투명 아크릴 원형 판 10cm 5장","모빌 낚싯줄 0.5mm 100m","글라스아트 마감용 코팅제 250ml"];
const products = names.map((name,i)=>({ id: String(2001+i), name, stockQuantity: [4,12,0,30,55,8,120,17,3,26,9,40,15,6,22,70,33,2][i], salePrice: 10000 }));
const vel = [1.8,0.9,0.4,1.1,0.3,1.4,2.5,0.6,0.8,0.7,1.2,0,0.5,1.6,0.2,0.9,0.4,0.3];
module.exports = {
  fetchProducts: async () => products,
  // 기간 동안 팔린 총량은 그대로 두고(판매 속도 계산이 달라지지 않게), 날짜별로 들쭉날쭉 나눠서 판매 그래프가 자연스럽게 보이게 한다
  fetchRecentOrders: async (days) => {
    const o = [];
    const now = Date.now();
    products.forEach((p, i) => {
      const total = Math.round(vel[i] * days);
      if (total <= 0) return;
      const w = Array.from({ length: days }, (_, d) => 1 + 0.6 * Math.sin((d + 1) * (i + 2) * 0.7) + (d / days) * (i % 3 === 0 ? 0.8 : 0));
      const sum = w.reduce((a, b) => a + b, 0);
      const per = w.map((x) => Math.floor((x / sum) * total));
      let left = total - per.reduce((a, b) => a + b, 0);
      for (let d = days - 1; left > 0; d = (d - 1 + days) % days, left--) per[d]++;
      per.forEach((q, d) => {
        if (q > 0) o.push({ productId: p.id, quantity: q, orderedAt: new Date(now - (days - 1 - d) * 864e5).toISOString() });
      });
    });
    return o;
  },
};
