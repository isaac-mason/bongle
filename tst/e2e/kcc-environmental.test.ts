// ── kcc environmental mechanics e2e ──────────────────────────────────
//
// covers the four character controller environment features:
//   - sneak-edge guard (block-level opt-out via sneakGuard:false)
//   - climbable blocks, MC-style (push wall to climb, sneak to grip)
//   - liquid swim (gravity replaced by liquidSink, jump ascends)
//   - material friction (ice slides further after input release)

import { afterEach, describe, expect, it } from 'vitest';
import {
    addTrait,
    block,
    blockPreset,
    CharacterControllerTrait,
    CullType,
    getTrait,
    onJoin,
    PlayerControllerTrait,
    removeTrait,
    script,
    setBlock,
    trait,
    TransformTrait,
    type Node,
} from 'bongle';
import { createTestHarness, type TestHarness } from './harness';

describe('kcc environmental mechanics', () => {
    let harness: TestHarness<unknown> | null = null;

    afterEach(() => {
        harness?.dispose();
        harness = null;
    });

    function defineTestBlocks() {
        block('stone', {
            model: () => ({ type: 'cube', textures: { all: { texture: 'stone' } } }),
        });
        block('ice', {
            model: () => ({ type: 'cube', textures: { all: { texture: 'ice' } } }),
            friction: 0.1,
            sneakGuard: false,
        });
        block('vines', {
            model: () => ({ type: 'cube', textures: { all: { texture: 'vines' } } }),
            cull: CullType.NONE,
            collision: false,
            climbable: true,
        });
        block('water', {
            model: () => ({ type: 'cube', textures: { all: { texture: 'water' } } }),
            cull: CullType.NONE,
            collision: false,
            liquid: { viscosity: 0.5 },
        });
    }

    function spawnAt(root: Node, pos: [number, number, number]) {
        const TestGameplayTrait = trait('test-gameplay', {}, { persist: false });
        script(TestGameplayTrait, 'session', (ctx) => {
            onJoin(ctx, ({ playerNode }) => {
                const transform = getTrait(playerNode, TransformTrait)!;
                transform.position = pos;
                // play-mode players auto-get PlayerControllerTrait, whose input
                // poll overwrites cc.input from (absent) real devices every
                // frame. these tests drive cc.input directly, so drop it.
                removeTrait(playerNode, PlayerControllerTrait);
                addTrait(playerNode, CharacterControllerTrait);
            });
        });
        addTrait(root, TestGameplayTrait);
    }

    it('crouched player cannot walk off a sneak-guarded ledge', async () => {
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            spawnAt(root, [2, 3, 2]);
        });

        // stone strip from x=0..4 at z=2 only. drops off at x>=5.
        for (let x = 0; x <= 4; x++) setBlock(harness.room.voxels, x, 0, 2, 'stone');

        const client = await harness.connect();
        harness.tick();
        harness.tickN(120); // settle

        const cc = client.characterController!;
        const transform = client.transform!;
        expect(cc.state.grounded).toBe(true);

        cc.input.crouch = true;
        cc.input.move[1] = 1;
        cc.input.look[1] = -Math.PI / 2;

        harness.tickN(240); // 4s walking into the void

        cc.input.move[1] = 0;

        // last stone is x=4 (spans x∈[4,5]). guard re-anchors to floor(center)
        // each frame, so center can drift until the body's right edge
        // (center + 0.3) clears the block top — slightly past x=5. main
        // assertion is grounded stayed true (didn't walk off into the void).
        expect(cc.state.grounded).toBe(true);
        expect(transform.position[0]).toBeLessThan(5.4);
        expect(transform.position[1]).toBeGreaterThan(0.5);
    });

    it('sneakGuard:false blocks (ice) let a crouched player slide off', async () => {
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            spawnAt(root, [2, 3, 2]);
        });

        for (let x = 0; x <= 4; x++) setBlock(harness.room.voxels, x, 0, 2, 'ice');

        const client = await harness.connect();
        harness.tick();
        harness.tickN(120);

        const cc = client.characterController!;
        const transform = client.transform!;
        expect(cc.state.grounded).toBe(true);

        cc.input.crouch = true;
        cc.input.move[1] = 1;
        cc.input.look[1] = -Math.PI / 2;

        harness.tickN(300);

        // no guard → player walks past the ice strip and falls.
        expect(transform.position[1]).toBeLessThan(0);
        expect(cc.state.grounded).toBe(false);
    });

    // ladder column with a solid wall behind it. spawn position is centered
    // in the ladder cells so the character starts inside climb mode.
    function buildLadderColumn(): void {
        // solid wall at x=6 (the "wall" the ladder is mounted on).
        for (let y = 0; y <= 6; y++) setBlock(harness!.room.voxels, 6, y, 5, 'stone');
        // floor under the ladder cell.
        setBlock(harness!.room.voxels, 5, 0, 5, 'stone');
        // ladder column at x=5, climbable, no collision (player can stand inside).
        for (let y = 1; y <= 5; y++) setBlock(harness!.room.voxels, 5, y, 5, 'vines');
    }

    it('ladder: jump ascends', async () => {
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            spawnAt(root, [5, 2, 5]);
        });
        buildLadderColumn();

        const client = await harness.connect();
        harness.tick();
        harness.tickN(30);

        const cc = client.characterController!;
        const transform = client.transform!;
        expect(cc.state.isClimbing).toBe(true);

        const startY = transform.position[1];
        cc.input.jump = true;
        harness.tickN(60);
        cc.input.jump = false;
        expect(transform.position[1] - startY).toBeGreaterThan(2.0);
    });

    it('ladder: pushing into the wall ascends (MC-style horizontal-collision climb)', async () => {
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            spawnAt(root, [5, 2, 5]);
        });
        buildLadderColumn();

        const client = await harness.connect();
        harness.tick();
        harness.tickN(30);

        const cc = client.characterController!;
        const transform = client.transform!;
        expect(cc.state.isClimbing).toBe(true);

        const startY = transform.position[1];
        // walk into the wall at +X — wishvel gets truncated → state.horizontalCollision → ascend.
        cc.input.move[1] = 1;
        cc.input.look[1] = -Math.PI / 2; // forward = +X
        harness.tickN(120);
        cc.input.move[1] = 0;

        expect(transform.position[1] - startY).toBeGreaterThan(1.0);
    });

    it('ladder: idle → slow descent at climbDescendSpeed', async () => {
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            // spawn high enough to fall freely into ladder without hitting floor immediately
            spawnAt(root, [5, 4, 5]);
        });
        buildLadderColumn();

        const client = await harness.connect();
        harness.tick();
        harness.tickN(30); // brief settle into the ladder

        const cc = client.characterController!;
        const transform = client.transform!;
        expect(cc.state.isClimbing).toBe(true);

        // no input. expect slow descent — ~climbDescendSpeed (1.5 m/s).
        // over 1s should drop ~1.0–1.7m, not 5m (which would be free-fall).
        const y0 = transform.position[1];
        harness.tickN(60);
        const drop = y0 - transform.position[1];
        expect(drop).toBeGreaterThan(0.5);
        expect(drop).toBeLessThan(2.5);
    });

    it('ladder: crouch holds vertical position (grab on)', async () => {
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            spawnAt(root, [5, 4, 5]);
        });
        buildLadderColumn();

        const client = await harness.connect();
        harness.tick();
        harness.tickN(30);

        const cc = client.characterController!;
        const transform = client.transform!;
        expect(cc.state.isClimbing).toBe(true);

        cc.input.crouch = true;
        const y0 = transform.position[1];
        harness.tickN(120); // 2s clinging
        expect(Math.abs(transform.position[1] - y0)).toBeLessThan(0.15);
    });

    it('liquid: sinks slowly instead of free-fall; jump swims up', async () => {
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            spawnAt(root, [5, 8, 5]);
        });

        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                setBlock(harness.room.voxels, 5 + dx, 0, 5 + dz, 'stone');
                for (let y = 1; y <= 5; y++) {
                    setBlock(harness.room.voxels, 5 + dx, y, 5 + dz, 'water');
                }
            }
        }

        const client = await harness.connect();
        harness.tick();
        harness.tickN(30); // free-fall until we hit water

        const cc = client.characterController!;
        const transform = client.transform!;

        let tries = 0;
        while (!cc.state.inLiquid && tries < 60) {
            harness.tick();
            tries++;
        }
        expect(cc.state.inLiquid).toBe(true);

        // sink speed: free-fall over 1s would accumulate ~10m of drop; with
        // liquidSink=1 + viscosity drag we expect well under that. <5m proves
        // gravity has been replaced by the much smaller sink term.
        const sinkY0 = transform.position[1];
        harness.tickN(60);
        const sinkDelta = sinkY0 - transform.position[1];
        expect(sinkDelta).toBeLessThan(5);

        // jump → swim up
        const beforeSwimY = transform.position[1];
        cc.input.jump = true;
        harness.tickN(60);
        cc.input.jump = false;
        expect(transform.position[1]).toBeGreaterThan(beforeSwimY + 1.0);
    });

    it('ground-block resolution: grounded contact wins (slab on stone) and liquid wins when swimming', async () => {
        // foot-sample priority for SFX/particles: a real ground contact must
        // win over the body-mid feet probe, otherwise standing on a slab in a
        // cell whose neighbour columns are liquid (or a slab with water below
        // visible through the half-cell gap) plays water footsteps instead of
        // the slab's own. when fully submerged with no contact, the liquid
        // branch takes over so swim cadence + entry splash still work.
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            blockPreset.slab('stone-slab', { all: { texture: 'stone' } });
            spawnAt(root, [2, 3, 2]);
        });

        const voxels = harness.room.voxels;
        // platform A (x=2): bottom slab on stone.
        setBlock(voxels, 2, 0, 2, 'stone');
        setBlock(voxels, 2, 1, 2, 'stone-slab[half=bottom]');
        // platform B (x=6): 3×3 water pool with stone floor, deep enough that
        // the player goes fully submerged with no ground contact.
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                setBlock(voxels, 6 + dx, 0, 6 + dz, 'stone');
                for (let y = 1; y <= 5; y++) setBlock(voxels, 6 + dx, y, 6 + dz, 'water');
            }
        }

        const client = await harness.connect();
        harness.tick();
        harness.tickN(120); // settle onto the slab

        const cc = client.characterController!;
        const transform = client.transform!;
        const slabState = voxels.registry.keyToState.get('stone-slab[half=bottom]')!;
        const waterState = voxels.registry.keyToState.get('water')!;

        // grounded on slab → resolves to slab id (the bug: used to flip to
        // water when the body-mid probe happened to land in an adjacent
        // liquid cell).
        expect(cc.state.grounded).toBe(true);
        expect(cc.state.groundBlockState).toBe(slabState);

        // teleport into the water pool and let the player sink fully.
        transform.position = [6, 8, 6];
        harness.tickN(60);
        let tries = 0;
        while (!cc.state.inLiquid && tries < 60) {
            harness.tick();
            tries++;
        }
        harness.tickN(30); // sink until no ground contact

        // submerged with no ground contact → liquid branch wins.
        expect(cc.state.inLiquidStable).toBe(true);
        expect(cc.state.grounded).toBe(false);
        expect(cc.state.groundBlockState).toBe(waterState);
    });

    it('ground-block resolution: slab directly above a water column (user-reported bug)', async () => {
        // exact user-reported config: a bottom slab sits one cell above a
        // water column with nothing in between. while standing AND walking on
        // the slab, the foot sample must resolve to the slab id, never the
        // water below.
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            blockPreset.slab('stone-slab', { all: { texture: 'stone' } });
            spawnAt(root, [2, 4, 2]);
        });

        const voxels = harness.room.voxels;
        const slabState = voxels.registry.keyToState.get('stone-slab[half=bottom]')!;
        const waterState = voxels.registry.keyToState.get('water')!;
        // 3x3 slab platform at y=2, with water column at y=0..1 directly under
        // each slab cell. stone at y=-1 contains the water.
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                setBlock(voxels, 2 + dx, -1, 2 + dz, 'stone');
                setBlock(voxels, 2 + dx, 0, 2 + dz, 'water');
                setBlock(voxels, 2 + dx, 1, 2 + dz, 'water');
                setBlock(voxels, 2 + dx, 2, 2 + dz, 'stone-slab[half=bottom]');
            }
        }

        const client = await harness.connect();
        harness.tick();
        harness.tickN(120);

        const cc = client.characterController!;
        expect(cc.state.grounded).toBe(true);
        expect(cc.state.groundBlockState).toBe(slabState);
        expect(cc.state.groundBlockState).not.toBe(waterState);

        // walk in a small circle, sampling each tick. groundBlockState must
        // stay locked to the slab for the entire walk.
        const sampled = new Set<number>();
        cc.input.move[1] = 1;
        for (let i = 0; i < 60; i++) {
            cc.input.look[1] = (i / 60) * Math.PI * 2;
            harness.tick();
            sampled.add(cc.state.groundBlockState);
        }
        cc.input.move[1] = 0;

        expect(sampled.has(waterState)).toBe(false);
        expect(sampled.has(slabState)).toBe(true);
    });

    it('liquid bob cadence: swim stroke is roughly half ground walking rate', async () => {
        // BOB_PHASE_VEL_LIQUID_FACTOR = 0.5 — verifies the multiplier is wired
        // through sampleEnvironment.inLiquidStable into the bob phase advance.
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            spawnAt(root, [5, 8, 5]);
        });

        // 3×3 water pool with a stone floor. plenty of depth to keep
        // inLiquidStable high while swimming horizontally.
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                setBlock(harness.room.voxels, 5 + dx, 0, 5 + dz, 'stone');
                for (let y = 1; y <= 5; y++) setBlock(harness.room.voxels, 5 + dx, y, 5 + dz, 'water');
            }
        }

        const client = await harness.connect();
        harness.tick();
        harness.tickN(60); // drop into water

        const cc = client.characterController!;
        expect(cc.state.inLiquid).toBe(true);
        expect(cc.state.inLiquidStable).toBe(true);

        // start swim stroke
        cc.input.move[1] = 1;
        cc.input.look[1] = -Math.PI / 2;
        harness.tickN(30); // let velocity reach steady-state in viscous water

        const phaseStart = cc.state.bobPhase;
        const speedInWater = Math.hypot(cc.state.velocity[0], cc.state.velocity[2]);
        harness.tickN(30);
        const phaseDeltaWater = cc.state.bobPhase - phaseStart;

        // ratio of phase advance per unit horizontal speed must be ~half of the
        // ground baseline (BOB_PHASE_VEL_PER_M_S = 2.5). pure math sanity check
        // independent of viscosity: phaseDelta / (speed * dt * ticks) ≈ 1.25.
        expect(speedInWater).toBeGreaterThan(0.1);
        const dtSpan = 30 / 60; // harness ticks at 60Hz
        const phaseRatePerMps = phaseDeltaWater / (speedInWater * dtSpan);
        expect(phaseRatePerMps).toBeGreaterThan(1.0);
        expect(phaseRatePerMps).toBeLessThan(1.6);
    });

    it('ice friction (0.1): player coasts after releasing input', async () => {
        harness = await createTestHarness((root) => {
            defineTestBlocks();
            spawnAt(root, [2, 3, 2]);
        });

        for (let x = 0; x <= 30; x++) setBlock(harness.room.voxels, x, 0, 2, 'ice');

        const client = await harness.connect();
        harness.tick();
        harness.tickN(120);

        const cc = client.characterController!;
        const transform = client.transform!;
        expect(cc.state.grounded).toBe(true);

        cc.input.move[1] = 1;
        cc.input.look[1] = -Math.PI / 2;
        harness.tickN(120);

        const releaseX = transform.position[0];
        expect(Math.abs(cc.state.velocity[0])).toBeGreaterThan(2);

        cc.input.move[1] = 0;
        harness.tickN(60);
        const coast = transform.position[0] - releaseX;
        // friction*0.1 → significant coasting (stone would stop in ~0.1m).
        expect(coast).toBeGreaterThan(1.0);
    });
});
