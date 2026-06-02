// Rig contract for player avatars. Shared between the engine runtime
// and the platform's upload worker.
//
// v1 supports a single rig type — `6bone` — sized for Minecraft-style
// humanoids: a waist hub with body/head/arm_left/arm_right/leg_left/
// leg_right siblings. Future rig types (`12bone`, creature-rigs, …) get
// sibling exports and a new tag value; the `rig_type` column on the
// avatar row is free text — no enum migration required.
//
// Avatars are origined so the feet sit at world y=0; no `avatar_root`
// wrapper is required — bones may sit at scene root or under whatever
// parent the authoring tool produces. The validator only enforces that
// the required bones are present somewhere reachable in the scene.
//
// TRS rest pose, channel scope, scale/triangle/texture caps are
// authoring guidance documented in plan-avatars.md but not enforced
// at upload yet. The 5MB total-bytes cap is the real abuse ceiling.
//
// Intentionally no `@gltf-transform/core` dep here — keeps this module
// trivially testable + reusable. Worker adapts its parsed gltf
// `Document` into the `RigSceneView` shape below.

/* ── tags ── */

export const RIG_TYPE_6BONE = '6bone';

/* ── 6bone constants ── */

/** Nodes the validator requires by exact name. Missing any → reject.
 *  Naming convention: `<part>_<side>` (e.g. `arm_left`, not `left_arm`)
 *  so the long form sorts by part in editors / consoles. */
export const RIG_6BONE_REQUIRED_NODES = [
    'waist',
    'body',
    'head',
    'arm_left',
    'arm_right',
    'leg_left',
    'leg_right',
] as const;

/** Optional attach-point empties. Avatars may include them; nothing
 *  breaks if they're missing. Documented here so creators have one
 *  source of truth for the names. */
export const RIG_6BONE_ATTACH_NODES = [
    'back',
    'hand_left',
    'hand_right',
] as const;

/** Height bounds (metres) — referenced by the post-v1 validator,
 *  not enforced in v1. Listed here so the eventual extension has a
 *  single source of truth. */
export const RIG_6BONE_MAX_HEIGHT_M = 3.0;
export const RIG_6BONE_MIN_HEIGHT_M = 0.5;

/** Reserved clip names. An avatar that ships a clip at any of these
 *  names registers a per-state locomotion override; whatever it
 *  doesn't ship falls back to `builtin:avatar`. Names map 1:1 to
 *  `CharacterTrait` locomotion state fields — no state→clip
 *  indirection. Additive: appending here doesn't break existing
 *  avatars (their bytes + DB rows are immutable; new uploads pick
 *  up the expanded list). */
export const RIG_6BONE_LOCOMOTION_CLIPS = ['idle', 'walk'] as const;

export type Rig6BoneLocomotionClip = (typeof RIG_6BONE_LOCOMOTION_CLIPS)[number];

/* ── validator surface ── */

/** Minimal tree shape the validator needs. The worker builds this
 *  by walking its gltf-transform `Document`; tests build it inline. */
export type RigNodeView = {
    readonly name: string;
    readonly children: readonly RigNodeView[];
};

export type RigSceneView = {
    readonly roots: readonly RigNodeView[];
};

export type ValidationResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly errors: readonly string[] };

/** v1: required-node presence only.
 *  Post-v1 extends to height bounds, triangle/texture caps, TRS rest
 *  pose, and channel scope. */
export function validateRig6Bone(scene: RigSceneView): ValidationResult {
    const errors: string[] = [];

    // Walk every scene root so required bones may sit anywhere in the
    // scene — Blockbench-style exports stash the legs as their own scene
    // roots, hierarchical rigs nest everything under one root.
    const present = new Set<string>();
    const walk = (n: RigNodeView): void => {
        present.add(n.name);
        for (const c of n.children) walk(c);
    };
    for (const r of scene.roots) walk(r);

    for (const name of RIG_6BONE_REQUIRED_NODES) {
        if (!present.has(name)) errors.push(`missing required node '${name}'`);
    }

    return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
