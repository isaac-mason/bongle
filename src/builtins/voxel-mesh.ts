// voxel mesh trait — renders a VoxelModel.
//
// set model to a VoxelModel instance and the engine creates an instance
// slot in VoxelMeshVisuals on the client. multiple traits can reference
// the same VoxelModel — geometry is shared, each gets its own instance.
//
// model is runtime-only (not persisted, not synced). tint, flash, light,
// glow, unlit, litMin, and dither are client-only per-instance rendering
// params, same as MeshTrait.

import type { Vec4 } from 'mathcat';
import type { VoxelMeshState } from '../client/voxels/voxel-mesh-visuals';
import { VoxelModel } from '../core/voxels/voxel-model';
import type { Voxels } from '../core/voxels/voxels';
import { type TraitType, trait } from '../core/scene/traits';

export { VoxelModel } from '../core/voxels/voxel-model';
export { createVoxelModelShape } from '../core/voxels/voxel-model-collider';

/**
 * create a VoxelModel from a populated Voxels. scans the voxel data
 * to compute bounds, dimensions, voxel count, and a default origin at the
 * center of the bounding box. the Voxels should not be mutated after
 * this call.
 */
export function createVoxelModel(voxels: Voxels): VoxelModel {
    return new VoxelModel(voxels);
}

export const VoxelMeshTrait = trait('voxel-mesh', {
    /**
     * the VoxelModel to render. runtime-only, not persisted.
     * set this to assign a voxel model; null = nothing to render.
     * multiple traits can reference the same VoxelModel (shared geometry).
     */
    model: null as VoxelModel | null,

    /**
     * per-instance tint [r, g, b, a]. client-only. rgb multiplies the
     * albedo (white = no-op), a is opacity. [1,1,1,1] = untinted, opaque
     * (default). [1,0,0,1] = keep red, drop green/blue.
     */
    tint: [1, 1, 1, 1] as Vec4,

    /**
     * transient overlay [r, g, b, a]: rgb is the colour, a the strength,
     * applied as `mix(surface, rgb, a)` over the tint but under lighting.
     * [0,0,0,0] = none (default). client-only.
     */
    flash: [0, 0, 0, 0] as Vec4,

    /**
     * per-instance light [sky, r, g, b], each 0-1. client-only.
     *
     * auto-sampled each frame by the renderer from the room's voxel light
     * grid at the node's world position, so voxel meshes shade like the
     * voxels around them. combined in-shader as a floor on the per-corner
     * `meshLight` so a moving instance never goes darker than its origin
     * cell — useful while baked-mesh per-corner light is still placeholder
     * or for instances drifting between cells.
     */
    light: [0, 0, 0, 0] as Vec4,

    /**
     * emissive glow intensity 0-1. client-only.
     * added to final color for hit effects etc.
     */
    glow: 0,

    /**
     * skip voxel + sun lighting entirely; render the texture flat.
     * useful for icon/preview rendering. client-only.
     */
    unlit: false,

    /**
     * minimum voxel-light floor 0-1. applied as
     * `voxelLight = max(voxelLight, vec3(litMin))` so a mesh stays readable
     * in dim areas without going fully unlit. 0 = no floor (default).
     */
    litMin: 0,

    /**
     * screen-door fade 0-1. 0 = solid (default), 1 = fully invisible.
     * Fragments drop via `discard` against an interleaved-gradient
     * threshold — stays in the opaque pipeline, no sort/blend. client-only.
     */
    dither: 0,

    /**
     * whether this voxel mesh renders. false = skip; the slot stays
     * allocated so toggling is cheap. client-only.
     */
    visible: true,

    /** renderer-internal allocation state (includes the frustum-cull entry —
     *  see `VoxelMeshState.cull`). */
    _state: null as VoxelMeshState | null,
}, { persist: false });

/** instance type for VoxelMeshTrait */
export type VoxelMeshTrait = TraitType<typeof VoxelMeshTrait>;
