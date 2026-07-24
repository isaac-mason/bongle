// lib/editor/fs-idb-store.ts — the low-level IndexedDB layout for the editor's IDB
// working-copy fallback, in ONE place. Both the full fs (fs-idb.ts, which builds a
// mirror-backed Filesystem on top) and the asset service worker (sw.ts, read-only)
// import this — so the db name, store, key convention, and row shape have a single
// source of truth instead of being mirrored by hand.
//
// Layout: one database per project (`bongle-fs:<project>`), one object store
// (`files`) keyed by the normalized project-relative path, value = { bytes, mtime }.

export const FS_DB_PREFIX = 'bongle-fs:';
export const FS_STORE = 'files';

/** a stored file: raw bytes + a change-detection mtime (ms epoch). */
export type FsRow = { bytes: Uint8Array; mtime: number };

/** promisify an IDBRequest. */
export function idbRequest<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

/** Open (creating if needed) the project's fs database with its `files` store — the
 *  read-write owner. Rejects if IndexedDB is blocked, so the caller picks a fallback. */
export function openFsDb(projectName: string): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('[fs-idb] IndexedDB unavailable'));
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(`${FS_DB_PREFIX}${projectName}`, 1);
        open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains(FS_STORE)) open.result.createObjectStore(FS_STORE);
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
        open.onblocked = () => reject(new Error('[fs-idb] open blocked by another connection'));
    });
}

/** Open the project's fs database READ-ONLY without creating it: if it doesn't exist
 *  (an OPFS session never wrote one), abort the implicit create so we neither leave a
 *  phantom db nor pin a version that would block the owner's store creation. Resolves
 *  null when there's nothing to read. Closes on versionchange so a held connection
 *  never blocks the owner's upgrade. For read-only consumers like the asset SW. */
export function openFsDbReadonly(projectName: string): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
        const open = indexedDB.open(`${FS_DB_PREFIX}${projectName}`);
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onsuccess = () => {
            const db = open.result;
            db.onversionchange = () => db.close();
            resolve(db);
        };
        open.onerror = () => resolve(null); // abort/absent → nothing to serve
        open.onblocked = () => resolve(null);
    });
}

/** read a single file row by normalized path. undefined when absent. */
export function getFileRow(db: IDBDatabase, key: string): Promise<FsRow | undefined> {
    return idbRequest(db.transaction(FS_STORE, 'readonly').objectStore(FS_STORE).get(key)) as Promise<FsRow | undefined>;
}
