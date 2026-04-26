import type { AmazonProduct, AsinLink, DebugEntry, EventRecord, MetaRecord, WbProduct } from './types.js';

const DB_NAME = 'wb-amazon-local-db';
const DB_VERSION = 1;
const STORES = ['amazon_products', 'wb_products', 'asin_links', 'events', 'meta', 'debug_log'] as const;

type StoreName = (typeof STORES)[number];

export async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: getKeyPath(store) });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getKeyPath(store: StoreName): string {
  switch (store) {
    case 'amazon_products': return 'asin';
    case 'wb_products': return 'wb_sku';
    case 'asin_links': return 'link_id';
    case 'events': return 'event_id';
    case 'meta': return 'schema_version';
    case 'debug_log': return 'ts';
  }
}

export async function putMany<T extends object>(store: StoreName, records: T[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const objectStore = tx.objectStore(store);
    records.forEach((row) => objectStore.put(row));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function clearDb(): Promise<void> {
  const db = await openDb();
  await Promise.all(STORES.map((store) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })));
}

export type StateDump = {
  amazon_products: AmazonProduct[];
  wb_products: WbProduct[];
  asin_links: AsinLink[];
  events: EventRecord[];
  meta: MetaRecord[];
  debug_log: DebugEntry[];
};
