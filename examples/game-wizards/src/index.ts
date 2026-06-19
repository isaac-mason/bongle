import {
    AabbBodyMotionType,
    AabbBodyTrait,
    aabbBody,
    addChild,
    addCharacter,
    addTrait,
    BLOCK_AIR,
    broadcast,
    chat,
    CharacterControllerTrait,
    CLIENT_TO_SERVER,
    cloneModel,
    command,
    createNode,
    createVoxelRaycastResult,
    destroyNode,
    draw,
    ENVIRONMENT_OVERWORLD,
    env,
    findByName,
    findChildByName,
    getBlock,
    getBlockState,
    getControlNode,
    getTrait,
    getWorldMatrix,
    getWorldPosition,
    getWorldQuaternion,
    HtmlTrait,
    isMouseDown,
    listen,
    MeshTrait,
    matchmaking,
    model,
    type Node,
    onDispose,
    onFrame,
    onInit,
    onJoin,
    onPostAnimate,
    onTick,
    PlayerControllerTrait,
    PlayerTrait,
    pack,
    type ParticleHandle,
    particleUpdate,
    playMono,
    query,
    raycastVoxels,
    removeTrait,
    resolveCamera,
    rooms,
    script,
    type ScriptContext,
    send,
    SERVER_TO_CLIENT,
    sprite,
    setBlock,
    setEnvironment,
    setEnvironmentTime,
    setMeshDither,
    setMeshGlow,
    setMeshLitMin,
    setMeshTint,
    setPosition,
    sound,
    setQuaternion,
    setScale,
    setWorldPosition,
    setWorldQuaternion,
    spawnParticle,
    type SpriteHandle,
    SpriteTrait,
    sync,
    TransformTrait,
    trait,
    type TraitType,
    traverse,
    UILayer,
    use,
    voxelNav,
    WorldTrait,
} from 'bongle';
import { RIG_6BONE_ARM_RIGHT, RIG_6BONE_HAND_RIGHT, RIG_6BONE_HEAD } from 'bongle/avatar/rig';
import { blocks, particlePresets } from 'bongle/starter';
import { degreesToRadians, mat4, quat, type Quat, vec3, type Vec3, type Vec4 } from 'mathcat';
import { castRay, CastRayStatus, createClosestCastRayCollector, createDefaultCastRaySettings, filter as crashFilter } from 'crashcat';

matchmaking({ maxPlayers: 32 });

use(blocks);

const wizardModels = model('wizard-assets', {
    src: 'assets/wizard-game-assets.gltf',
});

script(WorldTrait, 'environment', (ctx) => {
    setEnvironment(ctx, ENVIRONMENT_OVERWORLD);
    setEnvironmentTime(ctx, 14);
});

const WizardTrait = trait('wizard', {
    color: [1, 1, 1, 1] as Vec4,
    // display name + per-round score (kills/deaths). server-authored and synced
    // for the leaderboard — players AND npcs. resets each round (the trait is
    // re-created on the fresh room).
    name: '',
    kills: 0,
    deaths: 0,
    // owner-authored + replicated *held* cast intent: true while this wizard's
    // owner is holding fire — see combat-cast. drives the firing tick + arm-raise.
    casting: false,
    // xp accrued from orbs → level → upgrade points. synced for the hud + cadence.
    xp: 0,
    // upgradable stat LEVELS (integers); effective values derived via STAT_TABLE.
    // synced so the client derives fire cadence, max health, the hud panel, etc.
    stats: { levels: { maxHealth: 0, regenRate: 0, moveSpeed: 0, fireRate: 0, damage: 0, speed: 0, splashRadius: 0, knockback: 0 } as StatLevels },
    // live health pool (folded in — every combatant is a wizard). `current` is
    // discrete + synced; max is DERIVED from the maxHealth stat (not stored). the
    // regen carry + damage bookkeeping stay server-only.
    current: 8, // = STAT_TABLE.maxHealth.base (level 0)
    regenAccum: 0,
    lastDamageTime: -999,
    lastAttacker: -1,
    // server-only clock of this wizard's last spawned shot — paces the firing tick.
    lastFireTime: -999,
    // client-side timestamp of the LOCAL player's own last predicted shot — drives
    // the first-person viewmodel jab only, for zero-latency feedback. not synced.
    lastCastTime: -999,
    // eased 0..1 arm-raise amount (client-side), toward `casting`. not synced.
    armRaise: 0,
});
type WizardTrait = TraitType<typeof WizardTrait>;

sync(WizardTrait, 'color', {
    schema: pack.list(pack.float32(), 4),
    pack: (t) => t.color,
    unpack: (v, t) => (t.color = v),
    rate: 'dirty',
});

// name is set once (spawn / join); kills + deaths change at runtime, so
// 'realtime' lets the engine diff + emit them without explicit dirtying.
sync(WizardTrait, 'name', {
    schema: pack.string(),
    pack: (t) => t.name,
    unpack: (v, t) => (t.name = v),
    rate: 'dirty',
});

sync(WizardTrait, 'kills', {
    schema: pack.uint32(),
    pack: (t) => t.kills,
    unpack: (v, t) => (t.kills = v),
});

sync(WizardTrait, 'deaths', {
    schema: pack.uint32(),
    pack: (t) => t.deaths,
    unpack: (v, t) => (t.deaths = v),
});

// cast flag, owner-authored: the local player's client flips its own on/off
// (instant), the server does it for npcs — so it replicates out the same way the
// transform does. every client reads it to drive the third-person arm-raise.
sync(WizardTrait, 'casting', {
    schema: pack.boolean(),
    pack: (t) => t.casting,
    unpack: (v, t) => (t.casting = v),
    authority: 'owner',
});

// stat levels change at runtime (upgrades), so 'realtime' re-emits on byte-change.
// the client derives fire cadence + max health + the hud panel from these.
sync(WizardTrait, 'stats', {
    schema: pack.object({
        maxHealth: pack.uint8(),
        regenRate: pack.uint8(),
        moveSpeed: pack.uint8(),
        fireRate: pack.uint8(),
        damage: pack.uint8(),
        speed: pack.uint8(),
        splashRadius: pack.uint8(),
        knockback: pack.uint8(),
    }),
    pack: (t) => t.stats.levels,
    unpack: (v, t) => (t.stats.levels = v),
    rate: 'realtime',
});

sync(WizardTrait, 'xp', {
    schema: pack.uint32(),
    pack: (t) => t.xp,
    unpack: (v, t) => (t.xp = v),
    rate: 'realtime',
});

// folded-in health pool: `current` is discrete and synced for the bar; max is
// derived client-side from the maxHealth stat, so it isn't sent.
sync(WizardTrait, 'current', {
    schema: pack.float32(),
    pack: (t) => t.current,
    unpack: (v, t) => (t.current = v),
    rate: 'realtime',
});

// attach a wizard's staff + hat to its rig (server-side; the cloned nodes
// replicate down). called as each wizard appears — see wizard-visuals.
function attachGear(wizardNode: Node): void {
    const staff = cloneModel(wizardModels.nodes.staff);
    staff.name = 'wizard:staff';
    const staffTransform = getTrait(staff, TransformTrait)!;
    // offset the grip outward (+X, the wizard's right) and forward (-Z) so the
    // upright staff stands clear of the forearm instead of running through it
    // — the hand sits at the bottom of the arm, so a staff straight up the
    // hand's centre would be collinear with the forearm.
    setPosition(staffTransform, [0.12, 0, -0.18]);
    setQuaternion(staffTransform, quat.setAxisAngle(quat.create(), [1, 0, 0], degreesToRadians(90)));
    addChild(findByName(wizardNode, RIG_6BONE_HAND_RIGHT)!, staff);

    const hat = cloneModel(wizardModels.nodes.hat);
    hat.name = 'wizard:hat';
    setPosition(getTrait(hat, TransformTrait)!, [0, 0.5, 0]);
    addChild(findByName(wizardNode, RIG_6BONE_HEAD)!, hat);
}

script(WorldTrait, 'join', (ctx) => {
    if (!env.server) return;

    const palette: Vec4[] = [
        [0.9, 0.1, 0.1, 1], // red
        [0.2, 0.3, 0.95, 1], // blue
        [0.6, 0.15, 0.85, 1], // purple
    ];

    onJoin(ctx, ({ playerNode, user }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, PLAYER_SPAWN);

        addTrait(playerNode, WizardTrait, {
            color: palette[Math.floor(Math.random() * palette.length)],
            name: user.username || 'anon',
        });
        attachGear(playerNode); // staff + hat onto the rig

        // combat entity: WizardTrait already carries the health pool (current
        // defaults to base max); the AliveTrait marker gates the combat systems.
        addTrait(playerNode, AliveTrait);
    });
});

// ── server: round timer → map reset ─────────────────────────────────
// every ROUND_DURATION the arena resets, with a chat countdown over the final
// seconds. rooms.recreate boots a fresh room from the same on-disk scene
// (pristine terrain + fresh NPCs/environment) and moves every player into it,
// then destroys this one. the successor runs this same script, so the timer
// restarts on its own — a perpetual round loop.
const ROUND_DURATION = 180; // s, tunable
const COUNTDOWN_FROM = 10; // s — chat countdown before the map changes

script(WorldTrait, 'round-timer', (ctx) => {
    if (!env.server) return;

    const players = query(ctx, [PlayerTrait]);
    let elapsed = 0;
    let lastShown = -1; // last whole second announced, so we post once per second
    onTick(ctx, ({ delta }) => {
        // idle while empty — matchmaking reaps empty rooms; nothing to reset.
        if (players.matches.length === 0) {
            elapsed = 0;
            lastShown = -1;
            return;
        }
        elapsed += delta;
        const remaining = ROUND_DURATION - elapsed;

        // "Map changing in N..." once per second over the final COUNTDOWN_FROM s.
        if (remaining <= COUNTDOWN_FROM && remaining > 0) {
            const sec = Math.ceil(remaining);
            if (sec !== lastShown) {
                lastShown = sec;
                chat.message(ctx, `Map changing in ${sec}...`);
            }
        }

        if (remaining > 0) return;
        rooms.recreate(ctx);
    });
});

script(WorldTrait, 'viewmodel', (ctx) => {
    if (!env.client) return;

    const offset: Vec3 = [0.35, -0.5, -0.55];
    const sway = 0.05; // horizontal walk bob (m) at full speed
    const bounce = 0.05; // vertical footfall dip (m)
    const speedRef = 5; // walk speed (m/s) for full bob amplitude
    const airPerSpeed = 0.02; // airborne lift (m) per (m/s) of vertical velocity
    const airMax = 0.15; // airborne lift clamp (m)

    const basePitch = degreesToRadians(-20); // staff laid forward along the view
    const castThrust = 0.18; // m — forward jab on cast
    const castPitch = degreesToRadians(28); // extra outward point on cast
    const castTau = 0.07; // s — cast-punch decay constant

    let bobBlend = 0; // eased walk amount (0..1)
    let air = 0; // eased airborne vertical offset (m); +y is down in this frame

    onFrame(ctx, ({ delta }) => {
        const { node: cameraNode } = resolveCamera(ctx);

        // build the viewmodel once, under whichever camera is current.
        let viewmodel = findChildByName(cameraNode, 'viewmodel:staff');
        if (!viewmodel) {
            viewmodel = cloneModel(wizardModels.nodes.staff);
            viewmodel.name = 'viewmodel:staff';
            const transform = getTrait(viewmodel, TransformTrait)!;
            setPosition(transform, offset);
            setScale(transform, [0.5, 0.5, 0.5]);
            // lay the staff forward along the view instead of standing it up.
            setQuaternion(transform, quat.setAxisAngle(quat.create(), [1, 0, 0], basePitch));
            // floor the light so the held item stays readable in shadow.
            traverse(viewmodel, (node) => {
                const mesh = getTrait(node, MeshTrait);
                if (mesh) setMeshLitMin(mesh, 0.35);
            });
            addChild(cameraNode, viewmodel);
        }

        // visible only to the local player, only in first person.
        const controlNode = getControlNode(ctx);
        const playerController = controlNode && getTrait(controlNode, PlayerControllerTrait);
        const firstPerson = !!playerController && playerController.config.perspective === 'first';
        traverse(viewmodel, (node) => {
            const mesh = getTrait(node, MeshTrait);
            if (mesh) mesh.visible = firstPerson;
        });

        const characterController = controlNode && getTrait(controlNode, CharacterControllerTrait);
        if (!characterController) return;
        const { velocity, grounded, bobPhase } = characterController.state;

        // walk bob eases in with ground speed; airborne lift tracks vertical
        // velocity (clamped). both ease so stopping / landing don't snap.
        const speed = Math.hypot(velocity[0], velocity[2]);
        bobBlend += ((grounded ? Math.min(speed / speedRef, 1) : 0) - bobBlend) * Math.min(delta * 8, 1);
        const airTarget = grounded ? 0 : Math.max(-airMax, Math.min(airMax, -velocity[1] * airPerSpeed));
        air += (airTarget - air) * Math.min(delta * 10, 1);

        // cast punch: a quick forward jab + outward point, decaying after each
        // cast (in lockstep with the muzzle), layered on top of the walk bob.
        const wizard = controlNode && getTrait(controlNode, WizardTrait);
        const punch = wizard ? Math.exp(-(ctx.clock.time - wizard.lastCastTime) / castTau) : 0;

        // sway side-to-side once per stride (`sin`), dip down each footfall
        // (`abs(sin)`, +y is down); the airborne lift + cast jab ride on top.
        const transform = getTrait(viewmodel, TransformTrait)!;
        setPosition(transform, [
            offset[0] + Math.sin(bobPhase) * sway * bobBlend,
            offset[1] + Math.abs(Math.sin(bobPhase)) * bounce * bobBlend + air,
            offset[2] - punch * castThrust,
        ]);
        setQuaternion(transform, quat.setAxisAngle(_viewmodelRot, [1, 0, 0], basePitch - punch * castPitch));
    });
});

// ─────────────────────────────────────────────────────────────────────
// combat core — one server-authoritative projectile, no elements yet.
//
// flow: click → Cast{dir} → server spawns a projectile node (auto-
// replicates) → server integrates + collides each tick → on hit it
// carves terrain + damages nearby health entities → broadcasts Impact /
// Damage / Death → clients render particle vfx. health drives regen,
// death and respawn for both players and NPC dummies.
//
// deliberately minimal: stats are hardcoded constants, the projectile
// moves analytically (no physics body, tunnel-proof), and entity hits
// are plain sphere checks. elements / tint / stat tables / status
// effects / knockback / AI all layer on top later without touching this.
// ─────────────────────────────────────────────────────────────────────

// projectile
const PROJECTILE_LIFETIME = 2.5; // s before it fizzles
const CHEST_OFFSET = 1.0; // m above a character's origin (feet) — splash-damage aim point
const EYE_HEIGHT = 1.5; // m — spawn origin above the caster's origin

// per-projectile stats, carried on the trait (set once, synced). one default for
// now; the elements / stat-table layer varies them per cast later.
type ProjectileStats = { speed: number; damage: number; damageRadius: number; terrainDamageRadius: number; knockback: number };
const DEFAULT_PROJECTILE_STATS: ProjectileStats = { speed: 18, damage: 3, damageRadius: 2, terrainDamageRadius: 1, knockback: 5 };
const KNOCKBACK_UP = 0.4; // upward kick as a fraction of the horizontal impulse (pops grounded targets so the shove lands)
const PROJECTILE_SPIN_SPEED = 12; // rad/s — roll around the travel axis while flying
const PROJECTILE_SPIN_AXIS: Vec3 = [0, 0, 1]; // local forward/back (node faces aim down -Z)
// staff tip in the staff node's local space: mesh max-Y from the gltf, with the
// node origin reset to [0,0,0] by the gear script. used to place the muzzle vfx.
const STAFF_TIP_LOCAL: Vec3 = [0, 1.0625, 0];

// ── upgradable stats (diep-style) ───────────────────────────────────
// each stat is an integer LEVEL (0..max) carried on the wizard; the effective
// value is derived here as base + level*perLevel. character stats apply to the
// wizard/controller; projectile stats snapshot into each shot at fire time.
const STAT_TABLE = {
    regenRate: { base: 1, perLevel: 0.5, max: 8, label: 'Health Regen', color: '#dba463' },
    maxHealth: { base: 8, perLevel: 2, max: 8, label: 'Max Health', color: '#e06ec6' },
    damage: { base: 3, perLevel: 1, max: 8, label: 'Bullet Damage', color: '#e06e6e' },
    speed: { base: 18, perLevel: 3, max: 8, label: 'Bullet Speed', color: '#6e9de0' },
    splashRadius: { base: 2, perLevel: 0.5, max: 8, label: 'Splash', color: '#e0d56e' },
    knockback: { base: 5, perLevel: 1.5, max: 8, label: 'Knockback', color: '#9d6ee0' },
    fireRate: { base: 1.5, perLevel: 0.6, max: 8, label: 'Fire Rate', color: '#8ce06e' },
    moveSpeed: { base: 4.317, perLevel: 0.4, max: 8, label: 'Movement Speed', color: '#6ee0d5' },
} as const;
type StatKey = keyof typeof STAT_TABLE;
const STAT_KEYS = Object.keys(STAT_TABLE) as StatKey[];
type StatLevels = Record<StatKey, number>;

// effective value of a stat at a given level.
const lvlValue = (key: StatKey, level: number): number => STAT_TABLE[key].base + level * STAT_TABLE[key].perLevel;
// derived effective values used at the call sites.
const maxHealthOf = (levels: StatLevels): number => lvlValue('maxHealth', levels.maxHealth);
const fireIntervalOf = (levels: StatLevels): number => 1 / lvlValue('fireRate', levels.fireRate);
const TERRAIN_RADIUS = 1; // m — terrain carve radius (fixed, not a stat yet)
const projectileStatsOf = (levels: StatLevels): ProjectileStats => ({
    speed: lvlValue('speed', levels.speed),
    damage: lvlValue('damage', levels.damage),
    damageRadius: lvlValue('splashRadius', levels.splashRadius),
    terrainDamageRadius: TERRAIN_RADIUS,
    knockback: lvlValue('knockback', levels.knockback),
});

// ── xp / levels ─────────────────────────────────────────────────────
// xp accrues from orbs; each level grants one upgrade point. quadratic curve:
// reaching level L needs XP_PER_LEVEL * L^2 total xp, so each level costs more.
const XP_PER_LEVEL = 12;
const levelForXp = (xp: number): number => Math.floor(Math.sqrt(xp / XP_PER_LEVEL));
const xpForLevel = (lvl: number): number => XP_PER_LEVEL * lvl * lvl; // inverse — xp at the start of `lvl`

// level → rarity tier: a colour (hat tint + nameplate badge) and a hat scale that
// grows with level. discrete colour bands read as a power/threat tier at a glance.
const LEVEL_TIERS: { min: number; color: string }[] = [
    { min: 15, color: '#fbbf24' }, // gold
    { min: 10, color: '#a78bfa' }, // purple
    { min: 6, color: '#6e9de0' }, // blue
    { min: 3, color: '#5fd33a' }, // green
    { min: 0, color: '#bdbdbd' }, // gray
];
const tierColor = (level: number): string => LEVEL_TIERS.find((t) => level >= t.min)!.color;
const tierScale = (level: number): number => 1 + Math.min(level, 20) * 0.02; // 1.0 → 1.4
// '#rrggbb' → a mesh tint Vec4 (alpha 1 = full mix tint).
const hexTint = (hex: string): Vec4 => {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
};
const sumLevels = (levels: StatLevels): number => STAT_KEYS.reduce((n, k) => n + levels[k], 0);
// upgrade points still to spend = levels earned − levels allocated.
const availablePoints = (xp: number, levels: StatLevels): number => levelForXp(xp) - sumLevels(levels);

// ── health timing ───────────────────────────────────────────────────
const REGEN_DELAY = 3; // s without damage before health regenerates
const RESPAWN_DELAY = 3; // s after death before respawn

// ── xp orbs (slither-style litter + death drops) ────────────────────
const ORB_AMOUNT = 6; // xp per orb
const ORB_TARGET = 40; // litter orbs kept scattered around the arena
const ORB_RESPAWN_INTERVAL = 0.5; // s between litter top-ups
const ORB_GRAB_RADIUS = 1.1; // m — an alive wizard within this collects an orb
const ORB_MAGNET_RADIUS = 5; // m — within this (but outside grab) an orb reels toward the nearest wizard
const ORB_MAGNET_PULL = 18; // m/s base — fly-in speed = (PULL − distance), so it accelerates as it nears (luanti-style)
const ORB_SPAWN_AREA = 28; // m — half-extent of the square litter region around spawn
const ORB_DROP_KEEP = 0.25; // fraction of xp the dead wizard keeps on respawn
const ORB_DROP_SCATTER = 0.5; // fraction dropped as orbs (the rest is lost)
const ORB_POP_UP = 4; // m/s — upward burst on a death-drop (physics scatters them)
const ORB_POP_OUT = 3; // m/s — horizontal burst on a death-drop
const ORB_DROP_MIN = 3; // orbs — every kill scatters at least this many, so low-xp/NPC kills still pay out

// falling hat — scripted pendulum sway-fall on death (faithful to wizard-game).
// outlives the respawn so you come back hatted while the old one settles.
const HAT_LIFETIME = 6; // s before the dropped hat despawns
const HAT_FALL_SPEED = 0.6; // m/s descent
const HAT_SWING_FREQ = 2.8; // pendulum rad/s
const HAT_SWING_AMPLITUDE = 0.18; // m side-to-side
const HAT_SWING_TILT = 0.4; // rad tilt
const HAT_SWING_DAMPING = 0.35; // 1/s envelope decay

const PLAYER_SPAWN: Vec3 = [8.5, 2, 8.5];

// random unit-ish direction for particle bursts.
function randomDir(): Vec3 {
    const x = Math.random() * 2 - 1;
    const y = Math.random() * 2 - 1;
    const z = Math.random() * 2 - 1;
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
}

// vary a base particle lifetime ±35% so a burst doesn't all die at once.
const varyLife = (base: number): number => base * (0.65 + Math.random() * 0.7);

// reusable quats for composing a local rotation onto a base orientation — the
// projectile spin (combat-vfx) and the falling-hat tilt (health-fx).
const _rotation = quat.create();
const _orientation = quat.create();

// scratch quat for the viewmodel's per-frame pose (base lay + cast punch pitch).
const _viewmodelRot = quat.create();

// scratch quats for the third-person cast pose (raise arm_right on top of the
// procedural swing — see the wizard-visuals script).
const _castArmRaise = quat.create();
const _castArmPose = quat.create();

// damage flash — red body tint + glow pulse to 1 then back to 0 on taking a hit.
const DAMAGE_FLASH_DURATION = 0.2; // s
const FLASH_TINT: Vec4 = [1, 0, 0, 0]; // red; alpha (flash strength) set per use

// ── traits ──────────────────────────────────────────────────────────

// a live projectile. `spawnTime` / `aim` / `stats` are synced so the trait (and
// node) replicates to clients for the trail + spin visuals. `ownerId` is
// server-only. the server raycasts the bolt forward each tick (it never stores a
// velocity — it derives it from aim × stats.speed); clients only render. `aim`
// is the cast-time direction: the node faces it and rolls around it.
const ProjectileTrait = trait('projectile', {
    ownerId: -1,
    spawnTime: 0,
    aim: [0, 0, 0, 1] as Quat,
    stats: DEFAULT_PROJECTILE_STATS,
});

sync(ProjectileTrait, 'spawnTime', {
    schema: pack.float32(),
    pack: (t) => t.spawnTime,
    unpack: (v, t) => (t.spawnTime = v),
    rate: 'dirty',
});

// the cast aim is synced (once) so clients can orient + spin the projectile
// locally — the server only drives position, leaving the quaternion to the
// client so the spin is smooth (no per-tick rotation round-trip).
sync(ProjectileTrait, 'aim', {
    schema: pack.list(pack.float32(), 4),
    pack: (t) => t.aim,
    unpack: (v, t) => (t.aim = v as Quat),
    rate: 'dirty',
});

// stats never change after spawn — synced once so clients have them.
sync(ProjectileTrait, 'stats', {
    schema: pack.object({
        speed: pack.float32(),
        damage: pack.float32(),
        damageRadius: pack.float32(),
        terrainDamageRadius: pack.float32(),
        knockback: pack.float32(),
    }),
    pack: (t) => t.stats,
    unpack: (v, t) => (t.stats = v),
    rate: 'dirty',
});

// xp pickup. `amount` synced (dirty) so the orb node replicates to clients,
// which decorate it with a billboard sprite (SpriteTrait isn't itself synced).
const XpOrbTrait = trait('xp-orb', { amount: ORB_AMOUNT });
sync(XpOrbTrait, 'amount', {
    schema: pack.uint16(),
    pack: (t) => t.amount,
    unpack: (v, t) => (t.amount = v),
    rate: 'dirty',
});

// marker: present iff the entity is alive. removed on death, re-added on
// respawn. the combat systems only touch entities that have it. (health itself
// folded onto WizardTrait — every combatant is a wizard.)
const AliveTrait = trait('alive');

// marker + respawn home for non-player targets.
const NpcTrait = trait('npc', {
    homeX: 0,
    homeY: 0,
    homeZ: 0,
    archetype: 0, // index into NPC_ARCHETYPES — its stat-allocation build (server-only)
});

// ── messages ────────────────────────────────────────────────────────

// `block` = the struck block's global state id on a terrain hit (0 = body/fizzle);
// the client uses its dust sprite for the impact.
const ImpactCommand = command('wizards.impact', SERVER_TO_CLIENT, pack.object({ pos: pack.list(pack.float32(), 3), fizzle: pack.boolean(), block: pack.uint32() }));
const DamageCommand = command('wizards.damage', SERVER_TO_CLIENT, pack.object({ pos: pack.list(pack.float32(), 3), amount: pack.float32() }));
const DeathCommand = command('wizards.death', SERVER_TO_CLIENT, pack.object({ pos: pack.list(pack.float32(), 3) }));
// client → server: spend an upgrade point on the stat at index `stat` (into STAT_KEYS).
const UpgradeStat = command('wizards.upgrade', CLIENT_TO_SERVER, pack.object({ stat: pack.uint8() }));
// server → one client: a knockback impulse for that player's own wizard. velocity is
// owner-authored, so the client applies it to its controller and it replicates out.
const KnockbackCommand = command('wizards.knockback', SERVER_TO_CLIENT, pack.object({ impulse: pack.list(pack.float32(), 3) }));

// ── particle types (client vfx) ─────────────────────────────────────
// deliberately low-detail: instead of the starter pack's 8–16px pixel-art
// sprites we bake flat white squares procedurally (no art assets). tiny so
// the fx read as chunky pixels rather than soft puffs, white so a future
// elements layer can tint them per cast.
const whiteSprite = (id: string, size: [number, number]) =>
    sprite(id, {
        src: draw(
            (ctx) => {
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, size[0], size[1]);
            },
            { size },
        ),
        mipmap: false, // crisp pixels, no mushy mip blur
    });

// 1×1 smoke puff for death; 3×3 for the chunkier cast/impact spark.
const SmokeSprite = whiteSprite('wizards:smoke', [1, 1]);
const SparkSprite = whiteSprite('wizards:spark', [3, 3]);

// 2×2 trail variants: each is a different filled/empty pixel pattern, not
// just a size. pixel index k → (x = k&1, y = k>>1), so bit k of `mask` sets
// that cell. the trail picks among them deterministically per particle for
// a bit of chunky variety without any single-frame flicker.
const pattern2x2 = (id: string, mask: number) =>
    sprite(id, {
        src: draw(
            (ctx, _inputs, { mask }) => {
                ctx.fillStyle = '#fff';
                for (let k = 0; k < 4; k++) {
                    if (mask & (1 << k)) ctx.fillRect(k & 1, k >> 1, 1, 1);
                }
            },
            { size: [2, 2], params: { mask } }, // mask in params → re-bakes when edited
        ),
        mipmap: false,
    });

// a few patterns to try: single corner, the two diagonals, a triple. tweak
// this list to taste — index order doesn't matter, the pick is hashed.
const TRAIL_MASKS = [
    0b0001, // ▘ top-left
    0b1001, // ◣ main diagonal
    0b0110, // ◢ anti-diagonal
    0b0111, // ◳ triple
];
const TrailVariants = TRAIL_MASKS.map((mask, i) =>
    particlePresets.smoke(`wizards:trail-${i}`, { sprite: pattern2x2(`wizards:trail-px-${i}`, mask) }),
);

const ImpactFx = particlePresets.spark('wizards:impact', { sprite: SparkSprite });
const DeathFx = particlePresets.smoke('wizards:death', { sprite: SmokeSprite });

// small deterministic 32-bit hash (two ints in) — drives the trail variant
// pick + scatter + per-particle seed so trails are reproducible, no Math.random.
function hash32(a: number, b: number): number {
    let x = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 1, 0xc2b2ae35)) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0x297a2d39) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
}
// hash → float in [-0.5, 0.5), re-hashed per component `k`.
const hashUnit = (h: number, k: number) => (hash32(h, k) >>> 8) / 0x100_0000 - 0.5;

// xp orb — a small two-tone green diamond, billboarded on the client.
const XpOrbSprite = sprite('wizards:xp-orb', {
    src: draw(
        (ctx, _inputs, { n }) => {
            const c = (n - 1) / 2;
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    const d = Math.abs(x - c) + Math.abs(y - c);
                    if (d > c) continue;
                    ctx.fillStyle = d <= c - 2 ? '#bcff7a' : '#5fd33a'; // light core, green rim
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        },
        { size: [7, 7], params: { n: 7 } },
    ),
    mipmap: false,
});

// pickup blip — VoxeLibre `mcl_item_entity` item-pickup, detuned ~6% (GPL-3.0;
// game-local, see assets/sounds/NOTICE.txt). kept out of the CC starter pack.
const PickupSound = sound('wizards:pickup', { src: 'assets/sounds/pickup.ogg' });

// ── server: spawn + simulate projectiles ────────────────────────────

// create a projectile node at `origin`, oriented to the cast `aim` quaternion
// (which also encodes its travel direction). top-level (no owner) so it
// replicates to every client; the cloned `projectile` mesh rides the transform.
function spawnProjectile(sceneRoot: Node, ownerNode: Node, origin: Vec3, aim: Quat, spawnTime: number, stats: ProjectileStats): void {
    const node = createNode({ name: 'projectile' });
    const transform = addTrait(node, TransformTrait);
    setPosition(transform, origin);
    setQuaternion(transform, aim); // face the aim; the tick adds spin on top
    addTrait(node, ProjectileTrait, {
        ownerId: ownerNode.id,
        spawnTime,
        aim: [aim[0], aim[1], aim[2], aim[3]],
        stats,
    });

    const visual = cloneModel(wizardModels.nodes.projectile);
    visual.name = 'projectile:visual';
    // the cloned gltf node carries its own local offset — zero it so the mesh
    // is centred on the projectile node (which drives movement / collision / trail).
    setPosition(getTrait(visual, TransformTrait)!, [0, 0, 0]);
    addChild(node, visual);

    addChild(sceneRoot, node);
}

// ground height under (x, z) via a downward voxel raycast (used to drop litter
// just above the surface so it settles rather than spawning buried).
const _orbRay = createVoxelRaycastResult();
function groundYAt(ctx: ScriptContext, x: number, z: number): number {
    raycastVoxels(_orbRay, ctx.voxels, ctx.voxels.registry, x, 64, z, 0, -1, 0, 80, 0);
    return _orbRay.hit ? _orbRay.py : 1;
}

// spawn an xp orb as a *voxel-only* AABB body: it falls + settles on terrain
// (and bounces a touch) but passes through wizards (`collisionMask: 0`) and the
// character bodies (`rigidBodyImpostor: false`). `vel` is the initial pop —
// death-drops burst outward, litter drops in still. server-authoritative; the
// node + body replicate, the client renders the synced transform.
function spawnOrb(ctx: ScriptContext, x: number, y: number, z: number, amount: number, vel: Vec3): void {
    const node = createNode({ name: 'xp-orb' });
    setPosition(addTrait(node, TransformTrait), [x, y, z]);
    addTrait(node, XpOrbTrait, { amount });
    addTrait(node, AabbBodyTrait, {
        halfExtents: [0.15, 0.15, 0.15],
        motionType: AabbBodyMotionType.DYNAMIC,
        collisionMask: 0, // no body-vs-body (other orbs, items)
        rigidBodyImpostor: false, // the character (rigid world) ignores it
        prediction: false, // server-authoritative; clients render the synced transform
        restitution: 0.3, // a little bounce on landing
        linearVelocity: vel,
    });
    addChild(ctx.node, node);
}

// world-space forward unit vector from a CharacterController look spherical
// [_, yaw, pitch] — the same basis the player-controller builds its camera
// forward from (yaw=0, pitch=π/2 → -Z). the server firing tick uses this to
// derive a wizard's fire direction from its synced look, identically for the
// local player (look set from its camera) and npcs (look set by the AI).
function lookDirection(look: Vec3, out: Vec3): Vec3 {
    const theta = look[1]; // yaw
    const phi = look[2]; // pitch
    const sinPhi = Math.sin(phi);
    out[0] = -Math.sin(theta) * sinPhi;
    out[1] = -Math.cos(phi);
    out[2] = -Math.cos(theta) * sinPhi;
    return out;
}

script(WorldTrait, 'combat-cast', (ctx) => {
    // ── client: own our held cast intent; predict our own muzzle + viewmodel ──
    if (env.client) {
        // local clock for our PREDICTED cadence (muzzle flash + viewmodel jab),
        // paced at our own stats.fireRate — the server fires the real projectile
        // at the same rate off the replicated `casting`, so the two stay in step.
        let predictedFireAt = -999;

        onFrame(ctx, () => {
            const now = ctx.clock.time;
            const controlNode = getControlNode(ctx);
            const selfWizard = controlNode && getTrait(controlNode, WizardTrait);
            if (!selfWizard) return;

            const mk = ctx.client?.input?.mouseKeyboard;
            const holdingFire = !!mk && isMouseDown(mk, 'left');

            // first click (no lock yet) grabs the pointer instead of firing.
            if (holdingFire && !document.pointerLockElement) {
                ctx.client?.domElement?.requestPointerLock?.();
            }

            // we want to fire only while locked in AND alive — the PlayerController
            // is gone while dead, so gate on it so a held mouse doesn't fire from a
            // corpse. this is our held cast intent: the server reads it (+ our
            // synced look + fireRate) and spawns the shots.
            const wantsFire = holdingFire && !!document.pointerLockElement && !!controlNode && !!getTrait(controlNode, PlayerControllerTrait);
            selfWizard.casting = wantsFire; // owner-authored → replicates out
            if (!wantsFire) return;

            // predict our own cadence locally for zero-latency feel.
            if (now - predictedFireAt < fireIntervalOf(selfWizard.stats.levels)) return;
            predictedFireAt = now;
            selfWizard.lastCastTime = now; // viewmodel jab

            // muzzle flash at the world tip of the held staff, spraying along the
            // view direction (camera forward = -Z) with a little scatter.
            const staffNode = controlNode && findChildByName(controlNode, 'wizard:staff');
            if (staffNode) {
                const q = getWorldQuaternion(getTrait(resolveCamera(ctx).node, TransformTrait)!);
                const muzzle = vec3.transformMat4(vec3.create(), STAFF_TIP_LOCAL, getWorldMatrix(getTrait(staffNode, TransformTrait)!)) as Vec3;
                const forward = vec3.transformQuat(vec3.create(), [0, 0, -1], q);
                for (let i = 0; i < 5; i++) {
                    const s = randomDir();
                    spawnParticle(ctx, ImpactFx, muzzle, {
                        lifetime: varyLife(0.4),
                        size: 0.07,
                        emissive: 1,
                        velX: forward[0] * 8 + s[0] * 2.2,
                        velY: forward[1] * 8 + s[1] * 2.2,
                        velZ: forward[2] * 8 + s[2] * 2.2,
                    });
                }
            }
        });

        // knockback — the server directs an impulse to us when our wizard is hit.
        // add it to our own controller velocity; owner-authority replicates the
        // shove out, so the server + other clients see the same motion.
        listen(ctx, KnockbackCommand, ({ impulse }) => {
            const node = getControlNode(ctx);
            const cc = node && getTrait(node, CharacterControllerTrait);
            if (cc) {
                cc.state.velocity[0] += impulse[0];
                cc.state.velocity[1] += impulse[1];
                cc.state.velocity[2] += impulse[2];
            }
        });
    }

    // ── server: one firing tick for ALL wizards — players AND npcs feed the same
    // two inputs (held `casting` + synced `look`); we pace each off its own
    // stats.fireRate and spawn the authoritative projectile along its look. ──
    if (env.server) {
        const wizards = query(ctx, [WizardTrait, CharacterControllerTrait, AliveTrait, TransformTrait]);
        const _fireDir = vec3.create();

        onTick(ctx, () => {
            const now = ctx.clock.time;
            for (const [wizard, controller, , transform] of wizards) {
                if (!wizard.casting) continue;
                if (now - wizard.lastFireTime < fireIntervalOf(wizard.stats.levels)) continue;
                wizard.lastFireTime = now;

                const dir = lookDirection(controller.input.look, _fireDir);
                const aim = quat.rotationTo(quat.create(), [0, 0, -1], dir);
                const p = getWorldPosition(transform);
                const origin: Vec3 = [p[0] + dir[0] * 1.2, p[1] + EYE_HEIGHT + dir[1] * 1.2, p[2] + dir[2] * 1.2];
                // snapshot the wizard's current projectile stats into the shot.
                spawnProjectile(ctx.node, wizard._node, origin, aim, now, projectileStatsOf(wizard.stats.levels));
            }
        });
    }
});

script(WorldTrait, 'combat-projectiles', (ctx) => {
    if (!env.server) return;

    const projectiles = query(ctx, [ProjectileTrait, TransformTrait]);
    const targets = query(ctx, [WizardTrait, AliveTrait, TransformTrait]);

    // reusable crashcat ray-query state.
    const rayCollector = createClosestCastRayCollector();
    const raySettings = createDefaultCastRaySettings();
    let rayFilter: ReturnType<typeof crashFilter.forWorld> | null = null; // built lazily once the world exists
    const _rayDir = vec3.create();

    // carve a voxel sphere + splash-damage characters within `damageRadius`,
    // then tell clients where it landed.
    const handleHit = (pos: Vec3, ownerId: number, stats: ProjectileStats, block: number) => {
        const r = Math.floor(stats.terrainDamageRadius);
        const cx = Math.floor(pos[0]);
        const cy = Math.floor(pos[1]);
        const cz = Math.floor(pos[2]);
        for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (dx * dx + dy * dy + dz * dz > stats.terrainDamageRadius * stats.terrainDamageRadius) continue;
                    if (getBlock(ctx.voxels, cx + dx, cy + dy, cz + dz) !== BLOCK_AIR) {
                        setBlock(ctx.voxels, cx + dx, cy + dy, cz + dz, BLOCK_AIR);
                    }
                }
            }
        }

        for (const [wiz, , transform] of targets) {
            if (transform._node.id === ownerId) continue; // no self-damage
            const wp = getWorldPosition(transform);
            const tx = wp[0];
            const ty = wp[1] + CHEST_OFFSET;
            const tz = wp[2];
            const ex = pos[0] - tx;
            const ey = pos[1] - ty;
            const ez = pos[2] - tz;
            if (ex * ex + ey * ey + ez * ez > stats.damageRadius * stats.damageRadius) continue;

            wiz.current = Math.max(0, wiz.current - stats.damage);
            wiz.lastDamageTime = ctx.clock.time;
            wiz.lastAttacker = ownerId;
            broadcast(ctx, DamageCommand, { pos: [tx, ty, tz], amount: stats.damage });

            // knockback: radial shove away from the blast + an up-kick so it lands on
            // grounded targets (ground drag would otherwise eat a flat horizontal push).
            // players own their velocity → apply on their own client via a directed
            // command; the server applies it for npcs (which it owns) directly.
            const kx = tx - pos[0];
            const kz = tz - pos[2];
            const klen = Math.hypot(kx, kz) || 1;
            const mag = stats.knockback;
            const impulse: Vec3 = [(kx / klen) * mag, mag * KNOCKBACK_UP, (kz / klen) * mag];
            const node = transform._node;
            const player = getTrait(node, PlayerTrait);
            if (player) {
                send(ctx, KnockbackCommand, { impulse }, player.client);
            } else {
                const cc = getTrait(node, CharacterControllerTrait);
                if (cc) {
                    cc.state.velocity[0] += impulse[0];
                    cc.state.velocity[1] += impulse[1];
                    cc.state.velocity[2] += impulse[2];
                }
            }
        }

        broadcast(ctx, ImpactCommand, { pos: [pos[0], pos[1], pos[2]], fizzle: false, block });
    };

    onTick(ctx, ({ delta }) => {
        const now = ctx.clock.time;
        // the rigid world — voxels live in this same crashcat world, so one cast
        // covers terrain + character bodies.
        const rigid = ctx.physics.rigid;
        rayFilter ??= crashFilter.forWorld(rigid.world); // all layers: terrain + bodies

        // resolve outside the loop — destroying nodes mid-iteration is unsafe.
        const spent: Array<{ node: Node; pos: Vec3; ownerId: number; stats: ProjectileStats; fizzle: boolean; block: number }> = [];

        for (const [projectile, transform] of projectiles) {
            const pos = transform.position;
            if (now - projectile.spawnTime > PROJECTILE_LIFETIME) {
                spent.push({ node: projectile._node, pos: [pos[0], pos[1], pos[2]], ownerId: projectile.ownerId, stats: projectile.stats, fizzle: true, block: 0 });
                continue;
            }

            // travel direction (from the cast aim) and this tick's step distance.
            const dir = vec3.transformQuat(_rayDir, [0, 0, -1], projectile.aim);
            const step = projectile.stats.speed * delta;

            // one ray against the rigid world hits terrain (the voxel shape) AND
            // character bodies; nearest wins. bodyToNode maps a body hit back to
            // its node (undefined ⇒ terrain). the owner is behind the bolt, so a
            // hit that resolves to the owner just means "keep flying".
            rayCollector.reset();
            castRay(rigid.world, rayCollector, raySettings, pos, dir, step, rayFilter);
            const hit = rayCollector.hit;
            if (hit.status === CastRayStatus.COLLIDING && rigid.bodyToNode.get(hit.bodyIdB) !== projectile.ownerId) {
                const t = hit.fraction;
                const hxp = pos[0] + dir[0] * step * t;
                const hyp = pos[1] + dir[1] * step * t;
                const hzp = pos[2] + dir[2] * step * t;
                // terrain hit (no body) → sample the struck block (just inside the
                // surface, before the carve) so the client can use its dust sprite.
                // body hits send 0 → the white spark, same as today.
                const terrain = rigid.bodyToNode.get(hit.bodyIdB) === undefined;
                // getBlockState (numeric global state id), NOT getBlock (string key) —
                // it's what indexes `ctx.blocks.particles[]`. air = 0.
                const block = terrain ? getBlockState(ctx.voxels, Math.floor(hxp + dir[0] * 0.1), Math.floor(hyp + dir[1] * 0.1), Math.floor(hzp + dir[2] * 0.1)) : 0;
                spent.push({
                    node: projectile._node,
                    pos: [hxp, hyp, hzp],
                    ownerId: projectile.ownerId,
                    stats: projectile.stats,
                    fizzle: false,
                    block,
                });
                continue;
            }

            // no hit — advance. server drives position only; clients own the
            // quaternion (aim + local spin) so the rotation stays smooth.
            setPosition(transform, [pos[0] + dir[0] * step, pos[1] + dir[1] * step, pos[2] + dir[2] * step]);
        }

        for (const s of spent) {
            if (s.fizzle) broadcast(ctx, ImpactCommand, { pos: s.pos, fizzle: true, block: 0 });
            else handleHit(s.pos, s.ownerId, s.stats, s.block);
            destroyNode(s.node);
        }
    });
});

// ── server: health, death, respawn ──────────────────────────────────

script(WorldTrait, 'combat-health', (ctx) => {
    if (!env.server) return;

    const alive = query(ctx, [WizardTrait, AliveTrait, TransformTrait]);
    const combatants = query(ctx, [WizardTrait]); // every scoreable entity (players + npcs)
    const respawns: Array<{ node: Node; at: number; pos: Vec3 }> = [];

    onTick(ctx, ({ delta }) => {
        const now = ctx.clock.time;
        const deaths: Array<{ node: Node; pos: Vec3; attacker: number }> = [];

        for (const [wiz, , transform] of alive) {
            if (wiz.current <= 0) {
                const wp = getWorldPosition(transform);
                deaths.push({ node: transform._node, pos: [wp[0], wp[1], wp[2]], attacker: wiz.lastAttacker });
                continue;
            }
            const max = maxHealthOf(wiz.stats.levels);
            if (wiz.current < max && now - wiz.lastDamageTime >= REGEN_DELAY) {
                // accumulate at the derived regen rate, commit only whole hp so `current` stays discrete.
                wiz.regenAccum += lvlValue('regenRate', wiz.stats.levels.regenRate) * delta;
                if (wiz.regenAccum >= 1) {
                    const gained = Math.floor(wiz.regenAccum);
                    wiz.current = Math.min(max, wiz.current + gained);
                    wiz.regenAccum -= gained;
                }
            } else {
                wiz.regenAccum = 0; // drop partial progress while damaged or full
            }
        }

        for (const d of deaths) {
            removeTrait(d.node, AliveTrait);
            broadcast(ctx, DeathCommand, { pos: d.pos });

            // score + log: credit the victim a death, and the killer (if any, and
            // not self/terrain) a kill. `attacker` is the last node to damage them.
            const victim = getTrait(d.node, WizardTrait);
            if (victim) victim.deaths++;

            // diep-style re-spec on death: scatter a chunk of xp as orbs near the
            // corpse, keep a slice for the respawn, lose the rest, and reset all
            // stat allocations to 0 so the wizard re-spends from scratch.
            if (victim) {
                const dropCount = Math.max(ORB_DROP_MIN, Math.floor((victim.xp * ORB_DROP_SCATTER) / ORB_AMOUNT));
                for (let n = 0; n < dropCount; n++) {
                    // burst up + out from the corpse; physics arcs them down to scatter.
                    const ang = Math.random() * Math.PI * 2;
                    const out = 1 + Math.random() * ORB_POP_OUT;
                    const vel: Vec3 = [Math.cos(ang) * out, ORB_POP_UP + Math.random() * 2, Math.sin(ang) * out];
                    spawnOrb(ctx, d.pos[0], d.pos[1] + 1, d.pos[2], ORB_AMOUNT, vel);
                }
                victim.xp = Math.floor(victim.xp * ORB_DROP_KEEP);
                for (const k of STAT_KEYS) victim.stats.levels[k] = 0;
            }

            let killerName = '';
            if (d.attacker >= 0 && d.attacker !== d.node.id) {
                for (const [w] of combatants) {
                    if (w._node.id === d.attacker) {
                        w.kills++;
                        killerName = w.name;
                        break;
                    }
                }
            }
            const victimName = victim?.name || 'someone';
            chat.message(ctx, killerName ? `${killerName} blasted ${victimName}` : `${victimName} fizzled out`);

            // players lose their player-controller while dead — frees the camera for
            // the death-cam, stops input, and hides the viewmodel. and dropping the
            // character-controller freezes the body where it died (no slide/settle),
            // so the orbit pins to a fixed point. both re-added on respawn.
            if (getTrait(d.node, PlayerControllerTrait)) removeTrait(d.node, PlayerControllerTrait);
            if (getTrait(d.node, CharacterControllerTrait)) removeTrait(d.node, CharacterControllerTrait);
            const npc = getTrait(d.node, NpcTrait);
            const pos: Vec3 = npc ? [npc.homeX, npc.homeY, npc.homeZ] : PLAYER_SPAWN;
            respawns.push({ node: d.node, at: now + RESPAWN_DELAY, pos });
        }

        for (let i = respawns.length - 1; i >= 0; i--) {
            if (now < respawns[i]!.at) continue;
            const r = respawns.splice(i, 1)[0]!;
            const wiz = getTrait(r.node, WizardTrait);
            const transform = getTrait(r.node, TransformTrait);
            if (!wiz || !transform) continue; // node went away
            wiz.current = maxHealthOf(wiz.stats.levels); // base max (levels reset on death)
            wiz.regenAccum = 0;
            wiz.lastDamageTime = now;
            wiz.lastAttacker = -1;
            setPosition(transform, r.pos);
            // re-add the character-controller first (it inits its body at the
            // freshly-set spawn position), then the player-controller (which
            // requires it) for players only.
            if (!getTrait(r.node, CharacterControllerTrait)) addTrait(r.node, CharacterControllerTrait);
            addTrait(r.node, AliveTrait);
            if (getTrait(r.node, PlayerTrait)) addTrait(r.node, PlayerControllerTrait);
        }
    });
});

// ── server: stat upgrades ───────────────────────────────────────────
// spend an earned point (level − allocated) on a stat. character stats apply
// immediately; projectile / fire-rate / regen read their level at use.

// apply one point into `key` if the wizard has a spare point and the stat isn't
// capped; returns whether it spent. shared by the player command + the npc AI.
function tryUpgrade(wiz: WizardTrait, key: StatKey): boolean {
    const levels = wiz.stats.levels;
    if (availablePoints(wiz.xp, levels) <= 0) return false; // no points to spend
    if (levels[key] >= STAT_TABLE[key].max) return false; // capped
    const beforeMax = maxHealthOf(levels);
    levels[key]++;
    if (key === 'maxHealth') wiz.current += maxHealthOf(levels) - beforeMax; // grant the new hp
    if (key === 'moveSpeed') {
        const cc = getTrait(wiz._node, CharacterControllerTrait);
        if (cc) cc.config.walkSpeed = lvlValue('moveSpeed', levels.moveSpeed);
    }
    return true;
}

script(WorldTrait, 'upgrades', (ctx) => {
    if (!env.server) return;
    const players = query(ctx, [PlayerTrait, WizardTrait]);

    listen(ctx, UpgradeStat, ({ stat }, from) => {
        const key = STAT_KEYS[stat];
        if (!key) return;
        for (const [player, wiz] of players) {
            if (player.client !== from) continue;
            tryUpgrade(wiz, key);
            return;
        }
    });
});

// ── xp orbs — litter + pickup (server), sprite decorate (client) ─────

script(WorldTrait, 'xp', (ctx) => {
    if (env.server) {
        const orbs = query(ctx, [XpOrbTrait, AabbBodyTrait, TransformTrait]);
        const wizards = query(ctx, [WizardTrait, AliveTrait, TransformTrait]);
        let topUpIn = 0;

        onTick(ctx, ({ delta }) => {
            // litter: keep ~ORB_TARGET orbs scattered, topping up on a timer.
            topUpIn -= delta;
            if (topUpIn <= 0) {
                topUpIn = ORB_RESPAWN_INTERVAL;
                if (orbs.matches.length < ORB_TARGET) {
                    const x = PLAYER_SPAWN[0] + (Math.random() - 0.5) * 2 * ORB_SPAWN_AREA;
                    const z = PLAYER_SPAWN[2] + (Math.random() - 0.5) * 2 * ORB_SPAWN_AREA;
                    spawnOrb(ctx, x, groundYAt(ctx, x, z) + 0.8, z, ORB_AMOUNT, [0, 0, 0]);
                }
            }

            // pickup: for each orb find the nearest alive wizard within the magnet
            // radius — inside grab range it's collected, otherwise it reels toward
            // them (aimed at chest height). collection is deferred — destroying nodes
            // mid-iteration is unsafe.
            const collected: Node[] = [];
            for (const [orb, orbBody, orbTransform] of orbs) {
                if (!orbBody.body) continue; // body installs on the next physics step
                const op = getWorldPosition(orbTransform);
                let target: { xp: number; _node: Node } | null = null;
                let targetX = 0;
                let targetY = 0;
                let targetZ = 0;
                let bestSq = ORB_MAGNET_RADIUS * ORB_MAGNET_RADIUS;
                for (const [wiz, , wizTransform] of wizards) {
                    const wp = getWorldPosition(wizTransform);
                    const dx = wp[0] - op[0];
                    const dy = wp[1] + CHEST_OFFSET - op[1];
                    const dz = wp[2] - op[2];
                    const d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 < bestSq) {
                        bestSq = d2;
                        target = wiz;
                        targetX = wp[0];
                        targetY = wp[1] + CHEST_OFFSET;
                        targetZ = wp[2];
                    }
                }
                if (!target) continue;

                if (bestSq <= ORB_GRAB_RADIUS * ORB_GRAB_RADIUS) {
                    target.xp += orb.amount;
                    collected.push(orb._node);
                } else {
                    // luanti-style homing via the body's velocity (setVelocity wakes it
                    // and overrides gravity for the tick): speed grows as it nears, plus
                    // the collector's own velocity so it tracks a moving target.
                    const dx = targetX - op[0];
                    const dy = targetY - op[1];
                    const dz = targetZ - op[2];
                    const dist = Math.hypot(dx, dy, dz) || 1;
                    const speed = ORB_MAGNET_PULL - dist;
                    const cc = getTrait(target._node, CharacterControllerTrait);
                    const pv = cc ? cc.state.velocity : null;
                    aabbBody.setVelocity(
                        ctx.physics.aabb,
                        orbBody.body,
                        (dx / dist) * speed + (pv ? pv[0] : 0),
                        (dy / dist) * speed + (pv ? pv[1] : 0),
                        (dz / dist) * speed + (pv ? pv[2] : 0),
                    );
                }
            }
            for (const n of collected) destroyNode(n);
        });
    }

    if (env.client) {
        const orbs = query(ctx, [XpOrbTrait, TransformTrait]);
        const BOB_FREQ = 2.5; // rad/s
        const BOB_AMP = 0.09; // m — local vertical float
        const PULSE_FREQ = 3.2; // rad/s — white shimmer
        let lastXp = -1; // local player's xp last frame; blip when it rises

        onFrame(ctx, () => {
            const time = ctx.clock.time;

            // pickup blip — our own xp is synced, so just play when it ticks up
            // (covers magnetised orbs without a dedicated command). first sight
            // seeds lastXp so we don't blip on join / initial sync.
            const self = getControlNode(ctx);
            const selfWiz = self && getTrait(self, WizardTrait);
            if (selfWiz) {
                // luanti-style: randomise pitch down a little each pickup so rapid
                // blips vary instead of machine-gunning the same sample.
                if (lastXp >= 0 && selfWiz.xp > lastXp) playMono(ctx, PickupSound, { detune: -Math.random() * 250 });
                lastXp = selfWiz.xp;
            }

            for (const [, transform] of orbs) {
                const orbNode = transform._node;
                // the orb node holds the authoritative (synced) position. the sprite
                // lives on a client-only child so we can bob + pulse it locally without
                // fighting the replicated transform. it despawns with the orb node.
                let visual = findChildByName(orbNode, 'orb-visual');
                if (!visual) {
                    visual = createNode({ name: 'orb-visual' });
                    addTrait(visual, TransformTrait);
                    addTrait(visual, SpriteTrait, { sprite: XpOrbSprite, mode: 'billboard', width: 7, height: 7, worldScale: 1 / 20 });
                    addChild(orbNode, visual);
                }

                const phase = orbNode.id * 1.7; // de-sync the bob/pulse between orbs
                setPosition(getTrait(visual, TransformTrait)!, [0, Math.sin(time * BOB_FREQ + phase) * BOB_AMP, 0]);

                // gentle white shimmer: mix the tint toward white + a touch of glow.
                const pulse = Math.sin(time * PULSE_FREQ + phase) * 0.5 + 0.5; // 0..1
                const sprite = getTrait(visual, SpriteTrait)!;
                sprite.tint[0] = sprite.tint[1] = sprite.tint[2] = 1;
                sprite.tint[3] = pulse * 0.25; // up to 25% toward white
                sprite.glow = pulse * 0.3; // slight additive glow
            }
        });
    }
});

// ── server: NPC dummy wizards — spawn + steering ────────────────────
// spawns a few killable dummy wizards at fixed homes (onInit), then each tick
// steers them. pathfinding is voxelNav (in the core lib); the *steering* half
// lives here — repath to the nearest combatant on a timer and walk the
// waypoints (look + move + jump), or circle-strafe + fire when in range.

script(WorldTrait, 'combat-npcs', (ctx) => {
    if (!env.server) return;

    // homes near the player spawn. spawned a little high — the character
    // controller's gravity settles them onto the ground (same as players,
    // who join at y=2 and fall).
    const HOMES: Vec3[] = [
        [4.5, 2, 8.5],
        [12.5, 2, 8.5],
        [8.5, 2, 12.5],
    ];
    const NPC_COLORS: Vec4[] = [
        [0.15, 0.75, 0.3, 0.8], // green
        [0.95, 0.6, 0.1, 0.8], // orange
        [0.1, 0.7, 0.85, 0.8], // teal
    ];

    const CHASE_RANGE = 30; // m — only pursue a player within this
    const REPATH_INTERVAL = 0.5; // s between repaths
    const NPC_REPATHS_PER_TICK = 2; // round-robin cap: at most this many A* runs per tick (spreads + de-bunches repaths)
    const NPC_PATH_MAX_ITERATIONS = 5000; // A* node-expansion cap — bounds the unreachable/far-goal blowup
    const WAYPOINT_REACHED = 0.7; // m (horizontal) to advance to the next waypoint
    const CAST_RANGE = 16; // m — within this (with a clear shot) the NPC strafes + fires
    // burst-fire as a held window: the AI just opens `casting` for a beat (the
    // server firing tick fires at stats.fireRate while it's held → a blob of
    // shots), then closes it for a longer pause. same arm-raise-held feel as
    // before, now with zero shot-spawning logic in the AI.
    const NPC_BURST_DURATION = 0.8; // s — casting held open (≈ 3 shots at fireRate 3)
    const NPC_BURST_PAUSE = 2.0; // s — casting closed between bursts
    const STRAFE_FLIP_MIN = 0.8; // s — min before reversing strafe direction
    const STRAFE_FLIP_MAX = 2.2; // s — max
    const JUMP_INTERVAL_MIN = 1.5; // s — min between hops while engaged
    const JUMP_INTERVAL_MAX = 3.5; // s — max

    // npc leveling: each (re)spawn, scale to the players' average level ± spread
    // (floored), then spend all points down an archetype's priority order.
    const MIN_NPC_LEVEL = 1;
    const NPC_LEVEL_SPREAD = 2; // ± levels around the player average
    const NPC_ARCHETYPES: StatKey[][] = [
        ['damage', 'maxHealth', 'moveSpeed', 'fireRate', 'regenRate', 'speed', 'splashRadius', 'knockback'], // bruiser
        ['damage', 'speed', 'fireRate', 'knockback', 'splashRadius', 'moveSpeed', 'maxHealth', 'regenRate'], // sniper
        ['maxHealth', 'regenRate', 'splashRadius', 'knockback', 'moveSpeed', 'damage', 'fireRate', 'speed'], // tank
    ];

    const npcs = query(ctx, [NpcTrait, CharacterControllerTrait, TransformTrait]);
    // free-for-all: any alive entity with health is a candidate target (players
    // AND other NPCs); each NPC skips itself.
    const combatants = query(ctx, [WizardTrait, AliveTrait, TransformTrait]);
    const players = query(ctx, [PlayerTrait, WizardTrait]); // for the player-level average

    // average level of alive players (0 if none).
    const avgPlayerLevel = (): number => {
        let sum = 0;
        let n = 0;
        for (const [player, wiz] of players) {
            if (!getTrait(player._node, AliveTrait)) continue;
            sum += levelForXp(wiz.xp);
            n++;
        }
        return n > 0 ? sum / n : 0;
    };

    // set an npc near the player average level (± spread, floored). once per life;
    // xp orbs picked up while fighting raise it further during the life.
    const setNpcFloor = (wiz: WizardTrait): void => {
        const target = Math.max(MIN_NPC_LEVEL, Math.round(avgPlayerLevel() + (Math.random() * 2 - 1) * NPC_LEVEL_SPREAD));
        wiz.xp = Math.max(wiz.xp, xpForLevel(target)); // grant the level (upward only)
    };

    // spend every available point down the archetype priority (tryUpgrade caps +
    // spills). called each tick so points from the baseline AND from orb pickups are
    // allocated as they arrive — the npc keeps speccing into its build as it grows.
    const spendNpcPoints = (wiz: WizardTrait, archetype: StatKey[]): void => {
        let guard = 64;
        while (availablePoints(wiz.xp, wiz.stats.levels) > 0 && guard-- > 0) {
            let spent = false;
            for (const key of archetype) {
                if (tryUpgrade(wiz, key)) {
                    spent = true;
                    break;
                }
            }
            if (!spent) break; // everything capped
        }
    };

    type Brain = { path: Vec3[]; waypoint: number; repathIn: number; fireWindowIn: number; firing: boolean; strafeDir: number; strafeIn: number; jumpIn: number; leveled: boolean };
    const brains = new Map<number, Brain>();

    const worldToCell = (p: Vec3): Vec3 => [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])];

    // stop walking.
    const idle = (controller: CharacterControllerTrait) => {
        controller.input.move[0] = 0;
        controller.input.move[1] = 0;
        controller.input.jump = false;
    };

    // turn to look from one world point toward another (yaw only).
    const face = (controller: CharacterControllerTrait, fromX: number, fromZ: number, toX: number, toZ: number) => {
        controller.input.look[1] = Math.atan2(-(toX - fromX), -(toZ - fromZ));
    };

    // cheap sampled line-of-sight: any non-air cell between the two points
    // blocks the shot (so NPCs don't fire through walls).
    const clearShot = (from: Vec3, to: Vec3): boolean => {
        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        const dz = to[2] - from[2];
        const steps = Math.ceil(Math.hypot(dx, dy, dz));
        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            if (getBlock(ctx.voxels, Math.floor(from[0] + dx * t), Math.floor(from[1] + dy * t), Math.floor(from[2] + dz * t)) !== BLOCK_AIR) {
                return false;
            }
        }
        return true;
    };

    onInit(ctx, () => {
        HOMES.forEach((home, i) => {
            const node = createNode({ name: `npc-wizard-${i}` });
            setPosition(addTrait(node, TransformTrait), home);
            addCharacter(node); // mounts the 6-bone rig synchronously
            // physics-grounded like a player: the server (owner of this
            // ownerless node) runs the controller sim — gravity, ground,
            // slopes. the steering below writes `input.move` / `look`;
            // idle (move = [0,0]) just stands.
            addTrait(node, CharacterControllerTrait);
            addChild(ctx.node, node);

            // WizardTrait drives the client-side hat tint by color and names the
            // dummy on the board.
            addTrait(node, WizardTrait, { color: NPC_COLORS[i % NPC_COLORS.length], name: `Dummy ${i + 1}` });
            attachGear(node); // staff + hat onto the rig

            // combat state: killable dummy that respawns at home. WizardTrait
            // carries the health pool; AliveTrait marks it killable.
            addTrait(node, AliveTrait);
            addTrait(node, NpcTrait, { homeX: home[0], homeY: home[1], homeZ: home[2], archetype: i % NPC_ARCHETYPES.length });
        });
    });

    onTick(ctx, ({ delta }) => {
        const now = ctx.clock.time;
        // round-robin A* across ticks: a per-tick budget so many NPCs coming due on
        // the same tick don't all pathfind at once (the source of the tick spikes).
        let repathBudget = NPC_REPATHS_PER_TICK;
        for (const [npc, controller, transform] of npcs) {
            // the server owns npcs, so it authors their held `casting` intent (the
            // same input the player's client authors for itself). default it closed
            // each tick → any non-engaged exit (dead, no target, out of range) holds
            // fire; the engaged branch below re-opens it for the burst window.
            const wiz = getTrait(npc._node, WizardTrait);
            if (wiz) wiz.casting = false;

            let brain = brains.get(npc._node.id);
            if (!brain) {
                brain = {
                    path: [],
                    waypoint: 0,
                    repathIn: 0,
                    fireWindowIn: Math.random() * NPC_BURST_PAUSE,
                    firing: false,
                    strafeDir: Math.random() < 0.5 ? 1 : -1,
                    strafeIn: 0,
                    jumpIn: Math.random() * JUMP_INTERVAL_MAX,
                    leveled: false,
                };
                brains.set(npc._node.id, brain);
            }

            // dead NPCs (no AliveTrait) just stand until they respawn; re-arm the
            // once-per-life leveling for their next spawn.
            if (!getTrait(npc._node, AliveTrait)) {
                brain.leveled = false;
                idle(controller);
                continue;
            }

            // on (re)spawn: set the baseline level near the players. then every tick
            // spend any available points — from that baseline OR from xp orbs picked
            // up while fighting — down the archetype build.
            if (wiz && !brain.leveled) {
                setNpcFloor(wiz);
                brain.leveled = true;
            }
            if (wiz) spendNpcPoints(wiz, NPC_ARCHETYPES[npc.archetype]!);

            const pos = getWorldPosition(transform);

            // nearest alive combatant (other than self) within chase range.
            let target: Vec3 | null = null;
            let bestDistSq = CHASE_RANGE * CHASE_RANGE;
            for (const [, , otherTransform] of combatants) {
                if (otherTransform._node.id === npc._node.id) continue; // not myself
                const pp = getWorldPosition(otherTransform);
                const dx = pp[0] - pos[0];
                const dy = pp[1] - pos[1];
                const dz = pp[2] - pos[2];
                const distSq = dx * dx + dy * dy + dz * dz;
                if (distSq < bestDistSq) {
                    bestDistSq = distSq;
                    target = [pp[0], pp[1], pp[2]];
                }
            }

            if (!target) {
                idle(controller);
                continue;
            }

            // engaged: within cast range with a clear shot → circle-strafe the
            // target, hop intermittently, and hold a burst window open (don't close to melee).
            const eye: Vec3 = [pos[0], pos[1] + EYE_HEIGHT, pos[2]];
            const aimPoint: Vec3 = [target[0], target[1] + CHEST_OFFSET, target[2]];
            const toAimX = aimPoint[0] - eye[0];
            const toAimY = aimPoint[1] - eye[1];
            const toAimZ = aimPoint[2] - eye[2];
            const inCastRange = toAimX * toAimX + toAimY * toAimY + toAimZ * toAimZ < CAST_RANGE * CAST_RANGE;
            if (inCastRange && clearShot(eye, aimPoint)) {
                // aim at the target: yaw (face) + pitch, written into the same
                // `look` the player's camera drives. the server firing tick reads
                // it via lookDirection — identical path for npcs and players.
                face(controller, pos[0], pos[2], target[0], target[2]);
                const dist = Math.hypot(toAimX, toAimY, toAimZ) || 1;
                controller.input.look[2] = Math.acos(Math.max(-1, Math.min(1, -toAimY / dist))); // pitch

                // strafe sideways (facing the player → move[0] is left/right),
                // reversing direction on a jittered timer so they weave both ways.
                brain.strafeIn -= delta;
                if (brain.strafeIn <= 0) {
                    brain.strafeDir = -brain.strafeDir;
                    brain.strafeIn = STRAFE_FLIP_MIN + Math.random() * (STRAFE_FLIP_MAX - STRAFE_FLIP_MIN);
                }
                controller.input.move[0] = brain.strafeDir;
                controller.input.move[1] = 0;

                // hop intermittently (one-tick press → single jump).
                brain.jumpIn -= delta;
                controller.input.jump = brain.jumpIn <= 0;
                if (brain.jumpIn <= 0) brain.jumpIn = JUMP_INTERVAL_MIN + Math.random() * (JUMP_INTERVAL_MAX - JUMP_INTERVAL_MIN);

                // hold the burst window open / closed; the server fires at
                // stats.fireRate for as long as `casting` is held.
                brain.fireWindowIn -= delta;
                if (brain.fireWindowIn <= 0) {
                    brain.firing = !brain.firing;
                    brain.fireWindowIn = brain.firing ? NPC_BURST_DURATION : NPC_BURST_PAUSE;
                }
                if (wiz) wiz.casting = brain.firing;
                continue;
            }

            // repath on a timer toward the current nearest player — but only while the
            // per-tick budget holds. an NPC that comes due past the budget keeps
            // repathIn ≤ 0 and is serviced on a later tick (and resetting it then
            // staggers it off the others, so the bunching doesn't recur).
            brain.repathIn -= delta;
            if (brain.repathIn <= 0 && repathBudget > 0) {
                repathBudget--;
                brain.repathIn = REPATH_INTERVAL;
                brain.path = voxelNav.findGroundPath(ctx.voxels, worldToCell(pos), worldToCell(target), { maxIterations: NPC_PATH_MAX_ITERATIONS }) ?? [];
                brain.waypoint = 1; // skip our own starting cell
            }

            // advance past waypoints we've effectively reached (horizontal).
            while (brain.waypoint < brain.path.length) {
                const cell = brain.path[brain.waypoint]!;
                const hx = cell[0] + 0.5 - pos[0];
                const hz = cell[2] + 0.5 - pos[2];
                if (hx * hx + hz * hz > WAYPOINT_REACHED * WAYPOINT_REACHED) break;
                brain.waypoint++;
            }

            if (brain.waypoint >= brain.path.length) {
                idle(controller);
                continue;
            }

            // steer toward the current waypoint: face it (yaw) and walk forward.
            const cell = brain.path[brain.waypoint]!;
            controller.input.look[1] = Math.atan2(-(cell[0] + 0.5 - pos[0]), -(cell[2] + 0.5 - pos[2]));
            controller.input.move[0] = 0;
            controller.input.move[1] = 1;
            // jump when the waypoint steps up above our feet.
            controller.input.jump = cell[1] > Math.floor(pos[1]);
        }
    });
});

// ── client: impact / death / damage / trail particles ───────────────

script(WorldTrait, 'combat-vfx', (ctx) => {
    if (!env.client) return;

    const projectiles = query(ctx, [ProjectileTrait, TransformTrait]);

    // for a terrain hit we reuse the block's auto-derived dust SPRITE, but in our
    // own particle (our motion + spawn opts) rather than its dust particle — so we
    // keep full control. cached per sprite (a ParticleHandle is pure data).
    // dust motion: stronger gravity than the stock `particleUpdate.dust` (−20) so the
    // burst flies out then snaps back down, with less drag so it carries further.
    const dustMotion: typeof particleUpdate.dust = (pool, i, dt, voxels) => {
        particleUpdate.gravity(pool, i, dt, -36);
        particleUpdate.drag(pool, i, dt, 0.97);
        particleUpdate.integrate(pool, i, dt);
        particleUpdate.collideSlide(pool, i, dt, voxels);
    };
    const dustFx = new Map<string, ParticleHandle>();
    const dustParticleFor = (sprite: SpriteHandle): ParticleHandle => {
        let p = dustFx.get(sprite.spriteId);
        if (!p) {
            const id = `wizards:dust:${sprite.spriteId}`;
            p = { typeId: id, name: id, dependency: { registry: 'particles', id }, sprite, playback: 'stretch', fps: 0, update: dustMotion, glow: 0, tint: [1, 1, 1, 1] };
            dustFx.set(sprite.spriteId, p);
        }
        return p;
    };

    listen(ctx, ImpactCommand, ({ pos, fizzle, block }) => {
        const dust = block > 0 ? ctx.blocks.particles[block]?.dust : undefined;
        const count = fizzle ? 3 : dust && dust.length ? 48 : 14; // way more debris for terrain
        const speed = fizzle ? 3 : 6.5;
        for (let i = 0; i < count; i++) {
            const d = randomDir();
            if (dust && dust.length) {
                // block dust: its sprite, our control — burst up + out, then the
                // dust motion (gravity + terrain collide) drops + settles it.
                spawnParticle(ctx, dustParticleFor(dust[i % dust.length]!.sprite), pos as Vec3, {
                    lifetime: varyLife(1.2),
                    size: 0.14,
                    glow: 0.4,
                    tint: [1.4, 1.4, 1.4, 1], // a touch lighter than the raw block texture
                    velX: d[0] * 14, // fly out hard (horizontal), then gravity arcs them down
                    velY: Math.abs(d[1]) * 7 + 2,
                    velZ: d[2] * 14,
                });
            } else {
                spawnParticle(ctx, ImpactFx, pos as Vec3, {
                    lifetime: varyLife(0.6),
                    size: 0.12,
                    glow: 1,
                    velX: d[0] * speed,
                    velY: d[1] * speed,
                    velZ: d[2] * speed,
                });
            }
        }
    });

    listen(ctx, DeathCommand, ({ pos }) => {
        const at: Vec3 = [pos[0], pos[1] + 1, pos[2]];
        for (let i = 0; i < 40; i++) {
            const d = randomDir();
            spawnParticle(ctx, DeathFx, at, {
                lifetime: varyLife(1.8),
                size: 0.14,
                glow: 1,
                velX: d[0] * 8,
                velY: Math.abs(d[1]) * 9 + 3,
                velZ: d[2] * 8,
            });
        }
    });

    // damage feedback — a small pop for now; floating numbers later.
    listen(ctx, DamageCommand, ({ pos }) => {
        for (let i = 0; i < 6; i++) {
            const d = randomDir();
            spawnParticle(ctx, ImpactFx, pos as Vec3, {
                lifetime: varyLife(0.7),
                size: 0.08,
                emissive: 1,
                velX: d[0] * 3.5,
                velY: d[1] * 3.5 + 1.5,
                velZ: d[2] * 3.5,
            });
        }
    });

    // per frame: orient + spin each projectile locally (server drives only its
    // position, so the rotation is smooth here, not a network round-trip), and
    // emit a trail particle from it.
    let frameNo = 0;
    onFrame(ctx, () => {
        frameNo++;
        const now = ctx.clock.time;
        for (const [projectile, transform] of projectiles) {
            // per-projectile roll: a stable id-hash gives each bolt its own spin
            // direction (sign) + speed (0.5–1.5×) for visual variety. the angle is
            // derived from spawnTime (stateless). aim (synced) × local roll → faces
            // travel, rolls around it.
            const ph = hash32(projectile._node.id, 0);
            const spinSpeed = PROJECTILE_SPIN_SPEED * (0.5 + (hashUnit(ph, 6) + 0.5)) * (hashUnit(ph, 7) < 0 ? -1 : 1);
            quat.setAxisAngle(_rotation, PROJECTILE_SPIN_AXIS, spinSpeed * (now - projectile.spawnTime));
            setQuaternion(transform, quat.multiply(_orientation, projectile.aim, _rotation));
            const p = getWorldPosition(transform);
            // one hash per projectile-frame drives the trail variant, scatter + seed.
            const h = hash32(projectile._node.id, frameNo);
            spawnParticle(ctx, TrailVariants[h % TrailVariants.length], [p[0], p[1], p[2]], {
                // hash-varied lifetime (deterministic, ±35% around 0.6s) so the
                // trail doesn't pop out in lockstep.
                lifetime: 0.6 * (0.65 + (hashUnit(h, 4) + 0.5) * 0.7),
                size: 0.1,
                glow: 1,
                seed: h,
                velX: hashUnit(h, 1) * 1.4,
                velY: hashUnit(h, 2) * 1.4,
                velZ: hashUnit(h, 3) * 1.4,
            });
        }
    });
});

// ── client: wizard visuals ──────────────────────────────────────────
// everything about how a wizard looks on the client (gear is attached at the
// spawn sites). per wizard: tint the hat to its colour, raise the right arm while
// it's casting (the replicated `casting` flag), flash the body red on taking
// damage, dither out on death / back in on respawn, and on death drop a
// client-only sway-fall hat. the arm-raise composes in onPostAnimate (after
// CharacterTrait's procedural swing); the rest is plain per-frame mesh work.

script(WorldTrait, 'wizard-visuals', (ctx) => {
    if (!env.client) return;

    const wizards = query(ctx, [WizardTrait, TransformTrait]);

    const armRaiseAngle = degreesToRadians(80); // arm_right local X — staff lifts toward the aim at full raise
    const raiseEaseRate = 8; // 1/s — arm eases up while casting / down when it stops
    const FADE_SPEED = 6; // 1/s — death dither lerp (~0.5s in/out)
    const NAMEPLATE_MAX_DIST = 30; // m — hide nameplates beyond this
    const _npRay = createVoxelRaycastResult(); // reused for nameplate occlusion checks

    type Hat = { node: Node; spawnTime: number; startX: number; startY: number; startZ: number; floorY: number; baseRot: Quat };
    const state = new Map<number, { dither: number; dead: boolean; flash: number; prevHealth: number; npSig: string; hatLevel: number }>();
    const hats: Hat[] = [];

    // red tint + glow on the body meshes only — prune the hat/staff subtrees.
    const flashBody = (entityNode: Node, flash: number) => {
        FLASH_TINT[3] = flash;
        traverse(entityNode, (n) => {
            if (n.name === 'wizard:hat' || n.name === 'wizard:staff') return false; // skip accessories
            const mesh = getTrait(n, MeshTrait);
            if (mesh) {
                setMeshTint(mesh, FLASH_TINT);
                setMeshGlow(mesh, flash);
            }
        });
    };

    // drop a client-only hat at the entity's *visual* hat pose (so it lands where
    // this client sees the hat, not the server rig) to sway-fall and despawn.
    const dropHat = (entityNode: Node, now: number) => {
        const equipped = findChildByName(entityNode, 'wizard:hat');
        if (!equipped) return;
        const wp = getWorldPosition(getTrait(equipped, TransformTrait)!);
        const wq = getWorldQuaternion(getTrait(equipped, TransformTrait)!);
        const feet = getWorldPosition(getTrait(entityNode, TransformTrait)!);
        const wizard = getTrait(entityNode, WizardTrait);
        const color: Vec4 = wizard ? hexTint(tierColor(levelForXp(wizard.xp))) : [1, 1, 1, 1];

        const node = cloneModel(wizardModels.nodes.hat); // client-created → local only
        node.name = 'falling-hat';
        const transform = getTrait(node, TransformTrait)!;
        setPosition(transform, [wp[0], wp[1], wp[2]]);
        setQuaternion(transform, [wq[0], wq[1], wq[2], wq[3]]);
        traverse(node, (n) => {
            const mesh = getTrait(n, MeshTrait);
            if (mesh) setMeshTint(mesh, color);
        });
        addChild(ctx.node, node);
        hats.push({ node, spawnTime: now, startX: wp[0], startY: wp[1], startZ: wp[2], floorY: feet[1] + 0.1, baseRot: [wq[0], wq[1], wq[2], wq[3]] });
    };

    // build a wizard's nameplate DOM — name + level over an hp bar, outlined for
    // legibility. only called when a value changes (diff-gated by the caller).
    const paintNameplate = (el: HTMLElement, name: string, level: number, hp: number, max: number) => {
        // row 1: name.
        // row 1: level badge + name.
        const top = document.createElement('div');
        top.style.cssText = 'display:flex; align-items:center; justify-content:center; gap:4px; margin-bottom:2px;';
        const lvlBox = document.createElement('div');
        lvlBox.textContent = `Lv ${level}`;
        lvlBox.style.cssText = `flex:none; padding:1px 4px; box-sizing:border-box; background:${tierColor(level)}; border:1px solid #000; border-radius:4px; font-size:9px; line-height:1; font-weight:bold; color:#fff; ${HUD_OUTLINE}`;
        const nameEl = document.createElement('div');
        nameEl.textContent = name; // textContent = safe from username markup
        nameEl.style.cssText = `font-size:12px; font-weight:bold; color:#fff; white-space:nowrap; ${HUD_OUTLINE}`;
        top.append(lvlBox, nameEl);
        // row 2: health bar with N/N.
        const bar = document.createElement('div');
        bar.style.cssText =
            'position:relative; display:flex; align-items:center; justify-content:center; width:92px; height:13px; margin:0 auto; background:#222; border:1px solid #000; border-radius:4px; overflow:hidden; box-sizing:border-box;';
        const pct = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
        const fill = document.createElement('div');
        fill.style.cssText = `position:absolute; left:0; top:0; bottom:0; width:${pct * 100}%; background:${pct > 0.5 ? '#22c55e' : pct > 0.25 ? '#eab308' : '#dc2626'};`;
        const hpText = document.createElement('div');
        hpText.textContent = `${Math.ceil(hp)}/${max}`;
        hpText.style.cssText = `position:relative; font-size:9px; font-weight:bold; color:#fff; ${HUD_OUTLINE}`;
        bar.append(fill, hpText);
        el.replaceChildren(top, bar);
    };

    // per-frame mesh reactions to each wizard's state: hat tint, damage flash,
    // death dither — plus the dropped-hat sim.
    onFrame(ctx, ({ delta }) => {
        const now = ctx.clock.time;
        const controlId = getControlNode(ctx)?.id ?? -1; // skip our own nameplate
        const camPos = getWorldPosition(getTrait(resolveCamera(ctx).node, TransformTrait)!);

        for (const [wizard, transform] of wizards) {
            const node = transform._node;

            const dead = wizard.current <= 0;
            let s = state.get(node.id);
            if (!s) {
                s = { dither: 0, dead: false, flash: 0, prevHealth: wizard.current, npSig: '', hatLevel: -1 };
                state.set(node.id, s);
            }

            // hat: tint to the level tier + scale with level (re-applied on a level
            // change, and once the replicated hat first appears). resets toward gray
            // + base size when the wizard's levels reset on death.
            const level = levelForXp(wizard.xp);
            const hat = findChildByName(node, 'wizard:hat');
            if (hat && s.hatLevel !== level) {
                s.hatLevel = level;
                const tint = hexTint(tierColor(level));
                const scale = tierScale(level);
                const ht = getTrait(hat, TransformTrait);
                if (ht) setScale(ht, [scale, scale, scale]);
                traverse(hat, (n) => {
                    const mesh = getTrait(n, MeshTrait);
                    if (mesh) setMeshTint(mesh, tint);
                });
            }

            // damage flash: start at 1 on any health drop, decay to 0 over the
            // duration. red tint + glow on the body only.
            if (wizard.current < s.prevHealth) s.flash = 1;
            s.prevHealth = wizard.current;
            if (s.flash > 0) {
                s.flash = Math.max(0, s.flash - delta / DAMAGE_FLASH_DURATION);
                flashBody(node, s.flash); // applies 0 on the last step → resets the body
            }

            // drop the hat once, on the death transition.
            if (dead && !s.dead) dropHat(node, now);
            s.dead = dead;

            // dither the character out (dead) / back in (alive).
            const target = dead ? 1 : 0;
            if (s.dither !== target) {
                let next = s.dither + (target - s.dither) * Math.min(delta * FADE_SPEED, 1);
                if (Math.abs(next - target) < 0.01) next = target;
                s.dither = next;
                traverse(node, (n) => {
                    const mesh = getTrait(n, MeshTrait);
                    if (mesh) setMeshDither(mesh, next);
                });
            }

            // nameplate (other wizards only): name + level + hp on a billboard
            // canvas above the head; hidden when dead, far, or occluded by terrain.
            if (node.id !== controlId) {
                let plate = findChildByName(node, 'nameplate');
                if (!plate) {
                    plate = createNode({ name: 'nameplate' });
                    setPosition(addTrait(plate, TransformTrait), [0, 3.1, 0]);
                    // screen-mode html overlay at constant css size (distanceFactor null)
                    // → readable at any distance, unlike the shrinking world quad.
                    const h = addTrait(plate, HtmlTrait, { mode: 'screen', center: true, distanceFactor: null });
                    const e = h.element;
                    if (e) {
                        e.style.pointerEvents = 'none';
                        e.style.fontFamily = 'ui-monospace, monospace';
                        e.style.textAlign = 'center';
                    }
                    addChild(node, plate);
                }
                const wp = getWorldPosition(transform);
                const hx = wp[0] - camPos[0];
                const hy = wp[1] + 1.5 - camPos[1];
                const hz = wp[2] - camPos[2];
                const camDist = Math.hypot(hx, hy, hz) || 1;
                let visible = !dead && camDist < NAMEPLATE_MAX_DIST;
                if (visible) {
                    // occluded if terrain is hit before reaching the wizard.
                    raycastVoxels(_npRay, ctx.voxels, ctx.voxels.registry, camPos[0], camPos[1], camPos[2], hx / camDist, hy / camDist, hz / camDist, camDist, 0);
                    if (_npRay.hit && _npRay.distance < camDist) visible = false;
                }
                const el = getTrait(plate, HtmlTrait)!.element;
                if (el) {
                    if (!visible) {
                        el.style.visibility = 'hidden';
                        s.npSig = ''; // repaint when shown again
                    } else {
                        el.style.visibility = 'visible';
                        const level = levelForXp(wizard.xp);
                        const max = maxHealthOf(wizard.stats.levels);
                        const sig = `${wizard.name}|${level}|${wizard.current}/${max}`;
                        if (sig !== s.npSig) {
                            s.npSig = sig;
                            paintNameplate(el, wizard.name, level, wizard.current, max);
                        }
                    }
                }
            }
        }

        // sim + despawn the local falling hats.
        for (let i = hats.length - 1; i >= 0; i--) {
            const hat = hats[i]!;
            const age = now - hat.spawnTime;
            if (age > HAT_LIFETIME) {
                destroyNode(hat.node);
                hats.splice(i, 1);
                continue;
            }
            const envelope = Math.exp(-HAT_SWING_DAMPING * age);
            const swing = Math.sin(age * HAT_SWING_FREQ) * HAT_SWING_AMPLITUDE * envelope;
            const tilt = Math.sin(age * HAT_SWING_FREQ) * HAT_SWING_TILT * envelope;
            const y = Math.max(hat.floorY, hat.startY - HAT_FALL_SPEED * age);
            const transform = getTrait(hat.node, TransformTrait)!;
            setPosition(transform, [hat.startX + swing, y, hat.startZ]);
            quat.setAxisAngle(_rotation, [0, 0, 1], tilt);
            setQuaternion(transform, quat.multiply(_orientation, hat.baseRot, _rotation));
        }
    });

    // cast arm-raise — composed onto the rig *after* the procedural swing.
    onPostAnimate(ctx, ({ delta }) => {
        for (const [wizard] of wizards) {
            const target = wizard.casting ? 1 : 0;
            wizard.armRaise += (target - wizard.armRaise) * Math.min(delta * raiseEaseRate, 1);
            if (wizard.armRaise < 0.01) continue;
            const arm = findByName(wizard._node, RIG_6BONE_ARM_RIGHT);
            if (!arm) continue;
            const armTransform = getTrait(arm, TransformTrait)!;
            quat.setAxisAngle(_castArmRaise, [1, 0, 0], wizard.armRaise * armRaiseAngle);
            setQuaternion(armTransform, quat.multiply(_castArmPose, armTransform.quaternion, _castArmRaise));
        }
    });
});

// ── client: HUD ─────────────────────────────────────────────────────
// screen-space DOM into the viewport, all driven by the local player's synced
// WizardTrait: bottom-centre health + xp pill bars (styled like the stat panel),
// a top-left upgrade panel, and a top-right scoreboard. each section is diff-gated
// — the DOM is only touched when its rendered values change.

// shared with the panel: bold white text outline so HUD copy reads over any scene.
const HUD_OUTLINE = 'text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;';

script(WorldTrait, 'hud', (ctx) => {
    if (!env.client) return;
    const viewport = ctx.client?.viewport;
    if (!viewport) return;

    const wizards = query(ctx, [WizardTrait]);

    // bottom-centre: rounded health + xp pill bars, matching the stat panel — a
    // dark pill with a coloured fill behind a centred, outlined label.
    const makeBar = (fillColor: string) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative; width:300px; height:24px; border-radius:12px; background:#383838; overflow:hidden;';
        const fill = document.createElement('div');
        fill.style.cssText = `position:absolute; left:0; top:0; bottom:0; width:0%; background:${fillColor};`;
        const label = document.createElement('div');
        label.style.cssText = `position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:bold; color:#fff; ${HUD_OUTLINE}`;
        wrap.append(fill, label);
        return { wrap, fill, label };
    };
    const healthBar = makeBar('#e8324a');
    const xpBar = makeBar('#8ce06e');
    const bottom = document.createElement('div');
    bottom.style.cssText =
        `position:absolute; left:50%; bottom:24px; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; gap:6px; font-family:ui-monospace,monospace; pointer-events:none; z-index:${UILayer.hud};`;
    bottom.append(healthBar.wrap, xpBar.wrap);

    // leaderboard (top-right): a dark rounded panel with a Name | K | D table.
    const board = document.createElement('div');
    board.style.cssText = `position:absolute; top:12px; right:12px; min-width:180px; background:#383838; border-radius:10px; padding:6px 10px 8px; box-sizing:border-box; font-family:ui-monospace,monospace; font-size:12px; color:#fff; pointer-events:none; z-index:${UILayer.hud}; ${HUD_OUTLINE}`;
    const boardTitle = document.createElement('div');
    boardTitle.textContent = 'SCORES';
    boardTitle.style.cssText = 'text-align:center; font-weight:bold; margin-bottom:5px;';
    const boardGrid = document.createElement('div');
    boardGrid.style.cssText = 'display:grid; grid-template-columns:1fr auto auto; gap:3px 12px; align-items:center;';
    board.append(boardTitle, boardGrid);
    const cell = (text: string, css = ''): HTMLSpanElement => {
        const c = document.createElement('span');
        c.textContent = text; // textContent = safe from username markup
        c.style.cssText = css;
        return c;
    };

    // upgrade panel (top-left): each stat row has a tappable + button (works on
    // touch too); number keys 1–N are a desktop shortcut for the same command.
    const panel = document.createElement('div');
    panel.style.cssText = `position:absolute; top:12px; left:12px; width:240px; display:flex; flex-direction:column; gap:6px; font-family:ui-monospace,monospace; z-index:${UILayer.hud};`;
    const panelHeader = document.createElement('div');
    panelHeader.style.cssText = `align-self:center; font-weight:bold; font-size:12px; color:#fff; pointer-events:none; ${HUD_OUTLINE}`;
    panel.append(panelHeader);
    const rowEls = STAT_KEYS.map((key, i) => {
        const color = STAT_TABLE[key].color;
        // dark rounded pill: a colour fill grows with the stat's level behind a
        // bold outlined label; a [N] keytag and a colour-matched + button at the right.
        const pill = document.createElement('div');
        pill.style.cssText = 'position:relative; display:flex; align-items:center; height:28px; border-radius:14px; background:#383838; overflow:hidden; padding-right:3px;';
        const fill = document.createElement('div');
        fill.style.cssText = `position:absolute; left:0; top:0; bottom:0; width:0%; background:${color}; opacity:0.55;`;
        const name = document.createElement('span');
        name.textContent = STAT_TABLE[key].label;
        name.style.cssText = `position:relative; flex:1; text-align:center; padding-left:12px; font-weight:bold; font-size:13px; color:#fff; white-space:nowrap; pointer-events:none; ${HUD_OUTLINE}`;
        const keyTag = document.createElement('span');
        keyTag.textContent = `[${i + 1}]`;
        keyTag.style.cssText = `position:relative; margin:0 6px; font-size:11px; color:#fff; pointer-events:none; ${HUD_OUTLINE}`;
        const btn = document.createElement('button');
        btn.textContent = '+';
        btn.style.cssText = `position:relative; flex:none; width:30px; height:22px; border:none; border-radius:8px; background:${color}; color:#1c1c1c; font-weight:bold; font-size:17px; line-height:1; padding:0; cursor:pointer;`;
        btn.onclick = () => send(ctx, UpgradeStat, { stat: i });
        pill.append(fill, name, keyTag, btn);
        panel.append(pill);
        return { fill, btn };
    });

    // number keys 1..N → upgrade the matching stat.
    const onKey = (e: KeyboardEvent) => {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= STAT_KEYS.length) send(ctx, UpgradeStat, { stat: n - 1 });
    };

    onInit(ctx, () => {
        viewport.append(bottom, board, panel);
        window.addEventListener('keydown', onKey);
    });
    onDispose(ctx, () => {
        bottom.remove();
        board.remove();
        panel.remove();
        window.removeEventListener('keydown', onKey);
    });

    let healthSig = ''; // each section only touches the DOM when its values change
    let boardSig = '';
    let panelSig = '';
    let xpSig = '';
    onFrame(ctx, () => {
        // local player's wizard drives the health bar + upgrade panel.
        const controlNode = getControlNode(ctx);
        const wiz = controlNode && getTrait(controlNode, WizardTrait);

        // health bar — current vs the derived max.
        const max = wiz ? maxHealthOf(wiz.stats.levels) : 0;
        const hSig = wiz ? `${wiz.current}/${max}` : '';
        if (hSig !== healthSig) {
            healthSig = hSig;
            if (!wiz) {
                bottom.style.display = 'none';
            } else {
                bottom.style.display = 'flex'; // restore flex (not '', which reverts to block)
                const pct = max > 0 ? Math.max(0, Math.min(1, wiz.current / max)) : 0;
                healthBar.fill.style.width = `${pct * 100}%`;
                healthBar.label.textContent = `${Math.ceil(wiz.current)} / ${max}`;
            }
        }

        // xp bar — progress through the current level.
        const xSig = wiz ? `${wiz.xp}` : '';
        if (xSig !== xpSig) {
            xpSig = xSig;
            if (wiz) {
                const lvl = levelForXp(wiz.xp);
                const cur = xpForLevel(lvl);
                const next = xpForLevel(lvl + 1);
                const prog = next > cur ? (wiz.xp - cur) / (next - cur) : 0;
                xpBar.fill.style.width = `${Math.max(0, Math.min(1, prog)) * 100}%`;
                xpBar.label.textContent = `LVL ${lvl}  ·  ${next - wiz.xp} EXP to next level`;
            }
        }

        // upgrade panel — level, points remaining, per-stat level/max + buttons.
        const lvls = wiz ? wiz.stats.levels : null;
        const pSig = wiz && lvls ? `${levelForXp(wiz.xp)}:${availablePoints(wiz.xp, lvls)}:${STAT_KEYS.map((k) => lvls[k]).join('')}` : '';
        if (pSig !== panelSig) {
            panelSig = pSig;
            if (!wiz || !lvls) {
                panel.style.display = 'none';
            } else {
                panel.style.display = 'flex'; // restore flex (not '', which reverts to block)
                const pts = availablePoints(wiz.xp, lvls);
                panelHeader.textContent = pts > 0 ? `${pts} point${pts === 1 ? '' : 's'} to spend` : '';
                STAT_KEYS.forEach((k, i) => {
                    const statMax = STAT_TABLE[k].max;
                    rowEls[i]!.fill.style.width = `${(lvls[k] / statMax) * 100}%`;
                    const canUp = pts > 0 && lvls[k] < statMax;
                    rowEls[i]!.btn.disabled = !canUp;
                    rowEls[i]!.btn.style.opacity = canUp ? '1' : '0.35';
                    rowEls[i]!.btn.style.cursor = canUp ? 'pointer' : 'default';
                });
            }
        }

        // leaderboard — every combatant, sorted by kills then fewest deaths.
        const rows = wizards.matches.map(([w]) => w).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        const bSig = rows.map((w) => `${w.name}:${w.kills}/${w.deaths}`).join(',');
        if (bSig !== boardSig) {
            boardSig = bSig;
            boardGrid.replaceChildren(
                cell('', 'font-weight:bold;'), // name column header (blank)
                cell('K', 'font-weight:bold; text-align:center; color:#9be88a;'),
                cell('D', 'font-weight:bold; text-align:center; color:#e88a8a;'),
                ...rows.flatMap((w) => [
                    cell(w.name || '…', 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:130px;'),
                    cell(`${w.kills}`, 'text-align:center;'),
                    cell(`${w.deaths}`, 'text-align:center;'),
                ]),
            );
        }
    });
});

// ── client: death camera ────────────────────────────────────────────
// on death the server removes our PlayerControllerTrait — that frees the camera,
// stops input, and (since the viewmodel keys off PC) hides the first-person
// staff. this takes over while PC is gone: zero any in-flight movement so the
// body doesn't glide, and orbit the camera around the death spot. respawn re-adds
// PC, handing control straight back.

const _deathLookMat = mat4.create();
const _deathCamQuat = quat.create();

script(WorldTrait, 'death-cam', (ctx) => {
    if (!env.client) return;

    const ORBIT_SPEED = 0.6; // rad/s around the death spot
    const ORBIT_RADIUS = 4; // m out
    const ORBIT_HEIGHT = 2.5; // m up
    const LOOK_HEIGHT = 1; // m above the spot to aim at
    let angle = 0;
    let relockTries = 0; // re-grab attempts after death frees the pointer lock

    onFrame(ctx, ({ delta }) => {
        const node = getControlNode(ctx);
        if (!node || getTrait(node, PlayerControllerTrait)) {
            relockTries = 3; // alive: re-arm the re-grab for the next death
            return; // alive → PC drives
        }

        // the PlayerController releases pointer lock when it's removed on death.
        // re-grab it (a few tries to cover the async unlock) so look-control hands
        // back seamlessly when the PC returns on respawn — no re-click needed.
        if (relockTries > 0 && !document.pointerLockElement) {
            relockTries--;
            ctx.client?.domElement?.requestPointerLock?.();
        }

        // PC is gone, so nothing else writes the controller input — stop the body.
        const cc = getTrait(node, CharacterControllerTrait);
        if (cc) {
            cc.input.move[0] = 0;
            cc.input.move[1] = 0;
            cc.input.jump = false;
        }

        // orbit the (free) camera node around the death spot.
        const center = getWorldPosition(getTrait(node, TransformTrait)!);
        angle += delta * ORBIT_SPEED;
        const camPos: Vec3 = [
            center[0] + Math.cos(angle) * ORBIT_RADIUS,
            center[1] + ORBIT_HEIGHT,
            center[2] + Math.sin(angle) * ORBIT_RADIUS,
        ];
        const camTransform = getTrait(resolveCamera(ctx).node, TransformTrait)!;
        setWorldPosition(camTransform, camPos);
        mat4.targetTo(_deathLookMat, camPos, [center[0], center[1] + LOOK_HEIGHT, center[2]], [0, 1, 0]);
        quat.fromMat4(_deathCamQuat, _deathLookMat);
        setWorldQuaternion(camTransform, _deathCamQuat);
    });
});
