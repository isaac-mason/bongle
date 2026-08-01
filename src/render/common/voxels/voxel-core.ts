// VoxelCore — the backend-neutral voxel resource shape.
//
// The shared half of a backend's voxel resources: the quad arena + packer,
// the texture-array atlas, the CPU mesher (worker pool + scratch), and the
// per-pass materials + geometries. Both backends build one of these; each
// then augments it with its own producer state — WebGPU adds the compute
// frame (`VoxelResources = VoxelCore & { …compute… }` in webgpu/voxels/
// gpu-frame), WebGL will add its CPU cull/emit frame.
//
// Shared consumers (voxel-visuals: the mesher-drive + per-room mesh creation)
// depend on THIS, never on a backend's full resource handle — so `common/`
// never references `webgpu/`.
//
// The `Geometry`/`Material` types are shared even though each backend fills
// them with its own flavor (WebGPU: indirect + visibleQuads + gpu material;
// WebGL: mesh.draws + quadSlot + webgl material).

import type { ArrayTexture, Geometry, GpuBuffer, Material } from 'gpucat';
import type { MeshOutput } from '../../../core/voxels/chunk-mesher';
import type { MeshDispatcher, MeshDispatcherResult } from './mesh-dispatcher';
import type { VoxelArenaResources } from './voxel-arena';
import type { VoxelPass } from './voxel-material';

export type VoxelCore = {
    /** gpucat array-texture atlas. */
    atlas: ArrayTexture;
    /** per-layer texture-animation metadata storage buffer. */
    texAnimBuffer: GpuBuffer;
    /** registry.texAnimData this struct was built against. */
    texAnimData: Float32Array;
    /** atlas manifest hash this struct was built against (null on fetch fail). */
    atlasHash: string | null;
    /** resolves once the atlas pixels finish uploading into the array texture. */
    atlasReady: Promise<void>;
    /** @internal settled by the backend's `load()` once atlas pixels upload. */
    _resolveAtlasReady: () => void;
    /** unified per-pass quad materials, bound on each per-room `Mesh` alongside
     *  `geometries`. Contents are backend-specific; the type is shared. */
    quadMaterials: Record<VoxelPass, Material>;
    /** engine-global per-pass geometry. Contents are backend-specific (WebGPU
     *  binds indirect + visibleQuads; WebGL uses mesh.draws + quadSlot); the
     *  type is shared. */
    geometries: Record<VoxelPass, Geometry>;
    /** engine-global arenas (quadArena + per-pass section tables + packer). the
     *  active room owns the contents; `packerClearAll` resets on activation. */
    arenas: VoxelArenaResources;
    /** off-thread mesh worker pool. null on asset-pipeline paths where the
     *  synchronous remesh loop is preferred (callers pass workerCount=0). */
    meshDispatcher: MeshDispatcher | null;
    /** completed worker jobs, drained at the top of `voxel-visuals.update()`. */
    pendingMeshResults: MeshDispatcherResult[];
    /** chunk keys whose in-flight worker jobs were lost to a worker crash;
     *  drained + re-dirtied at the top of `voxel-visuals.update()`. */
    pendingLostChunkKeys: string[];
    /** scratch `MeshOutput` shared by every main-thread sync remesh. */
    meshOutput: MeshOutput;
};
