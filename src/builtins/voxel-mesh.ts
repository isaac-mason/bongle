import type { Vec4 } from 'math';
import { type TraitType } from '../core/scene/traits';
import { trait } from '../core/registry';
import { VoxelModel } from '../core/voxels/voxel-model';
import type { Voxels } from '../core/voxels/voxels';
import type { VoxelMeshState } from '../render/voxels/voxel-mesh-visuals';

export { VoxelModel } from '../core/voxels/voxel-model';
export { createVoxelModelShape } from '../core/voxels/voxel-model-collider';

/**
 * create a VoxelModel from a populated Voxels, computing bounds, dimensions,
 * voxel count, and a default origin at the center of the bounding box.
 * The Voxels should not be mutated after this call.
 */
export function createVoxelModel(voxels: Voxels): VoxelModel {
    return new VoxelModel(voxels);
}

export const VoxelMeshTrait = trait(
    'voxel-mesh',
    {
        /** VoxelModel to render, runtime-only. Multiple traits can reference the same model (shared geometry). */
        model: null as VoxelModel | null,

        /** per-instance tint [r, g, b, a]: rgb is the recolour target, a the intensity (0 = untouched, 1 = full, lightness-preserving). Client-only. */
        tint: [1, 1, 1, 1] as Vec4,

        /** transient overlay [r, g, b, a], applied as `mix(surface, rgb, a)` over the tint but under lighting. [0,0,0,0] = none. Client-only. */
        flash: [0, 0, 0, 0] as Vec4,

        /** emissive glow intensity 0-1, added to final color. Client-only. */
        glow: 0,

        /** skip voxel + sun lighting entirely, render the texture flat. Client-only. */
        unlit: false,

        /** minimum voxel-light floor 0-1, `voxelLight = max(voxelLight, vec3(litMin))`. */
        litMin: 0,

        /** screen-door fade 0-1, fragments drop via `discard` against an interleaved-gradient threshold. Stays in the opaque pipeline. Client-only. */
        dither: 0,

        /**
         * per-instance outline, drawn as an expanded shell behind the mesh and masked to the rim by depth.
         * Square-cornered: each face grows one `width` along its normal and its in-plane axes.
         * `enabled` rather than `width: 0` so a configured width survives being toggled off. Client-only.
         */
        outline: {
            enabled: false,
            /** thickness, in the units `space` selects. */
            width: 1,
            /** 'screen' holds a constant pixel thickness at any distance; 'world' shrinks with distance like geometry. */
            space: 'screen' as 'screen' | 'world',
            color: [0, 0, 0, 1] as Vec4,
        },

        /** whether this voxel mesh renders; the slot stays allocated when false. Client-only. */
        visible: true,

        /** renderer-internal allocation state. */
        _state: null as VoxelMeshState | null,
    },
    { persist: false },
);

export type VoxelMeshTrait = TraitType<typeof VoxelMeshTrait>;
