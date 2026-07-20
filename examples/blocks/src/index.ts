import {
    block,
    BLOCK_AIR,
    blockPreset,
    blockTexture,
    CullType,
    setCharacterLook,
    draw,
    env,
    MaterialType,
    getTrait,
    matchmaking,
    onInit,
    onJoin,
    onTick,
    script,
    setBlock,
    setDoorOpen,
    setPosition,
    TransformTrait,
    trait,
    CharacterControllerTrait,
} from 'bongle';
import { blocks, blockTextures, blockSoundPresets } from 'bongle/kit';

matchmaking({ maxPlayers: 4 });

const {
    stone: Stone,
    dirt: Dirt,
    grass: Grass,
    ice: Ice,
    cobblestone: Cobblestone,
    stoneStairs: StoneStairs,
    oakStairs: OakStairs,
    stoneSlab: StoneSlab,
    cobblestoneWall: CobblestoneWall,
    glassPane: GlassPane,
    snowCarpet: SnowCarpet,
    oakTrapdoor: OakTrapdoor,
    oakDoor: OakDoor,
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

// Inline blocks, composed here from kit primitives. Kit ships oak_planks as a
// full cube but not a full-cube snow block (snow only ships as a carpet), so
// compose snow here from kit textures and sound presets to round out the
// ground-platform showcase.

const WoodFloor = block('demo:wood_floor', {
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.oakPlanks } } }),
    sounds: blockSoundPresets.wood,
});

const SnowBlock = block('demo:snow_block', {
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.snow } } }),
    sounds: blockSoundPresets.snow,
});

// Translucent stained-glass cubes for the translucent-sort lab. These are
// alpha-blended cubes (MaterialType.TRANSLUCENT), unlike kit `glass` which is
// transparent (alpha-cutout). Translucent geometry is what the GPU per-section
// quad sort orders back-to-front, so these are the blocks that exercise it. The
// texture is a semi-transparent colour fill with a higher-alpha 1px frame so
// stacked panes stay legible through depth. `rgb` is packed into one int param
// rather than a closure array so each colour bakes to a distinct texture.
// CullType.SELF so touching cells of one colour read as a single shell.
const stainedGlass = (id: string, r: number, g: number, b: number) => {
    const tex = blockTexture(id, {
        src: draw(
            (c, _inputs, params) => {
                const packed = params.rgb as number;
                const pr = (packed >> 16) & 0xff;
                const pg = (packed >> 8) & 0xff;
                const pb = packed & 0xff;
                c.fillStyle = `rgba(${pr}, ${pg}, ${pb}, 0.5)`;
                c.fillRect(0, 0, 16, 16);
                c.fillStyle = `rgba(${pr}, ${pg}, ${pb}, 0.85)`;
                c.fillRect(0, 0, 16, 1);
                c.fillRect(0, 15, 16, 1);
                c.fillRect(0, 0, 1, 16);
                c.fillRect(15, 0, 1, 16);
            },
            { size: [16, 16], params: { rgb: (r << 16) | (g << 8) | b } },
        ),
    });
    return block(id, {
        model: () => ({ type: 'cube', textures: { all: { texture: tex } } }),
        cull: CullType.SELF,
        material: MaterialType.TRANSLUCENT,
        sounds: blockSoundPresets.glass,
    });
};

const GlassRed = stainedGlass('demo:glass_red', 220, 60, 60);
const GlassGreen = stainedGlass('demo:glass_green', 60, 200, 90);
const GlassBlue = stainedGlass('demo:glass_blue', 70, 110, 230);
const GlassAmber = stainedGlass('demo:glass_amber', 235, 175, 60);

// Number blocks, showing draw() composition. 10 blocks (0 to 9) whose top
// texture is the kit dirt overlaid with a 3 by 5 pixel-font digit. Each
// blockTexture's `src` is a `draw()` descriptor: the bake pass loads dirt.png,
// blits it full-size, then stamps the digit pixels on top. This shows the asset
// pipeline composing user fns over bundled kit textures, the same `draw()`
// primitive `block()` uses to auto-derive `<id>:particle{0,1,2}` dust slices,
// just hand-authored here for a visible side-by-side row.

// 3 by 5 pixel-font for digits 0 to 9. Each bit is one pixel, MSB first,
// row-major from top-left to bottom-right. 15 bits per digit fits in one
// number; passing it as `params.bits` keeps the bake hash stable per digit,
// since closure-captured arrays don't ride the `fn.toString()` hash.
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
                // 3x5 centered in 16x16: top-left (7, 6) leaves a 5px top and
                // 5px bottom margin (6 + 5 + 5 = 16) and a 6/7 px left/right margin.
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

    // Showcase: place one of each preset along a stone platform in front of
    // spawn. Idempotent, re-running on every room start and overwriting the
    // same cells. Layout uses x for category, z for variants of the same preset.
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

        // Walls (col 0): post, straight pair, then T-junction, recomputed by
        // onNeighbourUpdate as we drop them in.
        setBlock(ctx.voxels, ox + 0, baseY, oz + 0, CobblestoneWall.defaultKey());
        setBlock(ctx.voxels, ox + 0, baseY, oz + 2, CobblestoneWall.defaultKey());
        setBlock(ctx.voxels, ox + 0, baseY, oz + 3, CobblestoneWall.defaultKey());
        setBlock(ctx.voxels, ox + 0, baseY, oz + 4, CobblestoneWall.defaultKey());
        setBlock(ctx.voxels, ox + 1, baseY, oz + 3, CobblestoneWall.defaultKey());

        // Panes (col 2): standalone plus a 3-in-a-row. Translucent glass so you
        // can see the connection geometry through them.
        setBlock(ctx.voxels, ox + 2, baseY, oz + 0, GlassPane.defaultKey());
        setBlock(ctx.voxels, ox + 2, baseY, oz + 2, GlassPane.defaultKey());
        setBlock(ctx.voxels, ox + 2, baseY, oz + 3, GlassPane.defaultKey());
        setBlock(ctx.voxels, ox + 2, baseY, oz + 4, GlassPane.defaultKey());

        // Slab variants (col 4): bottom, top, double, side by side.
        setBlock(ctx.voxels, ox + 4, baseY, oz + 0, StoneSlab.stateKey({ half: 'bottom' }));
        setBlock(ctx.voxels, ox + 4, baseY, oz + 2, StoneSlab.stateKey({ half: 'top' }));
        setBlock(ctx.voxels, ox + 4, baseY, oz + 4, StoneSlab.stateKey({ half: 'double' }));

        // Stairs (col 6..7): straight, L-corner (auto-derived from a
        // perpendicular neighbour), upside-down (top half).
        setBlock(ctx.voxels, ox + 6, baseY, oz + 0, StoneStairs.stateKey({ facing: 'north', half: 'bottom', shape: 'straight' }));
        setBlock(ctx.voxels, ox + 6, baseY, oz + 2, StoneStairs.stateKey({ facing: 'north', half: 'bottom', shape: 'straight' }));
        setBlock(ctx.voxels, ox + 7, baseY, oz + 2, StoneStairs.stateKey({ facing: 'east', half: 'bottom', shape: 'straight' }));
        setBlock(ctx.voxels, ox + 6, baseY + 1, oz + 4, StoneStairs.stateKey({ facing: 'north', half: 'top', shape: 'straight' }));

        // Wood-stairs uvlock showcase (front-left, x<0 / z<0). Oak stairs use
        // the plank texture on every face, so their top tread grain makes
        // texture orientation obvious. With uvlock the tread grain stays pinned
        // to world axes across all four facings; without it the grain spins 90
        // degrees per facing. Laid on a wood-plank reference floor so the stair
        // treads can be compared to a full block's never-rotated grain directly.
        // Front-right of the platform (x=8..15, z=-4..3): open space clear of
        // the cave entrance, spawn, and the other showcase columns.
        const wsx = 8;
        const wsz = -4;
        // 8 by 8 plank reference floor at the walkable surface, overwriting the
        // stone platform top for this patch.
        for (let dx = 0; dx <= 7; dx++) {
            for (let dz = 0; dz <= 7; dz++) {
                setBlock(ctx.voxels, wsx + dx, baseY - 1, wsz + dz, WoodFloor.defaultKey());
            }
        }
        // Comparison row (z = wsz): four stairs, one per facing, spaced out. The
        // definitive test: with uvlock all four tread grains run the same world
        // direction (parallel); a full plank block sits at the end as the
        // reference grain.
        setBlock(ctx.voxels, wsx + 0, baseY, wsz + 0, OakStairs.stateKey({ facing: 'north', half: 'bottom', shape: 'straight' }));
        setBlock(ctx.voxels, wsx + 2, baseY, wsz + 0, OakStairs.stateKey({ facing: 'east', half: 'bottom', shape: 'straight' }));
        setBlock(ctx.voxels, wsx + 4, baseY, wsz + 0, OakStairs.stateKey({ facing: 'south', half: 'bottom', shape: 'straight' }));
        setBlock(ctx.voxels, wsx + 6, baseY, wsz + 0, OakStairs.stateKey({ facing: 'west', half: 'bottom', shape: 'straight' }));
        setBlock(ctx.voxels, wsx + 7, baseY, wsz + 0, WoodFloor.defaultKey());
        // Picture-frame ring (z = wsz+2 to wsz+7): a hollow 6 by 6 square of
        // stairs each facing outward, reproducing the big-hill platform lip.
        // Corners auto-derive outer shapes via onNeighbourUpdate. With uvlock
        // the tread grain reads continuously around the frame, and corners miter.
        const frameMinX = wsx;
        const frameMaxX = wsx + 5;
        const frameMinZ = wsz + 2;
        const frameMaxZ = wsz + 7;
        for (let x = frameMinX; x <= frameMaxX; x++) {
            for (let z = frameMinZ; z <= frameMaxZ; z++) {
                const onWest = x === frameMinX;
                const onEast = x === frameMaxX;
                const onNorth = z === frameMinZ;
                const onSouth = z === frameMaxZ;
                if (!onWest && !onEast && !onNorth && !onSouth) continue; // interior stays open
                // outward-facing: engine north = -z, south = +z. corners fall
                // through to a horizontal edge; onNeighbourUpdate reshapes them.
                const facing = onNorth ? 'north' : onSouth ? 'south' : onWest ? 'west' : 'east';
                setBlock(ctx.voxels, x, baseY, z, OakStairs.stateKey({ facing, half: 'bottom', shape: 'straight' }));
            }
        }

        // Carpet (col 9): thin layer on top of stone.
        setBlock(ctx.voxels, ox + 9, baseY, oz + 0, SnowCarpet.defaultKey());
        setBlock(ctx.voxels, ox + 9, baseY, oz + 1, SnowCarpet.defaultKey());

        // Trapdoor (col 11): closed-bottom, closed-top, open-vertical.
        setBlock(ctx.voxels, ox + 11, baseY, oz + 0, OakTrapdoor.stateKey({ facing: 'north', half: 'bottom', open: false }));
        setBlock(ctx.voxels, ox + 11, baseY, oz + 2, OakTrapdoor.stateKey({ facing: 'north', half: 'top', open: false }));
        setBlock(ctx.voxels, ox + 11, baseY, oz + 4, OakTrapdoor.stateKey({ facing: 'south', half: 'bottom', open: true }));

        // Pressure plate (col 13): unpressed plus a pressed variant for the
        // visual difference (gameplay-driven press logic lives elsewhere).
        setBlock(ctx.voxels, ox + 13, baseY, oz + 0, StonePlate.stateKey({ pressed: false }));
        setBlock(ctx.voxels, ox + 13, baseY, oz + 2, StonePlate.stateKey({ pressed: true }));

        // Fence (col 15), already in the scene as a block type; show a 3-segment
        // row so it sits alongside its wall/pane cousins.
        setBlock(ctx.voxels, ox + 15, baseY, oz + 0, OakFence.defaultKey());
        setBlock(ctx.voxels, ox + 15, baseY, oz + 1, OakFence.defaultKey());
        setBlock(ctx.voxels, ox + 15, baseY, oz + 2, OakFence.defaultKey());

        // Plants (col 17..18): cross-mesh sprites on a grass/dirt strip. Col 17
        // is the dirt strip; plants sit on top at baseY. Col 18 is a 2x2
        // oak-leaves cube cluster (leaves render as a transparent cube, distinct
        // from the plant cross-mesh).
        for (let dz = 0; dz <= 4; dz++) {
            setBlock(ctx.voxels, ox + 17, baseY - 1, oz + dz, Grass.defaultKey());
        }
        setBlock(ctx.voxels, ox + 17, baseY, oz + 0, MushroomRed.defaultKey());
        setBlock(ctx.voxels, ox + 17, baseY, oz + 1, GrassPlant1.defaultKey());
        setBlock(ctx.voxels, ox + 17, baseY, oz + 2, GrassPlant2.defaultKey());
        setBlock(ctx.voxels, ox + 17, baseY, oz + 3, GrassPlant1.defaultKey());
        setBlock(ctx.voxels, ox + 17, baseY, oz + 4, MushroomRed.defaultKey());

        // Oak leaves cluster (col 19..20): a small 2x2x2 canopy so the
        // translucent leaf cube reads against the open sky.
        for (let dx = 0; dx <= 1; dx++) {
            for (let dz = 0; dz <= 1; dz++) {
                setBlock(ctx.voxels, ox + 19 + dx, baseY + 1, oz + 1 + dz, OakLeaves.defaultKey());
                setBlock(ctx.voxels, ox + 19 + dx, baseY + 2, oz + 1 + dz, OakLeaves.defaultKey());
            }
        }

        // Doors (col 22..25): two-cell blocks placed as lower and upper halves
        // (here directly via setBlock; in-game the door's place hook writes both
        // cells from one click). Col 22 is a single door. Col 24 and 25 are a
        // double door, where adjacent leaves with opposite hinges meet flush.
        const placeDoor = (dx: number, hinge: 'left' | 'right') => {
            setBlock(ctx.voxels, ox + dx, baseY, oz + 0, OakDoor.stateKey({ facing: 'north', half: 'lower', hinge, open: false }));
            setBlock(ctx.voxels, ox + dx, baseY + 1, oz + 0, OakDoor.stateKey({ facing: 'north', half: 'upper', hinge, open: false }));
        };
        placeDoor(22, 'left');
        placeDoor(24, 'left');
        placeDoor(25, 'right');

        // Number-block row showing draw() composition: 10 cells at x=-5..4 on
        // z=4, right in front of spawn. Each block's top texture is dirt plus a
        // stamped 3 by 5 digit, baked at pipeline time by the draw fn declared above.
        for (let n = 0; n < 10; n++) {
            setBlock(ctx.voxels, n - 5, baseY, 4, NumberBlocks[n]!.defaultKey());
        }

        // Liquid level showcase: water and lava blocks at every level 1..8 so
        // the surfaceHeight stair-step is visible side by side. Each cell uses
        // Water.level(n) or Lava.level(n) to pick its height.
        for (let n = 1; n <= 8; n++) {
            setBlock(ctx.voxels, ox + n - 1, baseY, oz + 6, Water.level(n));
            setBlock(ctx.voxels, ox + n - 1, baseY, oz + 7, Lava.level(n));
        }

        // Ground-platform footstep showcase (front of spawn, +z). Seven 4-wide
        // patches at the same surface level as the main platform. Walk across to
        // hear each material's footstep set, sourced from each block's
        // `sounds.footstep` clip pool. Order runs soft to hard so the audible
        // texture changes obviously.
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
        // 7 patches times 4 cells is 28 wide; centre on x=0, so start at x=-14.
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

        // Dynamic demo area (behind spawn, -z). Initial state, placed once and
        // mutated about every 0.8s by the onTick step machine below. Each row
        // exercises a different runtime onNeighbourUpdate path: fence connection
        // bitmask, wall on/off, trapdoor open/closed, stair L-corner auto-derive.
        //
        // Fence (z=-4): a single centre post that cycles through arm
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
        // Stair L-corner (z=-11): one centre stair facing north; a pair of
        // east-facing perpendicular neighbours appear or disappear at x=+/-1 to
        // drive the centre stair's shape between straight and L.
        setBlock(ctx.voxels, 0, baseY, -11, StoneStairs.stateKey({ facing: 'north', half: 'bottom', shape: 'straight' }));

        // Door (x=4, z=-9): a two-cell door swung open/closed by the step
        // machine below via setDoorOpen, the programmatic door operation. There
        // is no interaction layer yet; this is what a controller would call.
        setBlock(ctx.voxels, 4, baseY, -9, OakDoor.stateKey({ facing: 'south', half: 'lower', hinge: 'left', open: false }));
        setBlock(ctx.voxels, 4, baseY + 1, -9, OakDoor.stateKey({ facing: 'south', half: 'upper', hinge: 'left', open: false }));

        // Lighting cave (left of spawn, -x). A hollow stone box with an entrance
        // carved through the east wall. rgb torches mounted on three different
        // walls; the onTick step machine toggles them on/off so the per-channel
        // light flood visibly recolours the cave.
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
        // Entrance: carve a 1-wide, 2-high opening through the east wall.
        setBlock(ctx.voxels, cMaxX, baseY, 0, BLOCK_AIR);
        setBlock(ctx.voxels, cMaxX, baseY + 1, 0, BLOCK_AIR);
        // Torches, each adjacent to its wall so the torch's onNeighbourUpdate
        // picks the correct mount face:
        //   red:   west wall  (stone at x-1)
        //   green: south wall (stone at z+1, engine's south = +z)
        //   blue:  north wall (stone at z-1)
        setBlock(ctx.voxels, cMinX + 1, baseY + 1, 0, RedTorch.defaultKey());
        setBlock(ctx.voxels, -18, baseY + 1, cMaxZ - 1, GreenTorch.defaultKey());
        setBlock(ctx.voxels, -18, baseY + 1, cMinZ + 1, BlueTorch.defaultKey());

        // Translucent-sort lab (east of the showcase, bridged at z=0). Four
        // stations of alpha-blended geometry (stained glass and water), the only
        // thing the GPU per-section quad sort orders. Each section's translucent
        // quads are sorted back-to-front on the GPU and re-sorted as the camera
        // moves, so orbit each station: correct order reads as clean layered
        // tint, a sort bug shows as blend artifacts or popping. Stations A to C
        // classify DYNAMIC (they drive the sort); D is a NONE control.
        const lx = 34; // lab base x (main platform ends at x=20)
        const labMinX = 32,
            labMaxX = 57;
        const labMinZ = -4,
            labMaxZ = 14;
        for (let wx = labMinX; wx <= labMaxX; wx++) {
            for (let wz = labMinZ; wz <= labMaxZ; wz++) {
                setBlock(ctx.voxels, wx, baseY - 1, wz, Stone.defaultKey());
                for (let dy = 0; dy < 5; dy++) setBlock(ctx.voxels, wx, baseY + dy, wz, BLOCK_AIR);
            }
        }
        // 3-wide stone bridge from the main platform (x=20) to the lab (x=32).
        for (let wx = 21; wx <= labMinX - 1; wx++) {
            for (let wz = -1; wz <= 1; wz++) setBlock(ctx.voxels, wx, baseY - 1, wz, Stone.defaultKey());
        }

        const glassCycle = [GlassRed, GlassGreen, GlassBlue, GlassAmber];

        // Station A, depth stack. Alternating-colour translucent cubes every 2
        // blocks along z with air gaps, giving many parallel translucent planes
        // at increasing depth in one section. The cleanest intra-section
        // (Level-B) sort test: walk along its length and the layers must stay ordered.
        for (let i = 0; i < 6; i++) {
            const key = glassCycle[i % glassCycle.length]!.defaultKey();
            setBlock(ctx.voxels, lx, baseY, 2 + i * 2, key);
            setBlock(ctx.voxels, lx, baseY + 1, 2 + i * 2, key);
        }

        // Station B, nested shells. An outer amber hollow cube shell around an
        // inner blue one (air gap between), so any view crosses outer, inner,
        // inner-far, outer-far translucent layers (multi-plane per facing, so
        // DYNAMIC). The classic nested-transparency ordering test.
        const shell = (cx: number, cy: number, cz: number, radius: number, handle: (typeof glassCycle)[number]) => {
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dz = -radius; dz <= radius; dz++) {
                        if (Math.abs(dx) === radius || Math.abs(dy) === radius || Math.abs(dz) === radius) {
                            setBlock(ctx.voxels, cx + dx, cy + dy, cz + dz, handle.defaultKey());
                        }
                    }
                }
            }
        };
        shell(lx + 6, baseY + 2, 4, 2, GlassAmber);
        shell(lx + 6, baseY + 2, 4, 1, GlassBlue);

        // Station C, a water pool with a depth step and submerged glass. A 6 by
        // 6 surface split into two water levels (multi-plane water, so DYNAMIC)
        // with translucent posts standing in it, so water quads and glass quads
        // at mixed depths sort together.
        const poolX = lx + 11,
            poolZ = 1;
        for (let dx = 0; dx < 6; dx++) {
            for (let dz = 0; dz < 6; dz++) {
                setBlock(ctx.voxels, poolX + dx, baseY, poolZ + dz, Water.level(dz < 3 ? 8 : 4));
            }
        }
        setBlock(ctx.voxels, poolX + 1, baseY, poolZ + 1, GlassRed.defaultKey());
        setBlock(ctx.voxels, poolX + 4, baseY, poolZ + 2, GlassGreen.defaultKey());
        setBlock(ctx.voxels, poolX + 2, baseY, poolZ + 4, GlassBlue.defaultKey());

        // Station D, a NONE control. A flat single-level water pane and a solid
        // 3x3x3 glass box (CullType.SELF, so only its convex outer shell draws).
        // Both classify NONE, so the sort is a no-op here; compare their
        // rock-steady look against the DYNAMIC stations to sanity-check the trigger.
        const ctrlX = lx + 20;
        for (let dx = 0; dx < 4; dx++) {
            for (let dz = 0; dz < 4; dz++) setBlock(ctx.voxels, ctrlX + dx, baseY, 1 + dz, Water.level(8));
        }
        for (let dx = 0; dx < 3; dx++) {
            for (let dy = 0; dy < 3; dy++) {
                for (let dz = 0; dz < 3; dz++) setBlock(ctx.voxels, ctrlX + dx, baseY + dy, 8 + dz, GlassAmber.defaultKey());
            }
        }
    });

    // Dynamic step machine. A shared accumulator drives every behind-spawn and
    // cave change. The step counter advances about every 0.8s; each demo phases
    // off it independently.
    const demoBaseY = 1;
    let demoAccum = 0;
    let demoStep = 0;
    const cavePositions: ReadonlyArray<readonly [number, number, number, ReturnType<typeof blockPreset.torch>]> = [
        [-21, demoBaseY + 1, 0, RedTorch],
        [-18, demoBaseY + 1, 2, GreenTorch],
        [-18, demoBaseY + 1, -2, BlueTorch],
    ];
    // Fence neighbour cycle: bit i set means place a neighbour post at
    // offsets[i]. The centre stays put; its onNeighbourUpdate re-picks the
    // connection bitmask every step.
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

    // Stair perpendicular cycle: three positions on the z=-11 row.
    //   step 0: straight (no neighbours)
    //   step 1: east perpendicular present, so centre becomes inner-L
    //   step 2: west perpendicular present, so centre becomes inner-L (mirrored)
    //   step 3: both present, so centre back to straight
    const stairPattern: ReadonlyArray<readonly [boolean, boolean]> = [
        [false, false], [true, false], [false, true], [true, true],
    ];

    onTick(ctx, ({ delta }) => {
        demoAccum += delta;
        if (demoAccum < 0.8) return;
        demoAccum -= 0.8;
        demoStep++;

        // fence neighbour pattern: 6-step cycle through arm combos.
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

        // door swing: operate the placed door via setDoorOpen (writes both
        // halves; partner re-derived from `half`).
        if (demoStep % 2 === 0) {
            setDoorOpen(ctx.voxels, 4, demoBaseY, -9, (demoStep >> 1) % 2 === 0);
        }

        // stair perpendicular cycle: drives the centre stair's auto-L reshape
        // via its onNeighbourUpdate.
        const [eastOn, westOn] = stairPattern[demoStep % stairPattern.length]!;
        setBlock(ctx.voxels, 1, demoBaseY, -11, eastOn ? StoneStairs.stateKey({ facing: 'east', half: 'bottom', shape: 'straight' }) : BLOCK_AIR);
        setBlock(ctx.voxels, -1, demoBaseY, -11, westOn ? StoneStairs.stateKey({ facing: 'east', half: 'bottom', shape: 'straight' }) : BLOCK_AIR);

        // rgb cave torches: cycle through the 7 non-zero on/off patterns so each
        // channel and combination is visible.
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

        // A look angle of PI faces +Z (engine forward = (-sin(theta)sin(phi), -cos(phi), -cos(theta)sin(phi))).
        const cc = getTrait(playerNode, CharacterControllerTrait)!;
        setCharacterLook(cc, Math.PI);
    });
});
