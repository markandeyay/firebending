/**
 * IndexedDB persistence for the recording studio. Three stores:
 * - 'takes':  StoredTake records (frames included), keyPath 'key'
 * - 'videos': { key, blob, mimeType } webm blobs, keyPath 'key'
 * - 'settings': small key/value pairs (lighting note, etc.)
 *
 * Everything autosaves through here; a refresh recovers the full board.
 * All methods are promise-wrapped one-shot transactions; failures reject
 * and the app surfaces them on the saved indicator instead of crashing.
 */

import type { StoredTake } from './exportBuild';

export const DB_NAME = 'fb-studio';
export const DB_VERSION = 1;

export interface StoredVideo {
  key: string;
  blob: Blob;
  mimeType: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('takes')) {
        db.createObjectStore('takes', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('videos')) {
        db.createObjectStore('videos', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });
}

export class StudioDb {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<StudioDb> {
    return new StudioDb(await openDb());
  }

  private store(name: string, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async saveTake(take: StoredTake): Promise<void> {
    await requestToPromise(this.store('takes', 'readwrite').put(take));
  }

  async loadTakes(): Promise<StoredTake[]> {
    const all = await requestToPromise(this.store('takes', 'readonly').getAll());
    return (all as StoredTake[]).sort(
      (a, b) => a.id.localeCompare(b.id) || a.takeIndex - b.takeIndex,
    );
  }

  async deleteTake(key: string): Promise<void> {
    await requestToPromise(this.store('takes', 'readwrite').delete(key));
    await requestToPromise(this.store('videos', 'readwrite').delete(key));
  }

  async saveVideo(key: string, blob: Blob, mimeType: string): Promise<void> {
    const rec: StoredVideo = { key, blob, mimeType };
    await requestToPromise(this.store('videos', 'readwrite').put(rec));
  }

  async loadVideo(key: string): Promise<StoredVideo | null> {
    const rec = await requestToPromise(this.store('videos', 'readonly').get(key));
    return (rec as StoredVideo | undefined) ?? null;
  }

  async getSetting(key: string): Promise<string | null> {
    const v = await requestToPromise(this.store('settings', 'readonly').get(key));
    return typeof v === 'string' ? v : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await requestToPromise(this.store('settings', 'readwrite').put(value, key));
  }
}
