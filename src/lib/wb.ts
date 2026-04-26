export function extractWbSkuFromUrl(url: string): string | null {
  const match = url.match(/\/catalog\/(\d+)\/detail\.aspx/i);
  return match?.[1] ?? null;
}

export function getVisibleProductLinks(): HTMLAnchorElement[] {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/catalog/"]'));
  return anchors.filter((anchor) => {
    const rect = anchor.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  });
}
