// shared crashcat world settings + layer constants.
//
// extracted from physics.ts so subsystems (aabb-physics, vcc, body-shape-sweep,
// editor tooling) can import object-layer constants without pulling in the
// full physics module. registerShapes runs at module init, first import
// wins, subsequent imports are no-ops.

import {
    ALL_SHAPE_DEFS,
    addBroadphaseLayer,
    addObjectLayer,
    createWorldSettings,
    enableCollision,
    registerShapes,
} from 'crashcat';
import { voxelPhysicsShapeDef } from '../voxels/voxel-physics-shape';

registerShapes([...ALL_SHAPE_DEFS, voxelPhysicsShapeDef]);
export const settings = createWorldSettings();
settings.gravity[1] = -9.81;

export const BROADPHASE_LAYER_MOVING = addBroadphaseLayer(settings);
export const BROADPHASE_LAYER_NOT_MOVING = addBroadphaseLayer(settings);
export const BROADPHASE_LAYER_EDITOR_NODES = addBroadphaseLayer(settings);

export const OBJECT_LAYER_NODE_MOVING = addObjectLayer(settings, BROADPHASE_LAYER_MOVING);
export const OBJECT_LAYER_NODE_NOT_MOVING = addObjectLayer(settings, BROADPHASE_LAYER_NOT_MOVING);
export const OBJECT_LAYER_VOXELS = addObjectLayer(settings, BROADPHASE_LAYER_NOT_MOVING);
export const OBJECT_LAYER_EDITOR_NODES = addObjectLayer(settings, BROADPHASE_LAYER_EDITOR_NODES);
/** kinematic shadow bodies for AabbBodies that opt into `rigidBodyImpostor`.
 *  AABB-native clients (VCC, AabbPhysics.World itself) explicitly ignore this
 *  layer; only external crashcat-managed bodies see impostors. */
export const OBJECT_LAYER_AABB_IMPOSTOR = addObjectLayer(settings, BROADPHASE_LAYER_MOVING);

// crashcat collision groups (the per-body groups/mask bitfields, distinct from
// the baked object layers above). the engine reserves the low bits to tag its
// own bodies, the voxel terrain body and node rigid bodies, so games can
// filter against them; games use 1 << 2 and up for their own groups.
export const COLLISION_GROUP_VOXELS = 1 << 0;
export const COLLISION_GROUP_NODES = 1 << 1;

enableCollision(settings, OBJECT_LAYER_NODE_MOVING, OBJECT_LAYER_VOXELS);
enableCollision(settings, OBJECT_LAYER_NODE_MOVING, OBJECT_LAYER_NODE_MOVING);
enableCollision(settings, OBJECT_LAYER_NODE_MOVING, OBJECT_LAYER_NODE_NOT_MOVING);
enableCollision(settings, OBJECT_LAYER_NODE_NOT_MOVING, OBJECT_LAYER_VOXELS);
// impostors collide with external rigid bodies, but NOT with each other,
// aabb-vs-aabb is handled analytically inside the AabbPhysics.World.
enableCollision(settings, OBJECT_LAYER_AABB_IMPOSTOR, OBJECT_LAYER_NODE_MOVING);
enableCollision(settings, OBJECT_LAYER_AABB_IMPOSTOR, OBJECT_LAYER_NODE_NOT_MOVING);
enableCollision(settings, OBJECT_LAYER_AABB_IMPOSTOR, OBJECT_LAYER_VOXELS);
