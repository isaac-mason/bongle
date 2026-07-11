// ── mesh tasks packet (v2: delta-synced worker chunk cache) ─────────
//
// One transferable buffer (packcat) shipped to a mesh worker each dispatch. The
// worker keeps a persistent, versioned mirror of the chunks it meshes; main
// streams deltas to keep it current:
//   - set:    create/update mirror entries (a chunk the worker lacks at the
//             current `version`). carries the full chunk data (blocks + light +
//             palette).
//   - delete: evict mirror entries (chunk unloaded, or — later — LRU pressure).
//   - tasks:  chunks to mesh; their neighbourhood is guaranteed present in the
//             worker mirror after `set`/`delete` apply.
//
// Unchanged chunks are never re-sent. Coherency: the worker is a passive store,
// main is authoritative and tracks a per-worker mirror; a worker crash clears
// that mirror. See llm/plan-mesh-worker-chunk-cache.md.

import { build, int32, list, object, uint16Array, uint32 } from 'packcat';
import { CHUNK_VOLUME } from './voxels';

export const meshTasksSchema = object({
    set: list(
        object({
            cx: int32(),
            cy: int32(),
            cz: int32(),
            version: uint32(),
            data: uint16Array(CHUNK_VOLUME),
            light: uint16Array(CHUNK_VOLUME),
            palette: list(uint32()),
        }),
    ),
    delete: list(object({ cx: int32(), cy: int32(), cz: int32() })),
    tasks: list(object({ cx: int32(), cy: int32(), cz: int32(), gen: uint32() })),
});

const { packInto, unpack } = build(meshTasksSchema);

export { packInto as packMeshTasks, unpack as unpackMeshTasks };

/** decoded packet (packcat unpack — set data/light are freshly-allocated
 *  Uint16Arrays that become the worker's cache entries; palette a number[]). */
export type MeshTasks = ReturnType<typeof unpack>;
/** one `set` entry (a full chunk snapshot). */
export type MeshTaskSet = MeshTasks['set'][number];

/** a worker cache entry — the mesh-relevant slice of a chunk. `buildSlabs`
 *  reads exactly `data`/`light`/`palette`, so cache values stand in for `Chunk`. */
export type CachedChunk = { version: number; data: Uint16Array; light: Uint16Array; palette: number[] };

/** scratch size for one packet. worst case is a cold neighbourhood (27 full
 *  chunks × ~16 KB); warm deltas are tiny. packInto returns ok:false on
 *  overflow and the caller leaves the chunk dirty to retry. */
export const MESH_TASKS_SCRATCH_BYTES = 640 * 1024;
