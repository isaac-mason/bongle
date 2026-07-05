// the curated script-facing `aabbBody.*` verb surface, mirroring crashcat's
// `rigidBody.*`. re-exports ONLY the public per-body verbs from `aabb-body.ts`,
// which also holds internal machinery (the step, trait sync, low-level
// `createBody`/impostor ops) that must not appear in the namespace. surfaced as
// `aabbBody` via the barrel's `export * as aabbBody`.

export {
    applyForce,
    applyImpulse,
    create,
    destroy,
    setHalfExtents,
    setMotionType,
    setPosition,
    setVelocity,
} from './aabb-body';
