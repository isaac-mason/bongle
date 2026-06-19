/**
 * Script-facing imperative ops on an AABB body — a small namespace over an
 * `AabbBodyTrait`'s live `.body`, mirroring crashcat's `rigidBody.*` shape so
 * physics verbs don't pollute the top-level `bongle` namespace.
 *
 * Re-exported as the `aabbBody` namespace from the package index:
 *
 *   import { aabbBody, AabbBodyTrait } from 'bongle';
 *   const body = getTrait(node, AabbBodyTrait).body;
 *   aabbBody.setVelocity(ctx.physics.aabb, body, vx, vy, vz); // wakes the body
 *
 * The trait owns construction (`addTrait(node, AabbBodyTrait, {...})`) and the
 * declarative knobs (halfExtents, collisionMask, gravityFactor…); this namespace
 * is for the per-tick imperative pokes the trait can't express.
 */
export { setBodyVelocity as setVelocity } from '../core/physics/aabb-physics';
