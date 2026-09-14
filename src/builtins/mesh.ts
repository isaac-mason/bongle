// MeshTrait, single-mesh visual, primitive for model rendering.
//
// Sits on a node with a TransformTrait. The renderer (mesh-visuals, W3.2)
// allocates an instance slot per (MeshTrait, TransformTrait) pair, then
// streams worldMatrix + atlas region into the GPU instance buffer.
//
// meshId is a compound { modelId, meshName } struct (replicated). The
// visual fields (tint/glow) are client-only, set by user scripts,
// not synced, not editor-editable, not persisted.

import type { Vec4 } from 'math';
import type { MeshId } from '../core/models/handle';
import { control, sync, trait } from '../core/registry';
import { pack } from '../core/scene/pack';
import { prop } from '../core/scene/prop';
import type { TraitType } from '../core/scene/traits';
import type { MeshVisualState } from '../render/mesh/mesh-visuals';

export const MeshTrait = trait('mesh', {
    /**
     * Compound mesh ref { modelId: string, meshName: string }.
     * modelId is the user id from `model('wizard', { src })`.
     * Set this to swap meshes: `mesh.meshId = wizard.meshes.HatA.id`.
     * null = empty trait (renders nothing; reserves no slot).
     */
    meshId: null as MeshId | null,

    /**
     * Per-instance tint [r, g, b, a]. rgb is the recolour target, a the
     * intensity (0 = untouched, 1 = full, lightness-preserving); never
     * changes coverage. Persistent recolour: team colours, biome. Client-only.
     */
    tint: [1, 1, 1, 1] as Vec4,

    /**
     * Transient overlay [r, g, b, a]: rgb is the colour, a the strength,
     * applied as `mix(surface, rgb, a)` over the tint but under lighting.
     * For damage flashes, charge-ups. [0,0,0,0] = none (default). Client-only.
     */
    flash: [0, 0, 0, 0] as Vec4,

    /**
     * Self-illumination 0-1. Client-only. Raises the lighting floor so the
     * mesh lights up in its OWN colour (1 = fully lit, shadow-free), it does
     * NOT add white. A brighter, script-driven sibling of `litMin`.
     */
    glow: 0,

    /**
     * Skip voxel + sun lighting entirely; render the texture flat.
     * Useful for UI overlays, icon meshes, hologram-style FX. Client-only.
     */
    unlit: false,

    /**
     * Minimum voxel-light floor 0-1. Applied as `voxelLight = max(voxelLight, vec3(litMin))`
     * so a mesh stays readable in dim areas without going fully unlit.
     * 0 = no floor (default), 1 = effectively self-lit. Client-only.
     */
    litMin: 0,

    /**
     * Screen-door fade 0-1. 0 = solid (default), 1 = fully invisible.
     * Fragments are dropped via `discard` against an interleaved-gradient
     * threshold, so this stays in the opaque pipeline, no sort, no blend.
     * The cost is "pixelly," not smooth alpha. Drive from script (e.g.
     * fade out a character mesh when the camera is inside it). Client-only.
     */
    dither: 0,

    /**
     * Per-instance outline, drawn as an expanded shell behind the mesh and
     * masked by a stencil so it only shows where the mesh itself did not.
     *
     * `width` is in SCREEN pixels, held constant with distance: a world-space
     * width goes sub-pixel far away and the outline silently disappears, which
     * is the opposite of what an outline is for.
     *
     * `enabled` rather than `width: 0` so a configured width survives being
     * toggled off, which is what a hover or selection highlight wants.
     * Client-only.
     */
    outline: {
        enabled: false,
        /** thickness, in the units `space` selects. */
        width: 1,
        /**
         * What `width` measures.
         *
         * 'screen' holds the outline at a constant PIXEL thickness however far away
         * the mesh is, which keeps it readable and is what a highlight or a
         * pixel-art look wants.
         *
         * 'world' measures in world units, so the outline shrinks with distance
         * like real geometry and scales with the object - a large mesh gets a
         * proportionally larger outline. This is what Godot's `grow` does.
         *
         * Note the two read `width` on completely different scales: 2 is a
         * comfortable outline in pixels and an enormous one in world units.
         */
        space: 'screen' as 'screen' | 'world',
        color: [0, 0, 0, 1] as Vec4,
    },

    /**
     * Whether this mesh renders. false = skip; the slot stays allocated
     * (no re-upload churn on toggle). applies to the whole mesh slot,
     * not to individual sub-meshes within `meshId`. client-only.
     */
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
