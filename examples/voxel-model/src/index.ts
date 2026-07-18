import { blocks } from 'bongle/kit';
import {
    addChild,
    addTrait,
    BLOCK_FLAG_LIQUID,
    configureFloodFillLighting,
    createNode,
    createVoxelModelShape,
    env,
    getBlockState,
    getTrait,
    MotionType,
    objectLayerForMotionType,
    onInit,
    onJoin,
    onPrePhysicsStep,
    RigidBodyTrait,
    scene,
    script,
    setBlock,
    setPosition,
    TransformTrait,
    trait,
    VoxelMeshTrait,
    VoxelModel,
} from 'bongle';
import * as crashcat from 'crashcat';
import type { Vec3 } from 'mathcat';

// ── scenes ──────────────────────────────────────────────────────────
// the `model` scene is authored in the editor — drop blocks into it and
// they become the rigid body's voxel model. loaded on both sides so
// client and server can each construct their own VoxelModel + shape.
const ModelScene = scene('model');

// ── blocks ──────────────────────────────────────────────────────────

const stoneKey = blocks.stone.defaultKey();
const waterKey = blocks.water.max();

// ── pool dimensions ─────────────────────────────────────────────────
// basin spans [-POOL_HALF, POOL_HALF] in x/z. floor at y=0, walls rise
// POOL_WALL_H above. water fills the basin to the brim (y=POOL_WALL_H).
// outer perimeter floor at y=POOL_WALL_H gives the player a walkway
// around the pool, extending OUTER_PAD cells beyond the wall.
const POOL_HALF = 12;
const POOL_WALL_H = 8;
const OUTER_PAD = 12;

// ── terrain ─────────────────────────────────────────────────────────

const TerrainTrait = trait('terrain');

script(TerrainTrait, 'generate', (ctx) => {
    if (!env.server) return;
    onInit(ctx, () => {
        configureFloodFillLighting(ctx, { enabled: false });

        // stone floor
        for (let x = -POOL_HALF; x <= POOL_HALF; x++) {
            for (let z = -POOL_HALF; z <= POOL_HALF; z++) {
                setBlock(ctx.voxels, x, 0, z, stoneKey);
            }
        }
        // four stone walls
        for (let y = 1; y <= POOL_WALL_H; y++) {
            for (let i = -POOL_HALF; i <= POOL_HALF; i++) {
                setBlock(ctx.voxels, i, y, -POOL_HALF, stoneKey);
                setBlock(ctx.voxels, i, y, POOL_HALF, stoneKey);
                setBlock(ctx.voxels, -POOL_HALF, y, i, stoneKey);
                setBlock(ctx.voxels, POOL_HALF, y, i, stoneKey);
            }
        }
        // water fill — interior of the basin to the brim
        for (let y = 1; y <= POOL_WALL_H; y++) {
            for (let x = -POOL_HALF + 1; x < POOL_HALF; x++) {
                for (let z = -POOL_HALF + 1; z < POOL_HALF; z++) {
                    setBlock(ctx.voxels, x, y, z, waterKey);
                }
            }
        }
        // outer perimeter walkway at wall height — skips the pool interior
        // so the basin remains open from above.
        const outer = POOL_HALF + OUTER_PAD;
        for (let x = -outer; x <= outer; x++) {
            for (let z = -outer; z <= outer; z++) {
                if (Math.abs(x) <= POOL_HALF && Math.abs(z) <= POOL_HALF) continue;
                setBlock(ctx.voxels, x, POOL_WALL_H, z, stoneKey);
            }
        }
    });
});

// ── voxel-drop trait ────────────────────────────────────────────────
// installs a VoxelMeshTrait on the client (visuals) and a RigidBodyTrait
// on the server (collision + buoyancy). both sides build a VoxelModel
// from the same ModelScene voxels.

const VoxelDropTrait = trait('voxel-drop', {}, { persist: false });

// shared model+shape per process. every instance of VoxelDropTrait
// references the same VoxelModel, and the server reuses the same shape.
let sharedModel: VoxelModel | null = null;
let sharedShape: ReturnType<typeof createVoxelModelShape> = null;

function ensureShared(): boolean {
    if (sharedModel) return true;
    const voxels = ModelScene.voxels;
    if (!voxels) return false;
    sharedModel = new VoxelModel(voxels);
    // build the collision shape on BOTH sides. on the server it backs the
    // dynamic body; on the client it backs the kinematic shadow body that
    // VCC (and other rigid bodies) collide against. without the client-
    // side shape the synced RigidBodyTrait installs as an empty hull and
    // the player walks through the boat.
    sharedShape = createVoxelModelShape(sharedModel);
    return true;
}

// model-local half-height in y, used to find the boat's bottom face
// in world space. DOFs lock pitch/roll so the body's local y stays
// aligned with world y — no rotation math needed.
function modelHalfHeight(model: VoxelModel): number {
    return (model.boundsMax[1] - model.boundsMin[1]) / 2;
}

script(VoxelDropTrait, 'drop', (ctx) => {
    // ModelScene.voxels is null until the scene loads (on the server: at
    // room boot; on the client: when the server pushes the scene). onInit
    // can fire before that, so install lazily in onPrePhysicsStep and
    // gate further work with `installed` so the (potentially expensive)
    // ensureShared / addTrait calls happen exactly once per side.
    let installed = false;
    let serverRb: RigidBodyTrait | null = null;
    let halfHeightY = 0;
    const force: Vec3 = [0, 0, 0];
    const impulse: Vec3 = [0, 0, 0];

    // tuning — these are knobs you'd typically expose as controls.
    const G = 9.81;
    // spring-like buoyancy. equilibrium is when buoyancy = gravity:
    //   mass * G = mass * G * STIFFNESS * depth  →  depth = 1/STIFFNESS
    // so STIFFNESS=1.25 means the boat's bottom rests 0.8 below the
    // waterline.
    const STIFFNESS = 1.25;
    const LINEAR_DRAG = 6.0; // per-second velocity damping in water

    // scripted nudges — every IMPULSE_INTERVAL_STEPS physics steps, push
    // the boat in a random horizontal direction. counted in steps rather
    // than seconds to avoid needing dt; @60Hz physics, 180 ≈ 3 seconds.
    const IMPULSE_INTERVAL_STEPS = 180;
    const IMPULSE_MAGNITUDE = 8.0; // m/s velocity kick at unit mass
    let stepsUntilImpulse = IMPULSE_INTERVAL_STEPS;

    onPrePhysicsStep(ctx, () => {
        if (!installed) {
            if (!ensureShared()) return;

            const transform = getTrait(ctx.node, TransformTrait)!;
            const world = ctx.physics.rigid.world;

            if (env.client) {
                addTrait(ctx.node, VoxelMeshTrait, { model: sharedModel });
                // RigidBodyTrait arrives via sync from the server in adopt
                // mode (def=null). build a kinematic shadow body around the
                // shared voxel shape so VCC (and other rigid bodies) collide
                // against the actual geometry.
                const rb = getTrait(ctx.node, RigidBodyTrait);
                if (!rb || !sharedShape) return;
                const body = crashcat.rigidBody.create(world, {
                    shape: sharedShape,
                    motionType: MotionType.KINEMATIC,
                    objectLayer: objectLayerForMotionType(MotionType.KINEMATIC),
                    position: transform.position,
                    quaternion: transform.quaternion,
                    userData: ctx.node.id,
                });
                rb.body = body;
                installed = true;
                return;
            }

            if (!sharedShape || !sharedModel) return;
            const rb = addTrait(ctx.node, RigidBodyTrait);
            rb.motionType = MotionType.DYNAMIC;
            rb.prediction = false;
            const body = crashcat.rigidBody.create(world, {
                shape: sharedShape,
                motionType: MotionType.DYNAMIC,
                objectLayer: objectLayerForMotionType(MotionType.DYNAMIC),
                position: transform.position,
                quaternion: transform.quaternion,
                userData: ctx.node.id,
                friction: 0.5,
                restitution: 0.2,
                // boat-style DOFs — translate freely, rotate only around Y (yaw).
                // locking pitch/roll keeps the body upright so the AABB-corner
                // submersion estimate stays well-conditioned and the body settles
                // flat on the water instead of tumbling.
                allowedDegreesOfFreedom: crashcat.dof(true, true, true, false, true, false),
            });
            rb.body = body;
            serverRb = rb;
            halfHeightY = modelHalfHeight(sharedModel);
            installed = true;
        }

        // ── server-side buoyancy ────────────────────────────────────
        // continuous depth model. find the water surface y in the column
        // directly under the boat by walking up from the bottom face until
        // we leave liquid; the spring force is proportional to how far the
        // boat's bottom sits below that surface. smooth (unlike a corner-
        // count fraction) so STIFFNESS gives clean control over ride height.
        if (!serverRb) return;
        const body = serverRb.body;
        if (!body) return;
        const flags = ctx.blocks.flags;

        const bottomY = body.position[1] - halfHeightY;
        const bx = Math.floor(body.position[0]);
        const bz = Math.floor(body.position[2]);

        // find the highest liquid block at or just below the boat's bottom.
        // surface y = top face of that block. if there is no liquid, bail.
        let surfaceY = -Infinity;
        const scanStart = Math.floor(bottomY) + 1;
        for (let yy = scanStart; yy >= scanStart - 16; yy--) {
            const sid = getBlockState(ctx.voxels, bx, yy, bz);
            if ((flags[sid]! & BLOCK_FLAG_LIQUID) !== 0) {
                surfaceY = yy + 1;
                break;
            }
        }
        if (surfaceY === -Infinity) return;

        const depth = surfaceY - bottomY;
        if (depth <= 0) return;

        const invMass = body.motionProperties.invMass;
        const mass = invMass > 0 ? 1 / invMass : 0;
        if (mass === 0) return;

        // upward spring force scaled by depth. cap at full submersion so
        // a body kicked far underwater can't accumulate runaway impulse.
        const effectiveDepth = Math.min(depth, halfHeightY * 2);
        force[0] = 0;
        force[1] = mass * G * STIFFNESS * effectiveDepth;
        force[2] = 0;
        crashcat.rigidBody.addForce(ctx.physics.rigid.world, body, force, true);

        // linear drag — F = -v * k * m, only while in water
        const v = body.motionProperties.linearVelocity;
        force[0] = -v[0] * LINEAR_DRAG * mass;
        force[1] = -v[1] * LINEAR_DRAG * mass;
        force[2] = -v[2] * LINEAR_DRAG * mass;
        crashcat.rigidBody.addForce(ctx.physics.rigid.world, body, force, false);

        // periodic horizontal nudge — applied as an impulse (instantaneous
        // velocity kick) in a random xz direction. scale by mass so the
        // resulting speed change is constant across boat sizes.
        stepsUntilImpulse--;
        if (stepsUntilImpulse <= 0) {
            stepsUntilImpulse = IMPULSE_INTERVAL_STEPS;
            const angle = Math.random() * Math.PI * 2;
            impulse[0] = Math.cos(angle) * IMPULSE_MAGNITUDE * mass;
            impulse[1] = 0;
            impulse[2] = Math.sin(angle) * IMPULSE_MAGNITUDE * mass;
            crashcat.rigidBody.addImpulse(ctx.physics.rigid.world, body, impulse);
        }
    });
});

// ── gameplay ────────────────────────────────────────────────────────

const GameplayTrait = trait('gameplay');

script(GameplayTrait, 'session', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        const node = createNode({ name: 'drop', persist: false });
        const t = addTrait(node, TransformTrait);
        setPosition(t, [0, POOL_WALL_H + 6, 0]);
        addTrait(node, VoxelDropTrait);
        addChild(ctx.node, node);
    });

    onJoin(ctx, ({ playerNode }) => {
        const t = getTrait(playerNode, TransformTrait)!;
        setPosition(t, [0, POOL_WALL_H + 2, POOL_HALF + 4]);
    });
});
