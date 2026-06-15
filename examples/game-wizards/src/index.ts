import {
    addChild,
    addCharacter,
    addTrait,
    BLOCK_AIR,
    broadcast,
    chat,
    CharacterControllerTrait,
    cloneModel,
    command,
    createNode,
    destroyNode,
    ENVIRONMENT_OVERWORLD,
    env,
    findByName,
    findChildByName,
    getBlock,
    getControlNode,
    getTrait,
    getWorldMatrix,
    getWorldPosition,
    getWorldQuaternion,
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
    query,
    removeTrait,
    resolveCamera,
    rooms,
    script,
    SERVER_TO_CLIENT,
    setBlock,
    setEnvironment,
    setEnvironmentTime,
    setMeshDither,
    setMeshGlow,
    setMeshLitMin,
    setMeshTint,
    setPosition,
    setQuaternion,
    setScale,
    setWorldPosition,
    setWorldQuaternion,
    spawnParticle,
    sync,
    TransformTrait,
    trait,
    traverse,
    use,
    voxelNav,
    WorldTrait,
} from 'bongle';
import { RIG_6BONE_ARM_RIGHT, RIG_6BONE_HAND_RIGHT, RIG_6BONE_HEAD } from 'bongle/avatar/rig';
import { blocks, particlePresets, sprites } from 'bongle/starter';
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
    // owner is holding fire — the local player's client for its own player, the
    // server's npc AI for the dummies. it's the single input both share: the
    // server reads it (+ the synced look + stats.fireRate) to spawn shots
    // uniformly, and every client reads it to drive the third-person arm-raise.
    casting: false,
    // how this wizard fires — synced (set once at spawn) so the client can predict
    // its own muzzle/viewmodel cadence at the same rate the server actually fires.
    stats: { fireRate: 3 } as { fireRate: number }, // shots/sec
    // server-only clock of this wizard's last spawned shot — paces the firing tick
    // against stats.fireRate. not synced.
    lastFireTime: -999,
    // client-side timestamp of the LOCAL player's own last predicted shot — drives
    // the first-person viewmodel jab only, for zero-latency feedback. not synced.
    lastCastTime: -999,
    // eased 0..1 arm-raise amount (client-side), toward `casting`. not synced.
    armRaise: 0,
});

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

// stats are set once at spawn (server-authored) and don't change — 'dirty' emits
// the initial value. the client needs them to predict its own fire cadence.
sync(WizardTrait, 'stats', {
    schema: pack.object({ fireRate: pack.float32() }),
    pack: (t) => t.stats,
    unpack: (v, t) => (t.stats = v),
    rate: 'dirty',
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

        // players are combat entities: full health + alive marker. damage,
        // death, respawn and regen are driven by the combat systems below.
        addTrait(playerNode, HealthTrait, { current: MAX_HEALTH, max: MAX_HEALTH });
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
type ProjectileStats = { speed: number; damage: number; damageRadius: number; terrainDamageRadius: number };
const DEFAULT_PROJECTILE_STATS: ProjectileStats = { speed: 18, damage: 3, damageRadius: 2, terrainDamageRadius: 1 };
const PROJECTILE_SPIN_SPEED = 12; // rad/s — roll around the travel axis while flying
const PROJECTILE_SPIN_AXIS: Vec3 = [0, 0, 1]; // local forward/back (node faces aim down -Z)
// staff tip in the staff node's local space: mesh max-Y from the gltf, with the
// node origin reset to [0,0,0] by the gear script. used to place the muzzle vfx.
const STAFF_TIP_LOCAL: Vec3 = [0, 1.0625, 0];

// health
const MAX_HEALTH = 10;
const REGEN_DELAY = 3; // s without damage before health regenerates
const REGEN_RATE = 1; // hp/s
const RESPAWN_DELAY = 3; // s after death before respawn

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
    }),
    pack: (t) => t.stats,
    unpack: (v, t) => (t.stats = v),
    rate: 'dirty',
});

// combat state. damage/death/respawn logic + its event vfx are server-driven
// and broadcast as messages; `current` / `max` are synced so clients can show
// a health bar. `lastDamageTime` / `lastAttacker` stay server-only.
const HealthTrait = trait('health', {
    current: MAX_HEALTH,
    max: MAX_HEALTH,
    lastDamageTime: -999,
    lastAttacker: -1,
});

// separate slices so a `current` change (every damage/regen tick) doesn't
// re-send the rarely-changing `max`. 'realtime' emits on byte-change.
sync(HealthTrait, 'current', {
    schema: pack.float32(),
    pack: (t) => t.current,
    unpack: (v, t) => (t.current = v),
    rate: 'realtime',
});

sync(HealthTrait, 'max', {
    schema: pack.float32(),
    pack: (t) => t.max,
    unpack: (v, t) => (t.max = v),
    rate: 'realtime',
});

// marker: present iff the entity is alive. removed on death, re-added on
// respawn. the health/damage systems only touch entities that have it.
const AliveTrait = trait('alive');

// marker + respawn home for non-player targets.
const NpcTrait = trait('npc', {
    homeX: 0,
    homeY: 0,
    homeZ: 0,
});

// ── messages ────────────────────────────────────────────────────────

const ImpactCommand = command('wizards.impact', SERVER_TO_CLIENT, pack.object({ pos: pack.list(pack.float32(), 3), fizzle: pack.boolean() }));
const DamageCommand = command('wizards.damage', SERVER_TO_CLIENT, pack.object({ pos: pack.list(pack.float32(), 3), amount: pack.float32() }));
const DeathCommand = command('wizards.death', SERVER_TO_CLIENT, pack.object({ pos: pack.list(pack.float32(), 3) }));

// ── particle types (client vfx) ─────────────────────────────────────
// single fixed look for now (starter sprites, self-lit). per-element
// colors arrive with the elements layer.

const TrailFx = particlePresets.smoke('wizards:trail', { sprite: sprites.smoke });
const ImpactFx = particlePresets.spark('wizards:impact', { sprite: sprites.dust });
const DeathFx = particlePresets.smoke('wizards:death', { sprite: sprites.smoke });

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
            if (now - predictedFireAt < 1 / selfWizard.stats.fireRate) return;
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
                        lifetime: 0.2,
                        size: 0.07,
                        emissive: 1,
                        velX: forward[0] * 5 + s[0] * 1.2,
                        velY: forward[1] * 5 + s[1] * 1.2,
                        velZ: forward[2] * 5 + s[2] * 1.2,
                    });
                }
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
                if (now - wizard.lastFireTime < 1 / wizard.stats.fireRate) continue;
                wizard.lastFireTime = now;

                const dir = lookDirection(controller.input.look, _fireDir);
                const aim = quat.rotationTo(quat.create(), [0, 0, -1], dir);
                const p = getWorldPosition(transform);
                const origin: Vec3 = [p[0] + dir[0] * 1.2, p[1] + EYE_HEIGHT + dir[1] * 1.2, p[2] + dir[2] * 1.2];
                spawnProjectile(ctx.node, wizard._node, origin, aim, now, DEFAULT_PROJECTILE_STATS);
            }
        });
    }
});

script(WorldTrait, 'combat-projectiles', (ctx) => {
    if (!env.server) return;

    const projectiles = query(ctx, [ProjectileTrait, TransformTrait]);
    const targets = query(ctx, [HealthTrait, AliveTrait, TransformTrait]);

    // reusable crashcat ray-query state.
    const rayCollector = createClosestCastRayCollector();
    const raySettings = createDefaultCastRaySettings();
    let rayFilter: ReturnType<typeof crashFilter.forWorld> | null = null; // built lazily once the world exists
    const _rayDir = vec3.create();

    // carve a voxel sphere + splash-damage characters within `damageRadius`,
    // then tell clients where it landed.
    const handleHit = (pos: Vec3, ownerId: number, stats: ProjectileStats) => {
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

        for (const [health, , transform] of targets) {
            if (transform._node.id === ownerId) continue; // no self-damage
            const wp = getWorldPosition(transform);
            const tx = wp[0];
            const ty = wp[1] + CHEST_OFFSET;
            const tz = wp[2];
            const ex = pos[0] - tx;
            const ey = pos[1] - ty;
            const ez = pos[2] - tz;
            if (ex * ex + ey * ey + ez * ez > stats.damageRadius * stats.damageRadius) continue;

            health.current = Math.max(0, health.current - stats.damage);
            health.lastDamageTime = ctx.clock.time;
            health.lastAttacker = ownerId;
            broadcast(ctx, DamageCommand, { pos: [tx, ty, tz], amount: stats.damage });
        }

        broadcast(ctx, ImpactCommand, { pos: [pos[0], pos[1], pos[2]], fizzle: false });
    };

    onTick(ctx, ({ delta }) => {
        const now = ctx.clock.time;
        // the rigid world — voxels live in this same crashcat world, so one cast
        // covers terrain + character bodies.
        const rigid = ctx.physics.rigid;
        rayFilter ??= crashFilter.forWorld(rigid.world); // all layers: terrain + bodies

        // resolve outside the loop — destroying nodes mid-iteration is unsafe.
        const spent: Array<{ node: Node; pos: Vec3; ownerId: number; stats: ProjectileStats; fizzle: boolean }> = [];

        for (const [projectile, transform] of projectiles) {
            const pos = transform.position;
            if (now - projectile.spawnTime > PROJECTILE_LIFETIME) {
                spent.push({ node: projectile._node, pos: [pos[0], pos[1], pos[2]], ownerId: projectile.ownerId, stats: projectile.stats, fizzle: true });
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
                spent.push({
                    node: projectile._node,
                    pos: [pos[0] + dir[0] * step * t, pos[1] + dir[1] * step * t, pos[2] + dir[2] * step * t],
                    ownerId: projectile.ownerId,
                    stats: projectile.stats,
                    fizzle: false,
                });
                continue;
            }

            // no hit — advance. server drives position only; clients own the
            // quaternion (aim + local spin) so the rotation stays smooth.
            setPosition(transform, [pos[0] + dir[0] * step, pos[1] + dir[1] * step, pos[2] + dir[2] * step]);
        }

        for (const s of spent) {
            if (s.fizzle) broadcast(ctx, ImpactCommand, { pos: s.pos, fizzle: true });
            else handleHit(s.pos, s.ownerId, s.stats);
            destroyNode(s.node);
        }
    });
});

// ── server: health, death, respawn ──────────────────────────────────

script(WorldTrait, 'combat-health', (ctx) => {
    if (!env.server) return;

    const alive = query(ctx, [HealthTrait, AliveTrait, TransformTrait]);
    const combatants = query(ctx, [WizardTrait]); // every scoreable entity (players + npcs)
    const respawns: Array<{ node: Node; at: number; pos: Vec3 }> = [];

    onTick(ctx, ({ delta }) => {
        const now = ctx.clock.time;
        const deaths: Array<{ node: Node; pos: Vec3; attacker: number }> = [];

        for (const [health, , transform] of alive) {
            if (health.current <= 0) {
                const wp = getWorldPosition(transform);
                deaths.push({ node: transform._node, pos: [wp[0], wp[1], wp[2]], attacker: health.lastAttacker });
                continue;
            }
            if (health.current < health.max && now - health.lastDamageTime >= REGEN_DELAY) {
                health.current = Math.min(health.max, health.current + REGEN_RATE * delta);
            }
        }

        for (const d of deaths) {
            removeTrait(d.node, AliveTrait);
            broadcast(ctx, DeathCommand, { pos: d.pos });

            // score + log: credit the victim a death, and the killer (if any, and
            // not self/terrain) a kill. `attacker` is the last node to damage them.
            const victim = getTrait(d.node, WizardTrait);
            if (victim) victim.deaths++;
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
            const health = getTrait(r.node, HealthTrait);
            const transform = getTrait(r.node, TransformTrait);
            if (!health || !transform) continue; // node went away
            health.current = health.max;
            health.lastDamageTime = now;
            health.lastAttacker = -1;
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

    const npcs = query(ctx, [NpcTrait, CharacterControllerTrait, TransformTrait]);
    // free-for-all: any alive entity with health is a candidate target (players
    // AND other NPCs); each NPC skips itself.
    const combatants = query(ctx, [HealthTrait, AliveTrait, TransformTrait]);

    type Brain = { path: Vec3[]; waypoint: number; repathIn: number; fireWindowIn: number; firing: boolean; strafeDir: number; strafeIn: number; jumpIn: number };
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

            // combat state: killable dummy that respawns at home.
            addTrait(node, HealthTrait, { current: MAX_HEALTH, max: MAX_HEALTH });
            addTrait(node, AliveTrait);
            addTrait(node, NpcTrait, { homeX: home[0], homeY: home[1], homeZ: home[2] });
        });
    });

    onTick(ctx, ({ delta }) => {
        const now = ctx.clock.time;
        for (const [npc, controller, transform] of npcs) {
            // the server owns npcs, so it authors their held `casting` intent (the
            // same input the player's client authors for itself). default it closed
            // each tick → any non-engaged exit (dead, no target, out of range) holds
            // fire; the engaged branch below re-opens it for the burst window.
            const wiz = getTrait(npc._node, WizardTrait);
            if (wiz) wiz.casting = false;

            // dead NPCs (no AliveTrait) just stand until they respawn.
            if (!getTrait(npc._node, AliveTrait)) {
                idle(controller);
                continue;
            }

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
                };
                brains.set(npc._node.id, brain);
            }

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

            // repath on a timer toward the current nearest player.
            brain.repathIn -= delta;
            if (brain.repathIn <= 0) {
                brain.repathIn = REPATH_INTERVAL;
                brain.path = voxelNav.findGroundPath(ctx.voxels, worldToCell(pos), worldToCell(target)) ?? [];
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

    listen(ctx, ImpactCommand, ({ pos, fizzle }) => {
        const count = fizzle ? 3 : 14;
        const speed = fizzle ? 1.5 : 3.5;
        for (let i = 0; i < count; i++) {
            const d = randomDir();
            spawnParticle(ctx, ImpactFx, pos as Vec3, {
                lifetime: 0.3,
                size: 0.12,
                emissive: 1,
                velX: d[0] * speed,
                velY: d[1] * speed,
                velZ: d[2] * speed,
            });
        }
    });

    listen(ctx, DeathCommand, ({ pos }) => {
        const at: Vec3 = [pos[0], pos[1] + 1, pos[2]];
        for (let i = 0; i < 40; i++) {
            const d = randomDir();
            spawnParticle(ctx, DeathFx, at, {
                lifetime: 1.0,
                size: 0.14,
                emissive: 1,
                velX: d[0] * 5,
                velY: Math.abs(d[1]) * 6 + 2,
                velZ: d[2] * 5,
            });
        }
    });

    // damage feedback — a small pop for now; floating numbers later.
    listen(ctx, DamageCommand, ({ pos }) => {
        for (let i = 0; i < 6; i++) {
            const d = randomDir();
            spawnParticle(ctx, ImpactFx, pos as Vec3, {
                lifetime: 0.4,
                size: 0.08,
                emissive: 1,
                velX: d[0] * 2,
                velY: d[1] * 2 + 1,
                velZ: d[2] * 2,
            });
        }
    });

    // per frame: orient + spin each projectile locally (server drives only its
    // position, so the rotation is smooth here, not a network round-trip), and
    // emit a trail particle from it.
    let spinAngle = 0;
    onFrame(ctx, ({ delta }) => {
        spinAngle += delta * PROJECTILE_SPIN_SPEED;
        quat.setAxisAngle(_rotation, PROJECTILE_SPIN_AXIS, spinAngle);
        for (const [projectile, transform] of projectiles) {
            // aim (synced once) × local roll. faces travel, rolls around it.
            setQuaternion(transform, quat.multiply(_orientation, projectile.aim, _rotation));
            const p = getWorldPosition(transform);
            spawnParticle(ctx, TrailFx, [p[0], p[1], p[2]], {
                lifetime: 0.35,
                size: 0.1,
                emissive: 1,
                velX: (Math.random() - 0.5) * 0.6,
                velY: (Math.random() - 0.5) * 0.6,
                velZ: (Math.random() - 0.5) * 0.6,
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

    const wizards = query(ctx, [WizardTrait, HealthTrait, TransformTrait]);

    const armRaiseAngle = degreesToRadians(80); // arm_right local X — staff lifts toward the aim at full raise
    const raiseEaseRate = 8; // 1/s — arm eases up while casting / down when it stops
    const FADE_SPEED = 6; // 1/s — death dither lerp (~0.5s in/out)

    type Hat = { node: Node; spawnTime: number; startX: number; startY: number; startZ: number; floorY: number; baseRot: Quat };
    const state = new Map<number, { dither: number; dead: boolean; flash: number; prevHealth: number }>();
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
        const color: Vec4 = wizard ? wizard.color : [1, 1, 1, 1];

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

    // per-frame mesh reactions to each wizard's state: hat tint, damage flash,
    // death dither — plus the dropped-hat sim.
    onFrame(ctx, ({ delta }) => {
        const now = ctx.clock.time;

        for (const [wizard, health, transform] of wizards) {
            const node = transform._node;

            // tint the hat to the wizard's colour once it appears.
            const hat = findChildByName(node, 'wizard:hat');
            if (hat) {
                traverse(hat, (n) => {
                    const mesh = getTrait(n, MeshTrait);
                    if (mesh && mesh.tint[3] === 0) setMeshTint(mesh, wizard.color); // alpha 0 = untinted
                });
            }

            const dead = health.current <= 0;
            let s = state.get(node.id);
            if (!s) {
                s = { dither: 0, dead: false, flash: 0, prevHealth: health.current };
                state.set(node.id, s);
            }

            // damage flash: start at 1 on any health drop, decay to 0 over the
            // duration. red tint + glow on the body only.
            if (health.current < s.prevHealth) s.flash = 1;
            s.prevHealth = health.current;
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
// screen-space DOM into the viewport: a health bar (bottom-centre) from the
// local player's synced HealthTrait, and a top-right scoreboard of every
// combatant (players AND npcs) from the synced WizardTrait name/kills/deaths.
// both diff-gated — the DOM is only touched when its rendered values change.

script(WorldTrait, 'hud', (ctx) => {
    if (!env.client) return;
    const viewport = ctx.client?.viewport;
    if (!viewport) return;

    const wizards = query(ctx, [WizardTrait]);

    // health bar (bottom-centre)
    const bar = document.createElement('div');
    bar.style.cssText =
        'position:absolute; left:50%; bottom:24px; transform:translateX(-50%); width:220px; height:18px; border:2px solid #000; background:#fff; box-sizing:border-box; font-family:ui-monospace,monospace;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%; width:100%;';
    const label = document.createElement('div');
    label.style.cssText =
        'position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:12px; color:#000; pointer-events:none;';
    bar.append(fill, label);

    // leaderboard (top-right)
    const board = document.createElement('div');
    board.style.cssText =
        'position:absolute; top:12px; right:12px; min-width:150px; border:2px solid #000; background:#fff; box-sizing:border-box; font-family:ui-monospace,monospace; font-size:12px; color:#000; pointer-events:none;';
    const header = document.createElement('div');
    header.textContent = 'SCORES';
    header.style.cssText = 'padding:3px 8px; border-bottom:2px solid #000; font-weight:bold;';

    onInit(ctx, () => viewport.append(bar, board));
    onDispose(ctx, () => {
        bar.remove();
        board.remove();
    });

    let healthSig = ''; // each section only touches the DOM when its values change
    let boardSig = '';
    onFrame(ctx, () => {
        // health bar — local player's synced health.
        const controlNode = getControlNode(ctx);
        const health = controlNode && getTrait(controlNode, HealthTrait);
        const hSig = health ? `${health.current}/${health.max}` : '';
        if (hSig !== healthSig) {
            healthSig = hSig;
            if (!health) {
                bar.style.display = 'none';
            } else {
                bar.style.display = '';
                const pct = Math.max(0, Math.min(1, health.current / health.max));
                fill.style.width = `${pct * 100}%`;
                fill.style.background = pct > 0.5 ? '#22c55e' : pct > 0.25 ? '#eab308' : '#dc2626';
                label.textContent = `${Math.ceil(health.current)} / ${health.max}`;
            }
        }

        // leaderboard — every combatant, sorted by kills.
        const rows = wizards.matches.map(([w]) => w).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        const bSig = rows.map((w) => `${w.name}:${w.kills}/${w.deaths}`).join(',');
        if (bSig !== boardSig) {
            boardSig = bSig;
            board.replaceChildren(
                header,
                ...rows.map((w) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex; justify-content:space-between; gap:12px; padding:2px 8px;';
                    const name = document.createElement('span');
                    name.textContent = w.name || '…'; // textContent = safe from username markup
                    const score = document.createElement('span');
                    score.textContent = `${w.kills}/${w.deaths}`;
                    row.append(name, score);
                    return row;
                }),
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
