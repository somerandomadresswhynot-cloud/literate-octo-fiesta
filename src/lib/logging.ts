const verboseOnlyActions = new Set(['scan_started', 'product_links_found', 'sku_extracted', 'scan_samples', 'overlay_position_updated', 'overlay_visible_count']);

export function shouldPersistDebug(action: string, verboseEnabled: boolean): boolean {
  if (verboseEnabled) return true;
  return !verboseOnlyActions.has(action);
}
