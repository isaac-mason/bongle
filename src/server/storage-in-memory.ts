import type {
    JsonValue,
    ServerDriver,
    StorageDeleteResult,
    StorageEntry,
    StorageListOpts,
    StorageListPage,
    StorageSetResult,
} from 'bongle/interface';

type Row = { value: JsonValue; version: string };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function listFromMap(map: Map<string, Row>, opts: StorageListOpts | undefined): StorageListPage {
    const prefix = opts?.prefix ?? '';
    const cursor = opts?.cursor ?? '';
    const limit = Math.min(opts?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    // sorted so cursor pagination is deterministic.
    const keys = [...map.keys()].filter((k) => (prefix === '' || k.startsWith(prefix)) && k > cursor).sort();

    const page = keys.slice(0, limit);
    const items = page.map((key) => {
        const row = map.get(key);
        if (!row) throw new Error('unreachable');
        return { key, value: row.value, version: row.version };
    });
    const nextCursor = keys.length > limit ? page[page.length - 1] : null;
    return { items, nextCursor };
}

export function createInMemoryStorageDriver(): ServerDriver['storage'] {
    const project = new Map<string, Row>();
    // one Map per userId so cross-user listing stays constrained.
    const userByUserId = new Map<string, Map<string, Row>>();

    function getUserMap(userId: string): Map<string, Row> {
        let m = userByUserId.get(userId);
        if (!m) {
            m = new Map();
            userByUserId.set(userId, m);
        }
        return m;
    }

    function setOn(map: Map<string, Row>, key: string, value: JsonValue, ifVersion: string | undefined): StorageSetResult {
        const existing = map.get(key);
        if (ifVersion !== undefined && (!existing || existing.version !== ifVersion)) {
            return { ok: false, code: 'version_conflict' };
        }
        const version = crypto.randomUUID();
        map.set(key, { value, version });
        return { ok: true, version };
    }

    function deleteOn(map: Map<string, Row>, key: string, ifVersion: string | undefined): StorageDeleteResult {
        const existing = map.get(key);
        if (ifVersion !== undefined && existing && existing.version !== ifVersion) {
            return { ok: false, code: 'version_conflict' };
        }
        map.delete(key);
        return { ok: true };
    }

    return {
        project: {
            async get(key: string): Promise<StorageEntry | null> {
                const row = project.get(key);
                return row ? { value: row.value, version: row.version } : null;
            },
            async set(key, value, opts) {
                return setOn(project, key, value, opts?.ifVersion);
            },
            async delete(key, opts) {
                return deleteOn(project, key, opts?.ifVersion);
            },
            async list(opts) {
                return listFromMap(project, opts);
            },
        },
        user: {
            async get(userId, key) {
                const row = getUserMap(userId).get(key);
                return row ? { value: row.value, version: row.version } : null;
            },
            async set(userId, key, value, opts) {
                return setOn(getUserMap(userId), key, value, opts?.ifVersion);
            },
            async delete(userId, key, opts) {
                return deleteOn(getUserMap(userId), key, opts?.ifVersion);
            },
            async list(userId, opts) {
                return listFromMap(getUserMap(userId), opts);
            },
        },
    };
}
