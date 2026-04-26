export type AmazonProduct = {
  asin: string;
  amazon_url: string;
  title: string;
  brand: string;
  image_url: string;
  category: string;
  keywords: string;
  comment: string;
  priority: string;
  workflow_status: string;
  checked_result: string;
  last_checked_at: string;
  created_at: string;
  updated_at: string;
};

export type WbProduct = {
  wb_sku: string;
  wb_url: string;
  seen_status: string;
  first_seen_at: string;
  last_seen_at: string;
  last_touched_at: string;
  rejected: string;
  rejected_reason: string;
  deferred: string;
  deferred_reason: string;
  created_at: string;
  updated_at: string;
  deleted_at: string;
};

export type AsinLink = {
  link_id: string;
  wb_sku: string;
  asin: string;
  link_type: string;
  is_active: string;
  comment: string;
  created_at: string;
  updated_at: string;
  deleted_at: string;
  created_by_action: string;
};

export type EventRecord = {
  event_id: string;
  operation_id: string;
  event_type: string;
  wb_sku: string;
  asin: string;
  group_id: string;
  payload_json: string;
  created_at: string;
  client_id: string;
};

export type MetaRecord = {
  schema_version: string;
  data_revision: string;
  active_asin: string;
  default_link_type: string;
  last_imported_at: string;
  last_exported_at: string;
};

export type DebugEntry = {
  ts: string;
  level: 'info' | 'error';
  action: string;
  details?: Record<string, unknown>;
};
