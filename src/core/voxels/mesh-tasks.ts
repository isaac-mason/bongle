import { build, int32, list, object, uint16Array, uint32 } from 'packcat';
import { CHUNK_VOLUME } from './voxels';

/**
 * One transferable packet shipped to a mesh worker each dispatch. `set` creates/updates mirror entries the
 * worker's chunk cache lacks at the current version (full chunk data); `delete` evicts entries; `tasks` are
 * chunks to mesh, whose neighbourhood is guaranteed present in the mirror after `set`/`delete` apply.
 * Unchanged chunks are never re-sent; main is authoritative over the per-worker mirror.
 */
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

/** decoded packet; set data/light are freshly-allocated Uint16Arrays that become the worker's cache entries, palette a number[]. */
export type MeshTasks = ReturnType<typeof unpack>;
/** one `set` entry (a full chunk snapshot). */
export type MeshTaskSet = MeshTasks['set'][number];

/** scratch size for one packet. worst case is a cold neighbourhood (27 full chunks at ~16 KB each); warm deltas
 *  are tiny. packInto returns ok:false on overflow and the caller leaves the chunk dirty to retry. */
export const MESH_TASKS_SCRATCH_BYTES = 640 * 1024;
