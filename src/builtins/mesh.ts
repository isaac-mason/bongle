// MeshTrait, single-mesh visual, primitive for model rendering.
//
// Sits on a node with a TransformTrait. The renderer (model-visuals, W3.2)
// allocates an instance slot per (MeshTrait, TransformTrait) pair, then
// streams worldMatrix + atlas region into the GPU instance buffer.
//
// meshId is a compound { modelId, meshName } struct (replicated). The
// visual fields (tint/light/glow) are client-only, set by user scripts,
// not synced, not editor-editable, not persisted.

import { type Vec4, vec4 } from 'mathcat';
import type { MeshId } from '../core/models/handle';
import { pack } from '../core/scene/pack';
import { prop } from '../core/scene/prop';
import { control, sync, type TraitType, trait } from '../core/scene/traits';
import type { MeshVisualState } from '../render/models/model-visuals';

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
     * Voxel light contribution [sky, r, g, b], each 0-1. Client-only.
     *
     * Auto-sampled each frame by the renderer from the room's voxel light
     * grid at the node's world position, so meshes shade like adjacent
     * voxels. Combined in-shader as `max(blockRGB, sky*skyBrightness)`,
     * then modulated by sun-shading with an ambient floor, same formula
     * as the voxel material. User code can override via `setMeshLight()`
     * but the next frame's auto-sample will overwrite it.
     */
    light: [0, 0, 0, 0] as Vec4,

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
     * Whether this mesh renders. false = skip; the slot stays allocated
     * (no re-upload churn on toggle). applies to the whole mesh slot,
     * not to individual sub-meshes within `meshId`. client-only.
     */
    visible: true,

    /**
     * version counter, bumped by the setters when tint/light/glow change.
     * the renderer caches the version observed at last upload and re-uploads
     * only on mismatch.
     */
    _version: 0,

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

/** set per-instance tint (rgb target, a intensity) and flag the renderer
 *  to re-upload params. */
export function setMeshTint(t: MeshTrait, v: Vec4): void {
    vec4.copy(t.tint, v);
    t._version++;
}

/** set the transient flash overlay [r,g,b,a] (rgb colour, a strength) and
 *  flag the renderer to re-upload params. */
export function setMeshFlash(t: MeshTrait, v: Vec4): void {
    vec4.copy(t.flash, v);
    t._version++;
}

/** set per-instance voxel light contribution and flag the renderer. */
export function setMeshLight(t: MeshTrait, v: Vec4): void {
    vec4.copy(t.light, v);
    t._version++;
}

/** set per-instance self-illumination (0-1; lights the mesh in its own colour,
 *  no white wash) and flag the renderer. */
export function setMeshGlow(t: MeshTrait, v: number): void {
    t.glow = v;
    t._version++;
}

/** opt out of voxel + sun lighting; render the texture flat. */
export function setMeshUnlit(t: MeshTrait, v: boolean): void {
    t.unlit = v;
    t._version++;
}

/** set the voxel-light floor (0-1). 0 = no floor; 1 = effectively self-lit. */
export function setMeshLitMin(t: MeshTrait, v: number): void {
    t.litMin = v;
    t._version++;
}

/** set the screen-door fade (0-1). 0 = solid; 1 = fully invisible. */
export function setMeshDither(t: MeshTrait, v: number): void {
    t.dither = v;
    t._version++;
}
