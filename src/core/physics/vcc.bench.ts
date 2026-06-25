// ── vcc benchmark ───────────────────────────────────────────────────
//
// run with: pnpm vitest bench src/core/physics/vcc.bench.ts
//
// measures vcc.move() per-tick cost across scenarios that stress different
// stages of the pipeline (gather, solve, sweep). the headline question:
// is the VCC cheap enough to run on dozens of mobs per tick, or is it a
// single-character budget?
//
// every bench takes one tick at 60 Hz (deltaTime = 1/60). state is reset
// at the top of each iteration so per-iteration drift doesn't change the
// measurement (e.g. without reset, the falling character would eventually
// hit the floor and the bench would shift from in-air to grounded).

import {
    box,
    castShape,
    collideShape,
    createAllCollideShapeCollector,
    createClosestCastShapeCollector,
    createDefaultCastShapeSettings,
    createDefaultCollideShapeSettings,
    createWorld,
    filter as createFilter,
    MotionType,
    registerAllShapes,
    rigidBody,
    type World,
} from 'crashcat';
import type { Vec3 } from 'mathcat';
import { vec3 } from 'mathcat';
import { beforeAll, bench, describe } from 'vitest';
import { type BlockShape, cube } from '../voxels/block-collider';
import { buildBlockRegistry } from '../voxels/block-registry';
import { type BlockDef, type BlockTextureDef, CullType, MaterialType } from '../voxels/blocks';
import { createVoxelSweepHit, sweepAabbVsVoxels } from '../voxels/voxel-aabb-sweep';
import { CHUNK_SIZE, createChunk, createVoxels, setChunkBlock, type Voxels } from '../voxels/voxels';
import * as AabbPhysics from './aabb-physics';
import { OBJECT_LAYER_NODE_MOVING, OBJECT_LAYER_VOXELS, settings as physicsSettings } from './physics';
import * as vcc from './vcc';

beforeAll(() => {
    registerAllShapes();
});

// ── voxel registry (single solid cube block) ─────────────────────────

const SINGLE_STATE = {
    props: {},
    totalStates: 1,
    encode: () => 0,
    decode: () => ({}),
};

function texDef(id: string): BlockTextureDef {
    return { id, frames: [`textures/${id}.png`], fps: 1, interpolate: false };
}

function buildBenchRegistry() {
    const defs = new Map<string, BlockDef>();
    const handles = new Map<string, any>();
    const textures = new Map<string, BlockTextureDef>();

    const stoneShape: BlockShape = cube();
    const blocks: { id: string; shape?: BlockShape }[] = [{ id: 'stone', shape: stoneShape }];

    for (const b of blocks) {
        const tex = texDef(b.id);
        textures.set(b.id, tex);

        const def: BlockDef = {
            id: b.id,
            states: SINGLE_STATE as any,
            model: (() => ({ type: 'cube' as const, textures: { all: { texture: tex } } })) as any,
            cull: CullType.SOLID,
            material: MaterialType.OPAQUE,
            shape: b.shape,
        };
        defs.set(b.id, def);
        handles.set(b.id, {
            id: b.id,
            states: SINGLE_STATE,
            _def: def,
            _baseStateId: 0,
            _index: 0,
            totalStates: 1,
            stateId: () => 0,
            defaultId: () => 0,
            stateKey: () => b.id,
            defaultKey: () => b.id,
        });
    }

    return buildBlockRegistry(defs, handles, textures);
}

const registry = buildBenchRegistry();

// ── voxel world generators ──────────────────────────────────────────

function emptyVoxels(): Voxels {
    return createVoxels(registry);
}

/** single 16x1x16 floor at y=0 inside one chunk. */
function flatFloorVoxels(): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, -1, 0);
    voxels.chunks.set('0,-1,0', chunk);
    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            // floor at chunk-local y=15 → world y=-1, top face at y=0.
            setChunkBlock(chunk, x, CHUNK_SIZE - 1, z, 'stone', registry);
        }
    }
    return voxels;
}

/** flat floor + a wall along x=8 (world) blocking +X movement. */
function wallVoxels(): Voxels {
    const voxels = flatFloorVoxels();
    // wall chunk at 0,0,0 (world y=0..15, x=0..15, z=0..15).
    const wallChunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', wallChunk);
    for (let y = 0; y < 4; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            setChunkBlock(wallChunk, 8, y, z, 'stone', registry);
        }
    }
    return voxels;
}

/** flat floor + two walls forming a +X / +Z corner the character is pressing into. */
function cornerVoxels(): Voxels {
    const voxels = flatFloorVoxels();
    const wallChunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', wallChunk);
    for (let y = 0; y < 4; y++) {
        for (let i = 0; i < CHUNK_SIZE; i++) {
            setChunkBlock(wallChunk, 8, y, i, 'stone', registry);
            setChunkBlock(wallChunk, i, y, 8, 'stone', registry);
        }
    }
    return voxels;
}

/** ceiling + floor + walls — the "stuck on a wall with low ceiling" scenario. */
function tunnelVoxels(): Voxels {
    const voxels = flatFloorVoxels();
    const chunk = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', chunk);
    // walls at x=8 along the full chunk
    for (let y = 0; y < 4; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            setChunkBlock(chunk, 8, y, z, 'stone', registry);
        }
    }
    // ceiling at y=3 above the player path (world y=3, head at ~1.8)
    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < 8; x++) {
            setChunkBlock(chunk, x, 3, z, 'stone', registry);
        }
    }
    return voxels;
}

/** dense — every cell within a chunk filled (only AABB faces visible). */
function denseVoxels(): Voxels {
    const voxels = createVoxels(registry);
    const chunk = createChunk(0, -1, 0);
    voxels.chunks.set('0,-1,0', chunk);
    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                setChunkBlock(chunk, x, y, z, 'stone', registry);
            }
        }
    }
    // hollow out a 2x3x2 pocket so the character has somewhere to stand.
    setChunkBlock(chunk, 4, CHUNK_SIZE - 2, 4, 'air', registry);
    setChunkBlock(chunk, 5, CHUNK_SIZE - 2, 4, 'air', registry);
    setChunkBlock(chunk, 4, CHUNK_SIZE - 3, 4, 'air', registry);
    setChunkBlock(chunk, 5, CHUNK_SIZE - 3, 4, 'air', registry);
    setChunkBlock(chunk, 4, CHUNK_SIZE - 4, 4, 'air', registry);
    setChunkBlock(chunk, 5, CHUNK_SIZE - 4, 4, 'air', registry);
    return voxels;
}

// ── world / character helpers ───────────────────────────────────────

const HALF_EXTENTS: [number, number, number] = [0.3, 0.9, 0.3];
const MAX_SLOPE_ANGLE = (50 * Math.PI) / 180;
const DT = 1 / 60;

type Scenario = {
    world: World;
    voxels: Voxels;
    aabbWorld: AabbPhysics.World;
    vcc: vcc.VCC;
    /** initial position to reset to before each move(). */
    startX: number;
    startY: number;
    startZ: number;
    /** velocity to reset to before each move(). */
    velX: number;
    velY: number;
    velZ: number;
};

function makeScenario(opts: {
    voxels: Voxels;
    startX: number;
    startY: number;
    startZ: number;
    velX: number;
    velY: number;
    velZ: number;
    bodyCount?: number;
    bodyRadius?: number;
}): Scenario {
    const world = createWorld(physicsSettings);
    const v = vcc.create(world, opts.voxels, {
        halfExtents: HALF_EXTENTS,
        position: [opts.startX, opts.startY, opts.startZ],
        maxSlopeAngle: MAX_SLOPE_ANGLE,
    });

    if (opts.bodyCount && opts.bodyCount > 0) {
        // ring of static box bodies around the character — stresses body
        // overlap-gather + body-cast inside the sweep.
        const r = opts.bodyRadius ?? 1.5;
        for (let i = 0; i < opts.bodyCount; i++) {
            const a = (i / opts.bodyCount) * Math.PI * 2;
            rigidBody.create(world, {
                shape: box.create({ halfExtents: [0.4, 0.4, 0.4] }),
                position: [opts.startX + Math.cos(a) * r, opts.startY + 0.4, opts.startZ + Math.sin(a) * r],
                quaternion: [0, 0, 0, 1],
                motionType: MotionType.STATIC,
                objectLayer: OBJECT_LAYER_NODE_MOVING,
            });
        }
    }

    return {
        world,
        voxels: opts.voxels,
        aabbWorld: AabbPhysics.create(opts.voxels),
        vcc: v,
        startX: opts.startX,
        startY: opts.startY,
        startZ: opts.startZ,
        velX: opts.velX,
        velY: opts.velY,
        velZ: opts.velZ,
    };
}

function resetScenario(s: Scenario): void {
    vcc.setPosition(s.world, s.vcc, s.startX, s.startY, s.startZ);
    s.vcc.linearVelocity[0] = s.velX;
    s.vcc.linearVelocity[1] = s.velY;
    s.vcc.linearVelocity[2] = s.velZ;
}

// ── single-character benchmarks ─────────────────────────────────────

describe('vcc.move — single character', () => {
    const air = makeScenario({
        voxels: emptyVoxels(),
        startX: 0,
        startY: 10,
        startZ: 0,
        velX: 0,
        velY: -9.8 * DT,
        velZ: 0,
    });

    const grounded = makeScenario({
        voxels: flatFloorVoxels(),
        startX: 4,
        startY: 0,
        startZ: 4,
        velX: 4,
        velY: -9.8 * DT,
        velZ: 0,
    });

    const wall = makeScenario({
        voxels: wallVoxels(),
        // pressed up against the +X wall at x=8 (block face at world x=8).
        startX: 7.5,
        startY: 0,
        startZ: 4,
        velX: 4,
        velY: -9.8 * DT,
        velZ: 0,
    });

    const corner = makeScenario({
        voxels: cornerVoxels(),
        startX: 7.5,
        startY: 0,
        startZ: 7.5,
        // diagonal push into +X/+Z corner.
        velX: 4,
        velY: -9.8 * DT,
        velZ: 4,
    });

    const tunnel = makeScenario({
        voxels: tunnelVoxels(),
        startX: 7.5,
        startY: 0,
        startZ: 4,
        velX: 4,
        velY: 0,
        velZ: 0,
    });

    const dense = makeScenario({
        // dense pocket: stand at world (4.5, 13, 4.5). chunk at cy=-1 spans y=-16..-1; pocket starts y=-3.
        voxels: denseVoxels(),
        startX: 4.5,
        startY: -3,
        startZ: 4.5,
        velX: 1,
        velY: -9.8 * DT,
        velZ: 0,
    });

    const bodies5 = makeScenario({
        voxels: flatFloorVoxels(),
        startX: 4,
        startY: 0,
        startZ: 4,
        velX: 0,
        velY: -9.8 * DT,
        velZ: 0,
        bodyCount: 5,
    });

    const bodies20 = makeScenario({
        voxels: flatFloorVoxels(),
        startX: 4,
        startY: 0,
        startZ: 4,
        velX: 0,
        velY: -9.8 * DT,
        velZ: 0,
        bodyCount: 20,
    });

    bench('air (free fall, no contacts)', () => {
        resetScenario(air);
        vcc.move(air.world, air.voxels, air.aabbWorld, air.vcc, DT);
    });

    bench('grounded walk (flat voxel floor)', () => {
        resetScenario(grounded);
        vcc.move(grounded.world, grounded.voxels, grounded.aabbWorld, grounded.vcc, DT);
    });

    bench('wall press (walking into +X wall)', () => {
        resetScenario(wall);
        vcc.move(wall.world, wall.voxels, wall.aabbWorld, wall.vcc, DT);
    });

    bench('corner (pushing into 2-wall corner — edge slide)', () => {
        resetScenario(corner);
        vcc.move(corner.world, corner.voxels, corner.aabbWorld, corner.vcc, DT);
    });

    bench('tunnel (low ceiling + wall — head bonk + wall press)', () => {
        resetScenario(tunnel);
        vcc.move(tunnel.world, tunnel.voxels, tunnel.aabbWorld, tunnel.vcc, DT);
    });

    bench('dense voxels (surrounded on all sides)', () => {
        resetScenario(dense);
        vcc.move(dense.world, dense.voxels, dense.aabbWorld, dense.vcc, DT);
    });

    bench('5 nearby static bodies', () => {
        resetScenario(bodies5);
        vcc.move(bodies5.world, bodies5.voxels, bodies5.aabbWorld, bodies5.vcc, DT);
    });

    bench('20 nearby static bodies', () => {
        resetScenario(bodies20);
        vcc.move(bodies20.world, bodies20.voxels, bodies20.aabbWorld, bodies20.vcc, DT);
    });
});

// ── multi-character (mob crowd) benchmarks ──────────────────────────
//
// the headline number for "can we use VCC for mobs?" — N controllers in the
// same world calling move() each tick. all share one voxel floor so chunk
// caches stay warm. characters are spaced apart so they don't collide with
// each other (would skew toward worst-case body overlap).

function makeCrowd(n: number): { world: World; voxels: Voxels; aabbWorld: AabbPhysics.World; vccs: vcc.VCC[] } {
    const world = createWorld(physicsSettings);
    const voxels = flatFloorVoxels();
    const aabbWorld = AabbPhysics.create(voxels);
    const vccs: vcc.VCC[] = [];
    // 16x16 floor; spread N characters across it. for n>256 we wrap and they
    // overlap, which is realistic for tight mob crowds.
    const cols = Math.max(1, Math.floor(Math.sqrt(n)));
    for (let i = 0; i < n; i++) {
        const cx = (i % cols) * 1.0 + 0.5;
        const cz = Math.floor(i / cols) * 1.0 + 0.5;
        vccs.push(
            vcc.create(world, voxels, {
                halfExtents: HALF_EXTENTS,
                position: [cx, 0, cz],
                maxSlopeAngle: MAX_SLOPE_ANGLE,
            }),
        );
    }
    return { world, voxels, aabbWorld, vccs };
}

function tickCrowd(c: ReturnType<typeof makeCrowd>): void {
    for (let i = 0; i < c.vccs.length; i++) {
        const v = c.vccs[i]!;
        v.linearVelocity[0] = 0;
        v.linearVelocity[1] = -9.8 * DT;
        v.linearVelocity[2] = 0;
        vcc.move(c.world, c.voxels, c.aabbWorld, v, DT);
    }
}

describe('vcc.move — mob crowd (one tick)', () => {
    const c10 = makeCrowd(10);
    const c50 = makeCrowd(50);
    const c100 = makeCrowd(100);
    const c250 = makeCrowd(250);

    bench('10 mobs', () => tickCrowd(c10));
    bench('50 mobs', () => tickCrowd(c50));
    bench('100 mobs', () => tickCrowd(c100));
    bench('250 mobs', () => tickCrowd(c250));
});

// ── tickLike — full controller path (move + walkStairs + stickToFloor) ────
//
// mirrors what `tickCharacterController` does per tick:
//   1. resolve wishDir from camera + move axes
//   2. integrate vertical velocity (gravity / jump / grounded zero-out)
//   3. apply quake-style ground/air friction + accel
//   4. vcc.move() with a real listener (onContactSolve fires per body contact)
//   5. vcc.walkStairs() if grounded character was blocked short of wishDist
//   6. vcc.stickToFloor() if was-grounded but became airborne (no jump)
//
// this is what the real game pays per character; the plain `vcc.move` numbers
// above understate the per-tick cost by ~2–4× depending on world geometry
// because they skip the post-passes and the listener.

const _tl_forward = vec3.create();
const _tl_right = vec3.create();
const _tl_movementDir = vec3.create();
const _tl_newVel = vec3.create();
const _tl_horizVel = vec3.create();

let _tl_isIntentional = false;
const _tl_listener: vcc.VccListener = {
    onContactSolve(v, _body, _subShapeId, _contactPos, contactNormal, contactVelocity, characterVelocity, ioCharacterVelocity) {
        const inAir = v.groundState === vcc.GROUND_STATE_IN_AIR;
        const cvSq =
            contactVelocity[0] * contactVelocity[0] +
            contactVelocity[1] * contactVelocity[1] +
            contactVelocity[2] * contactVelocity[2];
        const isSteep = -contactNormal[1] < v.cosMaxSlopeAngle;
        const preventSlide = !inAir && !_tl_isIntentional && cvSq < 0.1 && !isSteep;
        if (preventSlide) {
            ioCharacterVelocity[0] = 0;
            ioCharacterVelocity[2] = 0;
            return;
        }
        if (contactNormal[1] < -0.3 && characterVelocity[1] > 0) {
            ioCharacterVelocity[1] = 0;
        }
    },
};

function _tl_applyHorizontalDrag(vel: Vec3, dragRate: number, dt: number): void {
    const k = Math.exp(-dragRate * dt);
    vel[0] *= k;
    vel[2] *= k;
}

function _tl_applyGroundWishAccel(vel: Vec3, dir: Vec3, dragRate: number, wishSpeed: number, dt: number): void {
    if (wishSpeed <= 0) return;
    const a = dragRate * wishSpeed * dt;
    vel[0] += dir[0] * a;
    vel[2] += dir[2] * a;
}

function _tl_applyAirWishAccel(vel: Vec3, dir: Vec3, airAccel: number, wishSpeed: number, dt: number): void {
    if (wishSpeed <= 0) return;
    const a = airAccel * dt;
    vel[0] += dir[0] * a;
    vel[2] += dir[2] * a;
}

/** controller-like config — defaults match CharacterControllerTrait. */
type CcConfig = {
    walkSpeed: number;
    sprintSpeed: number;
    jumpSpeed: number;
    terminalVelocity: number;
    gravity: number;
    stepHeight: number;
    groundDragRate: number;
    airDragRate: number;
    airAccel: number;
    sprintJumpImpulse: number;
};

const CC_DEFAULTS: CcConfig = {
    walkSpeed: 5,
    sprintSpeed: 8,
    jumpSpeed: 7,
    terminalVelocity: 40,
    gravity: 20,
    stepHeight: 0.55,
    groundDragRate: 12,
    airDragRate: 1,
    airAccel: 2,
    sprintJumpImpulse: 2,
};

type CcInput = {
    /** spherical camera; we only use theta (yaw, index 1). */
    cameraTheta: number;
    /** [strafe, forward] in [-1, 1] */
    move: [number, number];
    jump: boolean;
    sprint: boolean;
};

type CcState = {
    cfg: CcConfig;
    velocity: Vec3;
    grounded: boolean;
    stepSmoothOffset: number;
};

function makeCcState(cfg: Partial<CcConfig> = {}): CcState {
    return {
        cfg: { ...CC_DEFAULTS, ...cfg },
        velocity: vec3.create(),
        grounded: true,
        stepSmoothOffset: 0,
    };
}

/** mirror of tickCharacterController, but driven by a CcInput instead of traits. */
function tickLike(
    world: World,
    voxels: Voxels,
    aabbWorld: AabbPhysics.World,
    v: vcc.VCC,
    st: CcState,
    input: CcInput,
    dt: number,
): void {
    const cfg = st.cfg;
    const theta = input.cameraTheta;
    const strafe = input.move[0];
    const fwd = input.move[1];
    vec3.set(_tl_forward, -Math.sin(theta), 0, -Math.cos(theta));
    vec3.set(_tl_right, Math.cos(theta), 0, -Math.sin(theta));
    vec3.set(_tl_movementDir, _tl_forward[0] * fwd + _tl_right[0] * strafe, 0, _tl_forward[2] * fwd + _tl_right[2] * strafe);
    const movLen = vec3.length(_tl_movementDir);
    const isIntentional = movLen > 1e-6;
    if (isIntentional) vec3.scale(_tl_movementDir, _tl_movementDir, 1 / movLen);

    const wishSpeed = movLen * (input.sprint ? cfg.sprintSpeed : cfg.walkSpeed);
    const wasGrounded = st.grounded;
    const wantsJump = input.jump && wasGrounded;

    vec3.copy(_tl_newVel, st.velocity);
    const vertVel = _tl_newVel[1];
    vec3.copy(_tl_horizVel, _tl_newVel);
    _tl_horizVel[1] = 0;

    let newVert: number;
    if (wantsJump) {
        newVert = cfg.jumpSpeed - cfg.gravity * dt;
        if (input.sprint && isIntentional) {
            _tl_horizVel[0] += _tl_movementDir[0] * cfg.sprintJumpImpulse;
            _tl_horizVel[2] += _tl_movementDir[2] * cfg.sprintJumpImpulse;
        }
    } else if (wasGrounded) {
        newVert = 0;
    } else {
        newVert = Math.max(vertVel - cfg.gravity * dt, -cfg.terminalVelocity);
    }

    if (wantsJump || !wasGrounded) {
        _tl_applyHorizontalDrag(_tl_horizVel, cfg.airDragRate, dt);
        _tl_applyAirWishAccel(_tl_horizVel, _tl_movementDir, cfg.airAccel, wishSpeed, dt);
    } else {
        // add ground velocity (we don't model moving platforms here — zero).
        const gv = v.groundVelocity;
        _tl_horizVel[0] += gv[0];
        _tl_horizVel[2] += gv[2];
        _tl_applyHorizontalDrag(_tl_horizVel, cfg.groundDragRate, dt);
        _tl_applyGroundWishAccel(_tl_horizVel, _tl_movementDir, cfg.groundDragRate, wishSpeed, dt);
    }

    vec3.copy(_tl_newVel, _tl_horizVel);
    _tl_newVel[1] = newVert;

    // feet are already in v.position from the prior tick. push commanded velocity in.
    v.linearVelocity[0] = _tl_newVel[0];
    v.linearVelocity[1] = _tl_newVel[1];
    v.linearVelocity[2] = _tl_newVel[2];

    const startX = v.position[0];
    const startZ = v.position[2];

    _tl_isIntentional = isIntentional;
    vcc.move(world, voxels, aabbWorld, v, dt, _tl_listener);

    let grounded = v.groundState === vcc.GROUND_STATE_ON_GROUND;

    const wishDx = _tl_newVel[0] * dt;
    const wishDz = _tl_newVel[2] * dt;
    const wishSq = wishDx * wishDx + wishDz * wishDz;
    if (grounded && !wantsJump && cfg.stepHeight > 0 && wishSq > 1e-8) {
        const gotDx = v.position[0] - startX;
        const gotDz = v.position[2] - startZ;
        const gotSq = gotDx * gotDx + gotDz * gotDz;
        if (gotSq < wishSq * 0.99) {
            const remDx = wishDx - gotDx;
            const remDz = wishDz - gotDz;
            const preStepY = v.position[1];
            const stepped = vcc.walkStairs(world, voxels, aabbWorld, v, cfg.stepHeight, remDx, remDz, remDx, remDz, 0.05);
            if (stepped) {
                v.linearVelocity[0] = _tl_newVel[0];
                v.linearVelocity[2] = _tl_newVel[2];
                st.stepSmoothOffset -= v.position[1] - preStepY;
                if (st.stepSmoothOffset < -cfg.stepHeight) st.stepSmoothOffset = -cfg.stepHeight;
                else if (st.stepSmoothOffset > cfg.stepHeight) st.stepSmoothOffset = cfg.stepHeight;
            }
        }
    }

    if (wasGrounded && !grounded && !wantsJump && cfg.stepHeight > 0) {
        if (vcc.stickToFloor(world, voxels, aabbWorld, v, -cfg.stepHeight)) {
            grounded = true;
        }
    }

    st.grounded = grounded;
    st.velocity[0] = v.linearVelocity[0];
    st.velocity[1] = v.linearVelocity[1];
    st.velocity[2] = v.linearVelocity[2];
}

// ── realistic world ──────────────────────────────────────────────────
//
// stepped voxel terrain (3 layers of stairs) + a flat floor + 16 scattered
// static prop bodies. similar shape to a small playable area.

function steppedTerrainVoxels(): Voxels {
    const voxels = createVoxels(registry);
    // chunk at (0, -1, 0) — y=-16..-1, top face of full chunk at y=0
    const c = createChunk(0, -1, 0);
    voxels.chunks.set('0,-1,0', c);
    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            // floor: chunk-local y=15 → world y=-1
            setChunkBlock(c, x, CHUNK_SIZE - 1, z, 'stone', registry);
        }
    }
    // 3-step staircase along +X starting at world x=10. each step is 0.5 high
    // (achieved by setting two chunk-local y rows == one block; we use 1-block
    // rises here which still exercise stair logic with stepHeight=0.55).
    const top = createChunk(0, 0, 0);
    voxels.chunks.set('0,0,0', top);
    for (let z = 0; z < CHUNK_SIZE; z++) {
        // step 1 at x=10, height 1
        setChunkBlock(top, 10, 0, z, 'stone', registry);
        // step 2 at x=11, height 2 (but stepHeight=0.55 only allows 1-block step)
        setChunkBlock(top, 11, 0, z, 'stone', registry);
        // step 3 at x=12, height 1
        setChunkBlock(top, 12, 0, z, 'stone', registry);
    }
    return voxels;
}

function makeRealisticScenario(opts: { propCount: number; cameraTheta: number }): {
    world: World;
    voxels: Voxels;
    aabbWorld: AabbPhysics.World;
    vcc: vcc.VCC;
    state: CcState;
    startX: number;
    startY: number;
    startZ: number;
    input: CcInput;
} {
    const world = createWorld(physicsSettings);
    const voxels = steppedTerrainVoxels();
    const aabbWorld = AabbPhysics.create(voxels);
    const startX = 4;
    const startY = 0;
    const startZ = 4;
    const v = vcc.create(world, voxels, {
        halfExtents: HALF_EXTENTS,
        position: [startX, startY, startZ],
        maxSlopeAngle: MAX_SLOPE_ANGLE,
    });

    // scatter static prop bodies in a 12x12 area around the character.
    let seed = 1234;
    for (let i = 0; i < opts.propCount; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const px = (seed % 1200) / 100; // 0..12
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const pz = (seed % 1200) / 100;
        rigidBody.create(world, {
            shape: box.create({ halfExtents: [0.3, 0.3, 0.3] }),
            position: [px, 0.3, pz],
            quaternion: [0, 0, 0, 1],
            motionType: MotionType.STATIC,
            objectLayer: OBJECT_LAYER_NODE_MOVING,
        });
    }

    return {
        world,
        voxels,
        aabbWorld,
        vcc: v,
        state: makeCcState(),
        startX,
        startY,
        startZ,
        input: { cameraTheta: opts.cameraTheta, move: [0, 1], jump: false, sprint: false },
    };
}

function resetRealistic(s: ReturnType<typeof makeRealisticScenario>): void {
    vcc.setPosition(s.world, s.vcc, s.startX, s.startY, s.startZ);
    s.vcc.linearVelocity[0] = 0;
    s.vcc.linearVelocity[1] = 0;
    s.vcc.linearVelocity[2] = 0;
    s.state.velocity[0] = 0;
    s.state.velocity[1] = 0;
    s.state.velocity[2] = 0;
    s.state.grounded = true;
    s.state.stepSmoothOffset = 0;
}

describe('vcc.tickLike — full controller path', () => {
    // walking forward on flat-ish terrain, no nearby props.
    const idle = makeRealisticScenario({ propCount: 0, cameraTheta: 0 });
    idle.input.move = [0, 0];

    const walk0 = makeRealisticScenario({ propCount: 0, cameraTheta: 0 });
    const walk16 = makeRealisticScenario({ propCount: 16, cameraTheta: 0 });
    const walk64 = makeRealisticScenario({ propCount: 64, cameraTheta: 0 });

    // walking +X into the staircase — exercises walkStairs each tick.
    const stairs = makeRealisticScenario({ propCount: 0, cameraTheta: -Math.PI / 2 });

    // jump (wantsJump branch + air accel) on first tick.
    const jumping = makeRealisticScenario({ propCount: 0, cameraTheta: 0 });
    jumping.input = { cameraTheta: 0, move: [0, 1], jump: true, sprint: false };

    bench('idle (no movement, gravity zero-out, no stairs)', () => {
        resetRealistic(idle);
        tickLike(idle.world, idle.voxels, idle.aabbWorld, idle.vcc, idle.state, idle.input, DT);
    });

    bench('walking forward (flat, 0 props)', () => {
        resetRealistic(walk0);
        tickLike(walk0.world, walk0.voxels, walk0.aabbWorld, walk0.vcc, walk0.state, walk0.input, DT);
    });

    bench('walking forward (flat, 16 static props)', () => {
        resetRealistic(walk16);
        tickLike(walk16.world, walk16.voxels, walk16.aabbWorld, walk16.vcc, walk16.state, walk16.input, DT);
    });

    bench('walking forward (flat, 64 static props)', () => {
        resetRealistic(walk64);
        tickLike(walk64.world, walk64.voxels, walk64.aabbWorld, walk64.vcc, walk64.state, walk64.input, DT);
    });

    bench('walking into staircase (walkStairs every tick)', () => {
        resetRealistic(stairs);
        tickLike(stairs.world, stairs.voxels, stairs.aabbWorld, stairs.vcc, stairs.state, stairs.input, DT);
    });

    bench('jumping forward (air accel, no stairs/stick)', () => {
        resetRealistic(jumping);
        tickLike(jumping.world, jumping.voxels, jumping.aabbWorld, jumping.vcc, jumping.state, jumping.input, DT);
    });
});

// ── phase isolation ──────────────────────────────────────────────────
//
// per-tick budget breakdown. each bench targets ONE primitive that
// vcc.move calls (often multiple times per tick — voxel sweep up to
// `maxCollisionIterations` = 5, body overlap once per outer iter, body
// cast once per outer iter). multiplying these by the iter count gives
// the per-tick contribution.
//
// these tell us where to focus optimization:
//   - if voxel sweep dominates → look at `sweepAabbVsVoxels` cell loop
//   - if body overlap dominates → broadphase / object-layer split
//   - if solver dominates (it shouldn't) → constraint loop
//   - if listener overhead dominates → listener fast-paths

// shared sweep hit + filter for the body-only benches.
const _phaseSweepHit = createVoxelSweepHit();
const _phaseFilter = (() => {
    const w = createWorld(physicsSettings);
    const f = createFilter.forWorld(w);
    createFilter.disableObjectLayer(f, w.settings.layers, OBJECT_LAYER_VOXELS);
    return { world: w, filter: f };
})();

/** build a world with N static box props clustered in a 2-unit radius. */
function makeBodyWorld(n: number): { world: World; queryShape: ReturnType<typeof box.create> } {
    const world = createWorld(physicsSettings);
    let seed = 1234;
    for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const a = (seed % 6283) / 1000; // 0..2π
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const r = (seed % 200) / 100; // 0..2
        rigidBody.create(world, {
            shape: box.create({ halfExtents: [0.3, 0.3, 0.3] }),
            position: [Math.cos(a) * r, 0.3, Math.sin(a) * r],
            quaternion: [0, 0, 0, 1],
            motionType: MotionType.STATIC,
            objectLayer: OBJECT_LAYER_NODE_MOVING,
        });
    }
    const queryShape = box.create({ halfExtents: [0.4, 0.9, 0.4] });
    return { world, queryShape };
}

describe('vcc phase — voxel sweep (called up to 5× per move)', () => {
    const flat = flatFloorVoxels();
    const dense = denseVoxels();
    const wall = wallVoxels();

    bench('flat floor — short downward sweep (gravity)', () => {
        sweepAabbVsVoxels(flat, 4, 0.9, 4, 0.4, 0.9, 0.4, 0, -0.16, 0, _phaseSweepHit);
    });

    bench('flat floor — short horizontal sweep (walking)', () => {
        sweepAabbVsVoxels(flat, 4, 0.9, 4, 0.4, 0.9, 0.4, 0.083, 0, 0, _phaseSweepHit);
    });

    bench('flat floor — long horizontal sweep (sprint)', () => {
        sweepAabbVsVoxels(flat, 4, 0.9, 4, 0.4, 0.9, 0.4, 0.5, 0, 0, _phaseSweepHit);
    });

    bench('wall — sweep into +X wall', () => {
        sweepAabbVsVoxels(wall, 7.5, 0.9, 4, 0.4, 0.9, 0.4, 0.083, -0.16, 0, _phaseSweepHit);
    });

    bench('dense voxels — sweep through pocket', () => {
        sweepAabbVsVoxels(dense, 4.5, -2.1, 4.5, 0.4, 0.9, 0.4, 0.083, -0.16, 0, _phaseSweepHit);
    });
});

describe('vcc phase — body overlap (called once per outer iter)', () => {
    const collector = createAllCollideShapeCollector();
    const settings = createDefaultCollideShapeSettings();
    settings.maxSeparationDistance = 0.12; // matches vcc default
    const ID_QUAT: [number, number, number, number] = [0, 0, 0, 1];
    const ONE: Vec3 = [1, 1, 1];

    const w0 = makeBodyWorld(0);
    const w16 = makeBodyWorld(16);
    const w64 = makeBodyWorld(64);
    const w256 = makeBodyWorld(256);

    function runOverlap(scn: ReturnType<typeof makeBodyWorld>): void {
        collector.reset();
        collideShape(scn.world, collector, settings, scn.queryShape, [0, 0.9, 0], ID_QUAT, ONE, _phaseFilter.filter);
    }

    bench('overlap — 0 bodies', () => runOverlap(w0));
    bench('overlap — 16 bodies', () => runOverlap(w16));
    bench('overlap — 64 bodies', () => runOverlap(w64));
    bench('overlap — 256 bodies', () => runOverlap(w256));
});

describe('vcc phase — body cast (called once per outer iter)', () => {
    const collector = createClosestCastShapeCollector();
    const settings = createDefaultCastShapeSettings();
    const ID_QUAT: [number, number, number, number] = [0, 0, 0, 1];
    const ONE: Vec3 = [1, 1, 1];

    const w0 = makeBodyWorld(0);
    const w16 = makeBodyWorld(16);
    const w64 = makeBodyWorld(64);
    const w256 = makeBodyWorld(256);

    function runCast(scn: ReturnType<typeof makeBodyWorld>): void {
        collector.reset();
        castShape(
            scn.world,
            collector,
            settings,
            scn.queryShape,
            [0, 0, 0],
            ID_QUAT,
            ONE,
            [0.083, -0.16, 0],
            _phaseFilter.filter,
        );
    }

    bench('cast — 0 bodies', () => runCast(w0));
    bench('cast — 16 bodies', () => runCast(w16));
    bench('cast — 64 bodies', () => runCast(w64));
    bench('cast — 256 bodies', () => runCast(w256));
});

// ── solver isolation ─────────────────────────────────────────────────
//
// build a vcc + synthetic constraint set, call solveConstraints. tells
// us pure JS math cost — no broadphase, no voxel iteration.

describe('vcc phase — solver only (synthetic constraints)', () => {
    const world = createWorld(physicsSettings);
    const voxels = flatFloorVoxels();
    const v = vcc.create(world, voxels, {
        halfExtents: HALF_EXTENTS,
        position: [0, 0, 0],
        maxSlopeAngle: MAX_SLOPE_ANGLE,
    });

    function makeConstraint(nx: number, ny: number, nz: number, dist: number): vcc.VccConstraint {
        return {
            contact: vcc.createVccContact(),
            planeNormal: [nx, ny, nz],
            linearVelocity: [0, 0, 0],
            planeDistance: dist,
            projectedVelocity: 0,
            toi: 0,
            isSteepSlope: false,
        };
    }

    const oneFloor = [makeConstraint(0, 1, 0, 0)];
    const floorAndWall = [makeConstraint(0, 1, 0, 0), makeConstraint(-1, 0, 0, 0)];
    const corner = [makeConstraint(0, 1, 0, 0), makeConstraint(-1, 0, 0, 0), makeConstraint(0, 0, -1, 0)];
    const eight = [
        makeConstraint(0, 1, 0, 0),
        makeConstraint(-1, 0, 0, 0),
        makeConstraint(0, 0, -1, 0),
        makeConstraint(1, 0, 0, 0),
        makeConstraint(0, 0, 1, 0),
        makeConstraint(0, -1, 0, 0),
        makeConstraint(-0.7, 0.7, 0, 0),
        makeConstraint(0, 0.7, -0.7, 0),
    ];

    const out = vec3.create();
    const vel: Vec3 = [3, -0.16, 0];

    bench('solver — 1 constraint (floor)', () => {
        vcc.solveConstraints(world, v, vel, DT, oneFloor, out, undefined);
    });

    bench('solver — 2 constraints (floor + wall)', () => {
        vcc.solveConstraints(world, v, vel, DT, floorAndWall, out, undefined);
    });

    bench('solver — 3 constraints (corner)', () => {
        vcc.solveConstraints(world, v, vel, DT, corner, out, undefined);
    });

    bench('solver — 8 constraints (worst case)', () => {
        vcc.solveConstraints(world, v, vel, DT, eight, out, undefined);
    });
});

// ── listener overhead ────────────────────────────────────────────────

describe('vcc phase — listener overhead (same scenario, ±listener)', () => {
    const noListener = makeRealisticScenario({ propCount: 16, cameraTheta: 0 });
    const withListener = makeRealisticScenario({ propCount: 16, cameraTheta: 0 });

    bench('move w/o listener (16 props)', () => {
        resetRealistic(noListener);
        // commanded velocity (no input math, just the move call)
        noListener.vcc.linearVelocity[0] = 0;
        noListener.vcc.linearVelocity[1] = -9.8 * DT;
        noListener.vcc.linearVelocity[2] = 5;
        vcc.move(noListener.world, noListener.voxels, noListener.aabbWorld, noListener.vcc, DT);
    });

    bench('move w/ listener (16 props)', () => {
        resetRealistic(withListener);
        withListener.vcc.linearVelocity[0] = 0;
        withListener.vcc.linearVelocity[1] = -9.8 * DT;
        withListener.vcc.linearVelocity[2] = 5;
        _tl_isIntentional = true;
        vcc.move(withListener.world, withListener.voxels, withListener.aabbWorld, withListener.vcc, DT, _tl_listener);
    });
});
