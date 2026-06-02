import {
    addTrait,
    block,
    BLOCK_AIR,
    blockPreset,
    blockTexture,
    characterLook,
    draw,
    env,
    getTrait,
    matchmaking,
    onInit,
    onJoin,
    onTick,
    script,
    setBlock,
    setPosition,
    TransformTrait,
    trait,
    CharacterControllerTrait,
    CharacterTrait,
    PlayerControllerTrait,
} from 'bongle';
import { blocks, blockTextures, blockSoundPresets } from 'bongle/starter';

// ── matchmaking ─────────────────────────────────────────────────────

matchmaking({ maxPlayers: 4 });

// ── blocks (from starter) ───────────────────────────────────────────

const {
    stone: Stone,
    dirt: Dirt,
    grass: Grass,
    ice: Ice,
    cobblestone: Cobblestone,
    stoneStairs: StoneStairs,
    stoneSlab: StoneSlab,
    cobblestoneWall: CobblestoneWall,
    glassPane: GlassPane,
    snowCarpet: SnowCarpet,
    oakTrapdoor: OakTrapdoor,
    stonePlate: StonePlate,
    lava: Lava,
    water: Water,
    oakFence: OakFence,
    redTorch: RedTorch,
    greenTorch: GreenTorch,
    blueTorch: BlueTorch,
    mushroomRed: MushroomRed,
    grassPlant1: GrassPlant1,
    grassPlant2: GrassPlant2,
    oakLeaves: OakLeaves,
} = blocks;

// ── inline blocks (starter primitives, composed here) ───────────────
// starter ships oak_planks as a full cube but not a full-cube snow
// block (snow only ships as a carpet). compose snow here from starter
// textures + sound presets to round out the ground-platform showcase.

const WoodFloor = block('demo:wood_floor', {
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.oakPlanks } } }),
    sounds: blockSoundPresets.wood,
});

const SnowBlock = block('demo:snow_block', {
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.snow } } }),
    sounds: blockSoundPresets.snow,
});

// ── number blocks (demoing draw() composition) ──────────────────────
// 10 blocks (0-9) whose top texture is the starter dirt overlaid with
// a 3×5 pixel-font digit. each blockTexture's `src` is a `draw()`
// descriptor: the bake pass loads dirt.png, blits it full-size, then
// stamps the digit pixels on top. shows the asset-pipeline composing
// user fns over bundled starter textures — same `draw()` primitive
// `block()` uses to auto-derive `<id>:particle{0,1,2}` dust slices,
// just hand-authored here for a visible side-by-side row.

// 3×5 pixel-font for digits 0-9. each bit is one pixel, MSB first,
// row-major (top-left → bottom-right). 15 bits per digit fits in one
// number; passing as `params.bits` keeps the bake hash stable per
// digit (closure-captured arrays don't ride the `fn.toString()` hash).
const DIGIT_BITS = [
    0b111_101_101_101_111, // 0
    0b010_110_010_010_111, // 1
    0b111_001_111_100_111, // 2
    0b111_001_111_001_111, // 3
    0b101_101_111_001_001, // 4
    0b111_100_111_001_111, // 5
    0b111_100_111_101_111, // 6
    0b111_001_010_010_010, // 7
    0b111_101_111_101_111, // 8
    0b111_101_111_001_111, // 9
];

const NumberBlocks = DIGIT_BITS.map((bits, n) => {
    const tex = blockTexture(`demo:number_${n}`, {
        src: draw(
            (c, inputs, params) => {
                c.drawImage(inputs.dirt, 0, 0, 16, 16);
                const bm = params.bits as number;
                // 3x5 centered in 16x16 → top-left (7, 6) leaves a
                // 5-px top + 5-px bottom margin (6 + 5 + 5 = 16) and
                // a 6/7 px L/R margin.
                const ox = 7;
                const oy = 6;
                c.fillStyle = '#fff';
                for (let i = 0; i < 15; i++) {
                    if ((bm >> (14 - i)) & 1) {
                        c.fillRect(ox + (i % 3), oy + Math.floor(i / 3), 1, 1);
                    }
                }
            },
            {
                size: [16, 16],
                inputs: { dirt: blockTextures.dirt.frames[0]! },
                params: { digit: n, bits },
            },
        ),
    });
    return block(`demo:number_${n}`, {
        model: () => ({ type: 'cube', textures: { all: { texture: tex } } }),
        sounds: blockSoundPresets.dirt,
    });
});

const GameplayTrait = trait('gameplay');

script(GameplayTrait, 'session', (ctx) => {
    if (!env.server) return;

    // showcase: place one of each preset along a stone platform in front of
    // spawn. idempotent — re-runs on every room start, overwriting the same
    // cells. layout uses x for category, z for variants of the same preset.
    onInit(ctx, () => {
        const ox = -8;
        const oz = 6;
        const baseY = 1;

        // big stone platform centered on spawn so the player can walk around
        // the showcase without falling. swept clear above. the showcase
        // sweep below overwrites the cells at ox+dx, oz+dz.
        const platMinX = -16;
        const platMaxX = 20;
        const platMinZ = -12;
        const platMaxZ = 16;
        for (let wx = platMinX; wx <= platMaxX; wx++) {
            for (let wz = platMinZ; wz <= platMaxZ; wz++) {
                setBlock(ctx.voxels, wx, baseY - 1, wz, Stone.defaultKey());
                for (let dy = 0; dy < 4; dy++) {
                    setBlock(ctx.voxels, wx, baseY + dy, wz, BLOCK_AIR);
                }
            }
        }

        // walls (col 0): post → straight pair → T-junction (recomputed by
        // onNeighbourUpdate as we drop them in).
        setBlock(ctx.voxels, ox + 0, baseY, oz + 0, CobblestoneWall.defaultKey());
        setBlock(ctx.voxels, ox + 0, baseY, oz + 2, CobblestoneWall.defaultKey());
        setBlock(ctx.voxels, ox + 0, baseY, oz + 3, CobblestoneWall.defaultKey());
        setBlock(ctx.voxels, ox + 0, baseY, oz + 4, CobblestoneWall.defaultKey());
        setBlock(ctx.voxels, ox + 1, baseY, oz + 3, CobblestoneWall.defaultKey());

        // panes (col 2): standalone + 3-in-a-row. translucent glass so you
        // can see the connection geometry through them.
        setBlock(ctx.voxels, ox + 2, baseY, oz + 0, GlassPane.defaultKey());
        setBlock(ctx.voxels, ox + 2, baseY, oz + 2, GlassPane.defaultKey());
        setBlock(ctx.voxels, ox + 2, baseY, oz + 3, GlassPane.defaultKey());
        setBlock(ctx.voxels, ox + 2, baseY, oz + 4, GlassPane.defaultKey());

        // slab variants (col 4): bottom / top / double, side by side.
        setBlock(ctx.voxels, ox + 4, baseY, oz + 0, StoneSlab.stateKey({ half: 'bottom' }));
        setBlock(ctx.voxels, ox + 4, baseY, oz + 2, StoneSlab.stateKey({ half: 'top' }));
        setBlock(ctx.voxels, ox + 4, baseY, oz + 4, StoneSlab.stateKey({ half: 'double' }));

        // stairs (col 6..7): straight, L-corner (auto-derived from
        // perpendicular neighbour), upside-down (top half).
        setBlock(ctx.voxels, ox + 6, baseY, oz + 0, StoneStairs.stateKey({ facing: 'north', half: 'bottom', shape: 'straight' }));
        setBlock(ctx.voxels, ox + 6, baseY, oz + 2, StoneStairs.stateKey({ facing: 'north', half: 'bottom', shape: 'straight' }));
        setBlock(ctx.voxels, ox + 7, baseY, oz + 2, StoneStairs.stateKey({ facing: 'east', half: 'bottom', shape: 'straight' }));
        setBlock(ctx.voxels, ox + 6, baseY + 1, oz + 4, StoneStairs.stateKey({ facing: 'north', half: 'top', shape: 'straight' }));

        // carpet (col 9): thin layer on top of stone.
        setBlock(ctx.voxels, ox + 9, baseY, oz + 0, SnowCarpet.defaultKey());
        setBlock(ctx.voxels, ox + 9, baseY, oz + 1, SnowCarpet.defaultKey());

        // trapdoor (col 11): closed-bottom, closed-top, open-vertical.
        setBlock(ctx.voxels, ox + 11, baseY, oz + 0, OakTrapdoor.stateKey({ facing: 'north', half: 'bottom', open: false }));
        setBlock(ctx.voxels, ox + 11, baseY, oz + 2, OakTrapdoor.stateKey({ facing: 'north', half: 'top', open: false }));
        setBlock(ctx.voxels, ox + 11, baseY, oz + 4, OakTrapdoor.stateKey({ facing: 'south', half: 'bottom', open: true }));

        // pressure plate (col 13): unpressed + a pressed variant for the
        // visual difference (gameplay-driven press logic lives elsewhere).
        setBlock(ctx.voxels, ox + 13, baseY, oz + 0, StonePlate.stateKey({ pressed: false }));
        setBlock(ctx.voxels, ox + 13, baseY, oz + 2, StonePlate.stateKey({ pressed: true }));

        // fence (col 15) — already in the scene as a block type; show a 3
        // segment row so it sits alongside its wall/pane cousins.
        setBlock(ctx.voxels, ox + 15, baseY, oz + 0, OakFence.defaultKey());
        setBlock(ctx.voxels, ox + 15, baseY, oz + 1, OakFence.defaultKey());
        setBlock(ctx.voxels, ox + 15, baseY, oz + 2, OakFence.defaultKey());

        // plants (col 17..18) — cross-mesh sprites on a grass/dirt strip.
        // col 17 is the dirt strip; plants sit on top at baseY. col 18 is
        // a 2x2 oak-leaves cube cluster (leaves render as a transparent
        // cube, distinct from the plant cross-mesh).
        for (let dz = 0; dz <= 4; dz++) {
            setBlock(ctx.voxels, ox + 17, baseY - 1, oz + dz, Grass.defaultKey());
        }
        setBlock(ctx.voxels, ox + 17, baseY, oz + 0, MushroomRed.defaultKey());
        setBlock(ctx.voxels, ox + 17, baseY, oz + 1, GrassPlant1.defaultKey());
        setBlock(ctx.voxels, ox + 17, baseY, oz + 2, GrassPlant2.defaultKey());
        setBlock(ctx.voxels, ox + 17, baseY, oz + 3, GrassPlant1.defaultKey());
        setBlock(ctx.voxels, ox + 17, baseY, oz + 4, MushroomRed.defaultKey());

        // oak leaves cluster (col 19..20) — small 2x2x2 canopy so the
        // translucent leaf cube reads against the open sky.
        for (let dx = 0; dx <= 1; dx++) {
            for (let dz = 0; dz <= 1; dz++) {
                setBlock(ctx.voxels, ox + 19 + dx, baseY + 1, oz + 1 + dz, OakLeaves.defaultKey());
                setBlock(ctx.voxels, ox + 19 + dx, baseY + 2, oz + 1 + dz, OakLeaves.defaultKey());
            }
        }

        // number-block row (demoing draw() composition) — 10 cells at
        // x=-5..4 on z=4, right in front of spawn. each block's top
        // texture is dirt + a stamped 3×5 digit, baked at pipeline
        // time by the draw fn declared above.
        for (let n = 0; n < 10; n++) {
            setBlock(ctx.voxels, n - 5, baseY, 4, NumberBlocks[n]!.defaultKey());
        }

        // liquid level showcase — water and lava blocks at every level
        // 1..8 so the surfaceHeight stair-step is visible side-by-side.
        // each cell uses Water.level(n) / Lava.level(n) to pick its height.
        for (let n = 1; n <= 8; n++) {
            setBlock(ctx.voxels, ox + n - 1, baseY, oz + 6, Water.level(n));
            setBlock(ctx.voxels, ox + n - 1, baseY, oz + 7, Lava.level(n));
        }

        // ── ground-platform footstep showcase (front of spawn, +z) ───
        // seven 4-wide patches at the same surface level as the main
        // platform — walk across to hear each material's footstep set
        // (sourced from each block's `sounds.footstep` clip pool). order
        // runs soft → hard so the audible texture changes obviously.
        const groundMaterials = [
            Grass,
            Dirt,
            SnowBlock,
            Ice,
            WoodFloor,
            Cobblestone,
            Stone,
        ];
        const groundPatchWidth = 4;
        const groundMinZ = 11;
        const groundMaxZ = 15;
        // 7 patches × 4 cells = 28 wide; centre on x=0 → start at x=-14.
        const groundStartX = -(groundMaterials.length * groundPatchWidth) / 2;
        for (let i = 0; i < groundMaterials.length; i++) {
            const key = groundMaterials[i]!.defaultKey();
            const patchX = groundStartX + i * groundPatchWidth;
            for (let dx = 0; dx < groundPatchWidth; dx++) {
                for (let wz = groundMinZ; wz <= groundMaxZ; wz++) {
                    setBlock(ctx.voxels, patchX + dx, baseY - 1, wz, key);
                }
            }
        }

        // ── dynamic demo area (behind spawn, -z) ─────────────────────
        // initial state — placed once, mutated every ~0.8s by the onTick
        // step machine below. each row exercises a different runtime
        // onNeighbourUpdate path: fence connection bitmask, wall on/off,
        // trapdoor open/closed, stair L-corner auto-derive.
        //
        // fence (z=-4): single centre post that cycles through arm
        // combinations as N/E/S/W neighbour posts come and go.
        setBlock(ctx.voxels, 0, baseY, -4, OakFence.defaultKey());
        // wall (z=-7): 5-wide row, centre toggles.
        for (let dx = -2; dx <= 2; dx++) {
            setBlock(ctx.voxels, dx, baseY, -7, CobblestoneWall.defaultKey());
        }
        // trapdoor (z=-9): row of 4, all flip together.
        for (let dx = -2; dx <= 1; dx++) {
            setBlock(ctx.voxels, dx, baseY, -9, OakTrapdoor.stateKey({ facing: 'north', half: 'bottom', open: false }));
        }
        // stair L-corner (z=-11): one centre stair facing north; a pair
        // of east-facing perpendicular neighbours appear/disappear at
        // x=±1 to drive the centre stair's shape between straight and L.
        setBlock(ctx.voxels, 0, baseY, -11, StoneStairs.stateKey({ facing: 'north', half: 'bottom', shape: 'straight' }));

        // ── lighting cave (left of spawn, -x) ────────────────────────
        // hollow stone box with entrance carved through the east wall.
        // rgb torches mounted on three different walls; the onTick step
        // machine toggles them on/off so the per-channel light flood
        // visibly recolours the cave.
        const cMinX = -22, cMaxX = -15;
        const cMinZ = -3, cMaxZ = 3;
        const cMinY = baseY, cMaxY = baseY + 2;
        for (let wx = cMinX; wx <= cMaxX; wx++) {
            for (let wz = cMinZ; wz <= cMaxZ; wz++) {
                // floor + ceiling
                setBlock(ctx.voxels, wx, baseY - 1, wz, Stone.defaultKey());
                setBlock(ctx.voxels, wx, baseY + 3, wz, Stone.defaultKey());
                // walls only at the boundary cells; interior stays air
                if (wx === cMinX || wx === cMaxX || wz === cMinZ || wz === cMaxZ) {
                    for (let wy = cMinY; wy <= cMaxY; wy++) {
                        setBlock(ctx.voxels, wx, wy, wz, Stone.defaultKey());
                    }
                }
            }
        }
        // entrance — carve 1-wide, 2-high opening through the east wall.
        setBlock(ctx.voxels, cMaxX, baseY, 0, BLOCK_AIR);
        setBlock(ctx.voxels, cMaxX, baseY + 1, 0, BLOCK_AIR);
        // torches — each adjacent to its wall, so torch's onNeighbourUpdate
        // picks the correct mount face:
        //   red:   west wall  (stone at x-1)
        //   green: south wall (stone at z+1, engine's south = +z)
        //   blue:  north wall (stone at z-1)
        setBlock(ctx.voxels, cMinX + 1, baseY + 1, 0, RedTorch.defaultKey());
        setBlock(ctx.voxels, -18, baseY + 1, cMaxZ - 1, GreenTorch.defaultKey());
        setBlock(ctx.voxels, -18, baseY + 1, cMinZ + 1, BlueTorch.defaultKey());
    });

    // ── dynamic step machine ────────────────────────────────────────
    // shared accumulator drives every behind-spawn + cave change. step
    // counter advances ~every 0.8s; each demo phases off it independently.
    const demoBaseY = 1;
    let demoAccum = 0;
    let demoStep = 0;
    const cavePositions: ReadonlyArray<readonly [number, number, number, ReturnType<typeof blockPreset.torch>]> = [
        [-21, demoBaseY + 1, 0, RedTorch],
        [-18, demoBaseY + 1, 2, GreenTorch],
        [-18, demoBaseY + 1, -2, BlueTorch],
    ];
    // fence neighbour cycle — bit i set ⇒ place neighbour post at
    // (offsets[i]). centre stays put; the centre's onNeighbourUpdate
    // re-picks the connection bitmask every step.
    //   bit 0 = N (z-1), 1 = S (z+1), 2 = E (x+1), 3 = W (x-1)
    const fenceNeighbourOffsets: ReadonlyArray<readonly [number, number]> = [
        [0, -1], [0, 1], [1, 0], [-1, 0],
    ];
    const fencePatterns: ReadonlyArray<number> = [
        0b0000, // post only
        0b0001, // 1-arm (N)
        0b0011, // straight (N+S)
        0b0101, // L (N+E)
        0b0111, // T (N+S+E)
        0b1111, // cross
    ];

    // stair perpendicular cycle — three positions on the z=-11 row.
    //   step 0: straight (no neighbours)
    //   step 1: east perpendicular present  → centre becomes inner-L
    //   step 2: west perpendicular present  → centre becomes inner-L (mirrored)
    //   step 3: both present                → centre back to straight
    const stairPattern: ReadonlyArray<readonly [boolean, boolean]> = [
        [false, false], [true, false], [false, true], [true, true],
    ];

    onTick(ctx, ({ delta }) => {
        demoAccum += delta;
        if (demoAccum < 0.8) return;
        demoAccum -= 0.8;
        demoStep++;

        // fence neighbour pattern — 6-step cycle through arm combos.
        const fenceMask = fencePatterns[demoStep % fencePatterns.length]!;
        for (let i = 0; i < 4; i++) {
            const [dx, dz] = fenceNeighbourOffsets[i]!;
            const on = (fenceMask & (1 << i)) !== 0;
            setBlock(ctx.voxels, dx, demoBaseY, -4 + dz, on ? OakFence.defaultKey() : BLOCK_AIR);
        }

        // wall centre toggle.
        const wallOn = demoStep % 2 === 1;
        setBlock(ctx.voxels, 0, demoBaseY, -7, wallOn ? CobblestoneWall.defaultKey() : BLOCK_AIR);

        // trapdoor row open/closed flip every 2 steps.
        if (demoStep % 2 === 0) {
            const open = (demoStep >> 1) % 2 === 0;
            for (let dx = -2; dx <= 1; dx++) {
                setBlock(ctx.voxels, dx, demoBaseY, -9, OakTrapdoor.stateKey({ facing: 'north', half: 'bottom', open }));
            }
        }

        // stair perpendicular cycle — drives the centre stair's auto-L
        // reshape via its onNeighbourUpdate.
        const [eastOn, westOn] = stairPattern[demoStep % stairPattern.length]!;
        setBlock(ctx.voxels, 1, demoBaseY, -11, eastOn ? StoneStairs.stateKey({ facing: 'east', half: 'bottom', shape: 'straight' }) : BLOCK_AIR);
        setBlock(ctx.voxels, -1, demoBaseY, -11, westOn ? StoneStairs.stateKey({ facing: 'east', half: 'bottom', shape: 'straight' }) : BLOCK_AIR);

        // rgb cave torches — cycle through the 7 non-zero on/off
        // patterns so each channel + combination is visible.
        const lightMask = (demoStep % 7) + 1;
        for (let i = 0; i < cavePositions.length; i++) {
            const [tx, ty, tz, handle] = cavePositions[i]!;
            const on = (lightMask & (1 << i)) !== 0;
            setBlock(ctx.voxels, tx, ty, tz, on ? handle.defaultKey() : BLOCK_AIR);
        }
    });

    onJoin(ctx, ({ client, playerNode }) => {
        console.log('player joined!', client);

        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, [0, 5, 0]);

        addTrait(playerNode, CharacterControllerTrait);

        addTrait(playerNode, CharacterTrait);
        addTrait(playerNode, PlayerControllerTrait);

        // theta=π → forward = +Z (engine: forward = (-sinθsinφ, -cosφ, -cosθsinφ))
        const cc = getTrait(playerNode, CharacterControllerTrait)!;
        characterLook(cc, Math.PI);
    });
});
