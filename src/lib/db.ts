import type { AmazonProduct, AsinLink, DebugEntry, EventRecord, GroupMemberRecord, GroupRecord, MetaRecord, WbProduct } from './types.js';

const DB_NAME = 'wb-amazon-local-db';
const DB_VERSION = 3;
const STORES = ['amazon_products', 'wb_products', 'asin_links', 'groups', 'group_members', 'events', 'meta', 'debug_log'] as const;

type StoreName = (typeof STORES)[number];

export async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction!;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: getKeyPath(store) });
        }
        ensureIndexes(tx.objectStore(store), store);
      }
      const debugStore = tx.objectStore('debug_log');
      const debugRowsReq = debugStore.getAll();
      debugRowsReq.onsuccess = () => {
        const rows = debugRowsReq.result as DebugEntry[];
        for (const row of rows) {
          if (!row.debug_log_id) {
            debugStore.put({ ...row, debug_log_id: crypto.randomUUID() });
          }
        }
      };
      const metaStore = tx.objectStore('meta');
      const metaReq = metaStore.getAll();
      metaReq.onsuccess = () => {
        const rows = metaReq.result as MetaRecord[];
        for (const row of rows) {
          if (!row.schema_version) {
            metaStore.put({ ...row, schema_version: '1' });
          }
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
    case 'groups': return 'group_id';
    case 'group_members': return 'membership_id';
    case 'events': return 'event_id';
    case 'meta': return 'schema_version';
    case 'debug_log': return 'debug_log_id';
  }
}

function ensureIndexes(store: IDBObjectStore, storeName: StoreName): void {
  const add = (name: string, keyPath: string | string[], options?: IDBIndexParameters) => {
    if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
  };
  switch (storeName) {
    case 'amazon_products':
      add('asin', 'asin', { unique: true });
      add('workflow_status', 'workflow_status');
      add('updated_at', 'updated_at');
      break;
    case 'wb_products':
      add('wb_sku', 'wb_sku', { unique: true });
      add('seen_status', 'seen_status');
      add('rejected', 'rejected');
      add('deferred', 'deferred');
      add('updated_at', 'updated_at');
      break;
    case 'asin_links':
      add('wb_sku', 'wb_sku');
      add('asin', 'asin');
      add('is_active', 'is_active');
      add('updated_at', 'updated_at');
      add('wb_sku_asin', ['wb_sku', 'asin']);
      add('wb_sku_is_active', ['wb_sku', 'is_active']);
      add('asin_is_active', ['asin', 'is_active']);
      break;
    case 'events':
      add('event_type', 'event_type');
      add('wb_sku', 'wb_sku');
      add('asin', 'asin');
      add('created_at', 'created_at');
      break;
    case 'groups':
      add('group_id', 'group_id', { unique: true });
      add('name', 'name');
      add('deleted_at', 'deleted_at');
      break;
    case 'group_members':
      add('membership_id', 'membership_id', { unique: true });
      add('group_id', 'group_id');
      add('wb_sku', 'wb_sku');
      add('group_id_wb_sku', ['group_id', 'wb_sku']);
      add('deleted_at', 'deleted_at');
      break;
    case 'debug_log':
      add('ts', 'ts');
      add('level', 'level');
      add('action', 'action');
      break;
    case 'meta':
      break;
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

export async function getByKey<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllByIndex<T>(store: StoreName, indexName: string, key: IDBValidKey | IDBKeyRange): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const objectStore = tx.objectStore(store);
    const source = objectStore.indexNames.contains(indexName) ? objectStore.index(indexName) : objectStore;
    const req = source.getAll(key as any);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function runTransaction(stores: StoreName[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => void | Promise<void>): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    Promise.resolve(run(tx)).catch(reject);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

export async function clearStore(store: StoreName): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
  groups: GroupRecord[];
  group_members: GroupMemberRecord[];
  events: EventRecord[];
  meta: MetaRecord[];
  debug_log: DebugEntry[];
};
