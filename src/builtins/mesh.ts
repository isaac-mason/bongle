import type { Vec4 } from 'math';
import type { MeshId } from '../core/models/handle';
import { control, sync, trait } from '../core/registry';
import { pack } from '../core/scene/pack';
import { prop } from '../core/scene/prop';
import type { TraitType } from '../core/scene/traits';
import type { MeshVisualState } from '../render/mesh/mesh-visuals';

export const MeshTrait = trait('mesh', {
    /** compound mesh ref { modelId, meshName }. modelId is the user id from `model('wizard',
     *  { src })`. set to swap meshes: `mesh.meshId = wizard.meshes.HatA.id`. null renders nothing. */
    meshId: null as MeshId | null,

    /** per-instance tint [r, g, b, a]: rgb is the recolour target, a the intensity (0 =
     *  untouched, 1 = full, lightness-preserving). persistent recolour: team colours, biome. Client-only. */
    tint: [1, 1, 1, 1] as Vec4,

    /** transient overlay [r, g, b, a]: rgb is the colour, a the strength, applied as
     *  `mix(surface, rgb, a)` over the tint but under lighting. for damage flashes, charge-ups. Client-only. */
    flash: [0, 0, 0, 0] as Vec4,

    /** self-illumination 0-1: raises the lighting floor so the mesh lights up in its own
     *  colour (1 = fully lit, shadow-free) rather than adding white. Client-only. */
    glow: 0,

    /** skip voxel + sun lighting entirely; render the texture flat. for UI overlays, icon
     *  meshes, hologram-style FX. Client-only. */
    unlit: false,

    /** minimum voxel-light floor 0-1, applied as `voxelLight = max(voxelLight, vec3(litMin))`
     *  so a mesh stays readable in dim areas without going fully unlit. Client-only. */
    litMin: 0,

    /** screen-door fade 0-1 (0 = solid, 1 = invisible). fragments are dropped via `discard`
     *  against an interleaved-gradient threshold, so this stays in the opaque pipeline, no
     *  sort, no blend, at the cost of a pixelly rather than smooth fade. Client-only. */
    dither: 0,

    /** per-instance outline, drawn as an expanded shell behind the mesh and masked by a
     *  stencil so it only shows where the mesh itself did not. `enabled` rather than `width: 0`
     *  so a configured width survives being toggled off. Client-only. */
    outline: {
        enabled: false,
        /** thickness, in the units `space` selects. */
        width: 1,
        /** what `width` measures: 'screen' holds a constant pixel thickness regardless of
         *  distance (a highlight or pixel-art look); 'world' shrinks with distance like real
         *  geometry and scales with the object (Godot's `grow`). the two read `width` on
         *  different scales: 2 is a comfortable outline in pixels, enormous in world units. */
        space: 'screen' as 'screen' | 'world',
        color: [0, 0, 0, 1] as Vec4,
    },

    /** whether this mesh renders; false skips it but keeps the slot allocated (no re-upload
     *  churn on toggle). applies to the whole mesh slot, not individual sub-meshes. Client-only. */
    visible: true,

    /** renderer-internal allocation state (includes the frustum-cull entry,
     *  see `MeshVisualState.cull`). */
    _state: null as MeshVisualState | null,
});

export type MeshTrait = TraitType<typeof MeshTrait>;

control(MeshTrait, 'meshId', {
    label: 'Mesh',
    schema: prop.mesh(),
    get: (t) => t.meshId,
    set: (t, v) => {
        t.meshId = v;
    },
});

sync(MeshTrait, 'meshId', {
    schema: pack.meshId(),
    pack: (t) => t.meshId,
    unpack: (v, t) => {
        t.meshId = v;
    },
});
