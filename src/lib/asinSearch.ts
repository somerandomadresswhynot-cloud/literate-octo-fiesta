import type { AmazonProduct } from './types.js';

export function filterAndRankAsinResults(params: {
  products: AmazonProduct[];
  query: string;
  activeAsin: string;
  recentAsins: string[];
}): AmazonProduct[] {
  const q = params.query.toLowerCase().trim();
  const recentOrder = Array.from(new Set(params.recentAsins.filter(Boolean).reverse()));
  const matches = params.products.filter((product) => {
    if (!q) return true;
    return [product.asin, product.title, product.brand, product.category, product.keywords, product.comment, product.workflow_status]
      .some((field) => field?.toLowerCase().includes(q));
  });

  const rank = (product: AmazonProduct): number => {
    if (!q && params.activeAsin && product.asin === params.activeAsin) return 0;
    if (!q) {
      const recentIdx = recentOrder.indexOf(product.asin);
      if (recentIdx >= 0) return 1 + recentIdx;
      if (product.workflow_status === 'in_progress') return 100;
      return 1000;
    }
    if (product.asin.toLowerCase() === q) return 0;
    if (product.asin.toLowerCase().startsWith(q)) return 1;
    return 10;
  };

  return matches
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.asin.localeCompare(b.asin))
    .slice(0, 50);
}
