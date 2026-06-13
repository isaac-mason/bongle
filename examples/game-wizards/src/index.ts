import {
    addChild,
    addCharacter,
    addTrait,
    BLOCK_AIR,
    broadcast,
    CharacterControllerTrait,
    CLIENT_TO_SERVER,
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
    isMouseJustDown,
    listen,
    MeshTrait,
    matchmaking,
    model,
    type Node,
    onDispose,
    onFrame,
    onInit,
    onJoin,
    onTick,
    PlayerControllerTrait,
    PlayerTrait,
    pack,
    query,
    removeTrait,
    resolveCamera,
    script,
    send,
    SERVER_TO_CLIENT,
    setBlock,
    setEnvironment,
    setEnvironmentTime,
    setMeshDither,
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
import { RIG_6BONE_HAND_RIGHT, RIG_6BONE_HEAD } from 'bongle/avatar/rig';
import { blocks, particlePresets, sprites } from 'bongle/starter';
import { degreesToRadians, mat4, quat, type Quat, vec3, type Vec3, type Vec4 } from 'mathcat';

matchmaking({ maxPlayers: 32 });

use(blocks);

const wizardModels = model('wizard-assets', {
    src: 'assets/wizard-game-assets.gltf',
});

const WizardTrait = trait('wizard', {
    color: [1, 1, 1, 1] as Vec4,
});

sync(WizardTrait, 'color', {
    schema: pack.list(pack.float32(), 4),
    pack: (t) => t.color,
    unpack: (v, t) => (t.color = v),
    rate: 'dirty',
});

script(WizardTrait, 'gear', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        const staff = cloneModel(wizardModels.nodes.staff);
        staff.name = 'wizard:staff';
        const staffTransform = getTrait(staff, TransformTrait)!;
        setPosition(staffTransform, [0, 0, 0]);
        setQuaternion(staffTransform, quat.setAxisAngle(quat.create(), [1, 0, 0], degreesToRadians(-35)));
        addChild(findByName(ctx.node, RIG_6BONE_HAND_RIGHT)!, staff);

        const hat = cloneModel(wizardModels.nodes.hat);
        hat.name = 'wizard:hat';
        setPosition(getTrait(hat, TransformTrait)!, [0, 0.5, 0]);
        addChild(findByName(ctx.node, RIG_6BONE_HEAD)!, hat);
    });
});

script(WorldTrait, 'environment', (ctx) => {
    setEnvironment(ctx, ENVIRONMENT_OVERWORLD);
    setEnvironmentTime(ctx, 14);
});

script(WorldTrait, 'join', (ctx) => {
    if (!env.server) return;

    const palette: Vec4[] = [
        [0.9, 0.1, 0.1, 1], // red
        [0.2, 0.3, 0.95, 1], // blue
        [0.6, 0.15, 0.85, 1], // purple
    ];

    onJoin(ctx, ({ playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, [8.5, 2, 8.5]);

        addTrait(playerNode, WizardTrait, { color: palette[Math.floor(Math.random() * palette.length)] });

        // players are combat entities: full health + alive marker. damage,
        // death, respawn and regen are driven by the combat systems below.
        // (WizardTrait above also attaches the staff + hat — see its 'gear' script.)
        addTrait(playerNode, HealthTrait, { current: MAX_HEALTH, max: MAX_HEALTH });
        addTrait(playerNode, AliveTrait);
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
            setQuaternion(transform, quat.setAxisAngle(quat.create(), [1, 0, 0], degreesToRadians(-20)));
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

        // sway side-to-side once per stride (`sin`), dip down each footfall
        // (`abs(sin)`, +y is down); the airborne lift rides on top.
        setPosition(getTrait(viewmodel, TransformTrait)!, [
            offset[0] + Math.sin(bobPhase) * sway * bobBlend,
            offset[1] + Math.abs(Math.sin(bobPhase)) * bounce * bobBlend + air,
            offset[2],
        ]);
    });
});

script(WorldTrait, 'wizard-visuals', (ctx) => {
    if (!env.client) return;

    const wizards = query(ctx, [WizardTrait]);

    onFrame(ctx, () => {
        for (const [wizard] of wizards.matches) {
            const hat = findChildByName(wizard._node, 'wizard:hat');
            if (!hat) continue;
            traverse(hat, (node) => {
                const mesh = getTrait(node, MeshTrait);
                if (mesh && mesh.tint[3] === 0) setMeshTint(mesh, wizard.color); // apply once (alpha 0 = untinted)
            });
        }
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
const PROJECTILE_SPEED = 18; // m/s
const PROJECTILE_LIFETIME = 2.5; // s before it fizzles
const PROJECTILE_DAMAGE = 3;
const SPLASH_RADIUS = 2.0; // m — characters within this of the hit take damage
const TERRAIN_RADIUS = 1; // voxels carved around the hit
const HIT_RADIUS = 0.6; // m — projectile-vs-character contact sphere
const CHEST_OFFSET = 1.0; // m above a character's origin (feet) to aim at
const EYE_HEIGHT = 1.5; // m — spawn origin above the caster's origin
const CAST_COOLDOWN = 0.35; // s between casts
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

// monotonic server/client clock in seconds — matches spawnParticle's anchor.
const nowSec = (): number => performance.now() / 1000;

// random unit-ish direction for particle bursts.
function randomDir(): Vec3 {
    const x = Math.random() * 2 - 1;
    const y = Math.random() * 2 - 1;
    const z = Math.random() * 2 - 1;
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
}

// scratch quats for the per-tick projectile spin (aim × roll).
const _spin = quat.create();
const _orient = quat.create();

// scratch quats for the falling hat's per-tick tilt (baseRot × tilt).
const _hatTilt = quat.create();
const _hatOrient = quat.create();

// ── traits ──────────────────────────────────────────────────────────

// a live projectile. `spawnTime` is synced so the trait (and thus the
// node) replicates to clients, which read it to emit trail particles.
// velocity + aim are server-only — clients never integrate. `aim` is the
// cast-time camera quaternion; the node faces it and rolls around it.
const ProjectileTrait = trait('projectile', {
    ownerId: -1,
    spawnTime: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    aim: [0, 0, 0, 1] as Quat,
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

const CastCommand = command('wizards.cast', CLIENT_TO_SERVER, pack.object({ aim: pack.list(pack.float32(), 4) }));
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

// create a projectile node at `origin` travelling along `dir`, oriented to the
// cast `aim` quaternion. top-level (no owner) so it replicates to every client;
// the cloned `projectile` mesh rides the node's transform.
function spawnProjectile(sceneRoot: Node, ownerNode: Node, origin: Vec3, dir: Vec3, aim: Quat): void {
    const node = createNode({ name: 'projectile' });
    const transform = addTrait(node, TransformTrait);
    setPosition(transform, origin);
    setQuaternion(transform, aim); // face the aim; the tick adds spin on top
    addTrait(node, ProjectileTrait, {
        ownerId: ownerNode.id,
        spawnTime: nowSec(),
        vx: dir[0] * PROJECTILE_SPEED,
        vy: dir[1] * PROJECTILE_SPEED,
        vz: dir[2] * PROJECTILE_SPEED,
        aim: [aim[0], aim[1], aim[2], aim[3]],
    });

    const visual = cloneModel(wizardModels.nodes.projectile);
    visual.name = 'projectile:visual';
    // the cloned gltf node carries its own local offset — zero it so the mesh
    // is centred on the projectile node (which drives movement / collision / trail).
    setPosition(getTrait(visual, TransformTrait)!, [0, 0, 0]);
    addChild(node, visual);

    addChild(sceneRoot, node);
}

script(WorldTrait, 'combat-cast', (ctx) => {
    if (env.client) {
        let lastCast = -999;

        onFrame(ctx, () => {
            const mk = ctx.client?.input?.mouseKeyboard;
            if (!mk || !isMouseJustDown(mk, 'left')) return;

            // first click grabs the pointer; subsequent clicks cast.
            if (!document.pointerLockElement) {
                ctx.client?.domElement?.requestPointerLock?.();
                return;
            }

            const now = nowSec();
            if (now - lastCast < CAST_COOLDOWN) return;
            lastCast = now;

            // send the camera quaternion as the aim — the server derives the
            // travel direction from it and orients the projectile to it.
            const q = getWorldQuaternion(getTrait(resolveCamera(ctx).node, TransformTrait)!);
            send(ctx, CastCommand, { aim: [q[0], q[1], q[2], q[3]] });

            // muzzle flash at the world tip of the held staff, spraying along
            // the view direction (camera forward = -Z) with a little scatter.
            const controlNode = getControlNode(ctx);
            const staffNode = controlNode && findChildByName(controlNode, 'wizard:staff');
            if (staffNode) {
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
        return;
    }

    if (!env.server) return;

    const players = query(ctx, [PlayerTrait, TransformTrait]);
    const lastCastByClient = new Map<number, number>();

    listen(ctx, CastCommand, (data, from) => {
        const now = nowSec();
        if (now - (lastCastByClient.get(from) ?? -999) < CAST_COOLDOWN) return;

        for (const [player, transform] of players) {
            if (player.client !== from) continue;
            if (!getTrait(player._node, AliveTrait)) return; // no casting while dead
            lastCastByClient.set(from, now);

            const aim = data.aim as Quat;
            const dir = vec3.normalize(vec3.create(), vec3.transformQuat(vec3.create(), [0, 0, -1], aim));
            const p = getWorldPosition(transform);
            const origin: Vec3 = [p[0] + dir[0] * 1.2, p[1] + EYE_HEIGHT + dir[1] * 1.2, p[2] + dir[2] * 1.2];
            spawnProjectile(ctx.node, player._node, origin, dir, aim);
            return;
        }
    });
});

script(WorldTrait, 'combat-projectiles', (ctx) => {
    if (!env.server) return;

    const projectiles = query(ctx, [ProjectileTrait, TransformTrait]);
    const targets = query(ctx, [HealthTrait, AliveTrait, TransformTrait]);

    // carve a voxel sphere + damage characters within splash range, then
    // tell clients where it landed.
    const handleHit = (pos: Vec3, ownerId: number) => {
        const cx = Math.floor(pos[0]);
        const cy = Math.floor(pos[1]);
        const cz = Math.floor(pos[2]);
        for (let dx = -TERRAIN_RADIUS; dx <= TERRAIN_RADIUS; dx++) {
            for (let dy = -TERRAIN_RADIUS; dy <= TERRAIN_RADIUS; dy++) {
                for (let dz = -TERRAIN_RADIUS; dz <= TERRAIN_RADIUS; dz++) {
                    if (dx * dx + dy * dy + dz * dz > TERRAIN_RADIUS * TERRAIN_RADIUS) continue;
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
            if (ex * ex + ey * ey + ez * ez > SPLASH_RADIUS * SPLASH_RADIUS) continue;

            health.current = Math.max(0, health.current - PROJECTILE_DAMAGE);
            health.lastDamageTime = nowSec();
            health.lastAttacker = ownerId;
            broadcast(ctx, DamageCommand, { pos: [tx, ty, tz], amount: PROJECTILE_DAMAGE });
        }

        broadcast(ctx, ImpactCommand, { pos: [pos[0], pos[1], pos[2]], fizzle: false });
    };

    onTick(ctx, ({ delta }) => {
        const now = nowSec();
        // resolve outside the loop — destroying nodes mid-iteration of a
        // live query is unsafe.
        const spent: Array<{ node: Node; pos: Vec3; ownerId: number; fizzle: boolean }> = [];

        for (const [projectile, transform] of projectiles) {
            const pos = transform.position;
            if (now - projectile.spawnTime > PROJECTILE_LIFETIME) {
                spent.push({ node: projectile._node, pos: [pos[0], pos[1], pos[2]], ownerId: projectile.ownerId, fizzle: true });
                continue;
            }

            const nx = pos[0] + projectile.vx * delta;
            const ny = pos[1] + projectile.vy * delta;
            const nz = pos[2] + projectile.vz * delta;

            // terrain: solid cell at the new position stops the bolt.
            if (getBlock(ctx.voxels, Math.floor(nx), Math.floor(ny), Math.floor(nz)) !== BLOCK_AIR) {
                spent.push({ node: projectile._node, pos: [nx, ny, nz], ownerId: projectile.ownerId, fizzle: false });
                continue;
            }

            // entity: first character (other than the owner) within the
            // contact sphere takes the hit.
            let struck = false;
            for (const [, , target] of targets) {
                if (target._node.id === projectile.ownerId) continue;
                const wp = getWorldPosition(target);
                const ex = nx - wp[0];
                const ey = ny - (wp[1] + CHEST_OFFSET);
                const ez = nz - wp[2];
                if (ex * ex + ey * ey + ez * ez <= HIT_RADIUS * HIT_RADIUS) {
                    struck = true;
                    break;
                }
            }
            if (struck) {
                spent.push({ node: projectile._node, pos: [nx, ny, nz], ownerId: projectile.ownerId, fizzle: false });
                continue;
            }

            // server drives position only; clients own the quaternion (aim +
            // local spin) so the rotation stays smooth — see combat-vfx.
            setPosition(transform, [nx, ny, nz]);
        }

        for (const s of spent) {
            if (s.fizzle) broadcast(ctx, ImpactCommand, { pos: s.pos, fizzle: true });
            else handleHit(s.pos, s.ownerId);
            destroyNode(s.node);
        }
    });
});

// ── server: health, death, respawn ──────────────────────────────────

script(WorldTrait, 'combat-health', (ctx) => {
    if (!env.server) return;

    const alive = query(ctx, [HealthTrait, AliveTrait, TransformTrait]);
    const respawns: Array<{ node: Node; at: number; pos: Vec3 }> = [];

    onTick(ctx, ({ delta }) => {
        const now = nowSec();
        const deaths: Array<{ node: Node; pos: Vec3 }> = [];

        for (const [health, , transform] of alive) {
            if (health.current <= 0) {
                const wp = getWorldPosition(transform);
                deaths.push({ node: transform._node, pos: [wp[0], wp[1], wp[2]] });
                continue;
            }
            if (health.current < health.max && now - health.lastDamageTime >= REGEN_DELAY) {
                health.current = Math.min(health.max, health.current + REGEN_RATE * delta);
            }
        }

        for (const d of deaths) {
            removeTrait(d.node, AliveTrait);
            broadcast(ctx, DeathCommand, { pos: d.pos });
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

// ── client: falling hats ────────────────────────────────────────────
// purely client-side. each client watches synced health and, the moment an
// entity dies, spawns its OWN local hat (never replicated) at that entity's
// *visual* hat pose — so it lands exactly where the client sees the hat, not
// where the server's rig thinks it is. then sims the damped pendulum sway +
// descent locally at 60fps (smooth, no network) and despawns it.

script(WorldTrait, 'falling-hats', (ctx) => {
    if (!env.client) return;

    type Hat = { node: Node; spawnTime: number; startX: number; startY: number; startZ: number; floorY: number; baseRot: Quat };
    const entities = query(ctx, [HealthTrait, TransformTrait]);
    const wasDead = new Map<number, boolean>();
    const hats: Hat[] = [];

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

    onFrame(ctx, () => {
        const now = nowSec();

        // drop a hat on the death transition (per entity).
        for (const [health, transform] of entities) {
            const id = transform._node.id;
            const dead = health.current <= 0;
            if (dead && !wasDead.get(id)) dropHat(transform._node, now);
            wasDead.set(id, dead);
        }

        // sim + despawn local hats.
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
            quat.setAxisAngle(_hatTilt, [0, 0, 1], tilt);
            setQuaternion(transform, quat.multiply(_hatOrient, hat.baseRot, _hatTilt));
        }
    });
});

// ── server: NPC dummy wizards ───────────────────────────────────────

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

    onInit(ctx, () => {
        HOMES.forEach((home, i) => {
            const node = createNode({ name: `npc-wizard-${i}` });
            setPosition(addTrait(node, TransformTrait), home);
            addCharacter(node); // mounts the 6-bone rig synchronously
            // physics-grounded like a player: the server (owner of this
            // ownerless node) runs the controller sim — gravity, ground,
            // slopes. AI steers it later by writing `input.move` / `look`;
            // idle (move = [0,0]) just stands.
            addTrait(node, CharacterControllerTrait);
            addChild(ctx.node, node);

            // WizardTrait attaches the staff + hat (its 'gear' script) and
            // drives the client-side hat tint by color.
            addTrait(node, WizardTrait, { color: NPC_COLORS[i % NPC_COLORS.length] });

            // combat state: killable dummy that respawns at home. AI (cast
            // back / wander) is a later hook.
            addTrait(node, HealthTrait, { current: MAX_HEALTH, max: MAX_HEALTH });
            addTrait(node, AliveTrait);
            addTrait(node, NpcTrait, { homeX: home[0], homeY: home[1], homeZ: home[2] });
        });
    });
});

// ── server: NPC steering (consumes voxelNav pathfinding) ────────────
// pathfinding (voxelNav) produces a list of cells; this is the *steering* half,
// kept separate: each NPC repaths to the nearest player on a timer and walks
// the waypoints by writing its character-controller input (look + move + jump).

script(WorldTrait, 'combat-npc-ai', (ctx) => {
    if (!env.server) return;

    const CHASE_RANGE = 30; // m — only pursue a player within this
    const REPATH_INTERVAL = 0.5; // s between repaths
    const WAYPOINT_REACHED = 0.7; // m (horizontal) to advance to the next waypoint
    const CAST_RANGE = 16; // m — within this (with a clear shot) the NPC stops and fires
    const NPC_CAST_COOLDOWN = 1.3; // s between NPC casts

    const npcs = query(ctx, [NpcTrait, CharacterControllerTrait, TransformTrait]);
    const players = query(ctx, [PlayerTrait, AliveTrait, TransformTrait]);

    type Brain = { path: Vec3[]; waypoint: number; repathIn: number; castIn: number };
    const brains = new Map<number, Brain>();

    const worldToCell = (p: Vec3): Vec3 => [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])];

    // stop walking; optionally turn to face a world point.
    const idle = (controller: CharacterControllerTrait, faceX?: number, faceZ?: number, atX?: number, atZ?: number) => {
        controller.input.move[0] = 0;
        controller.input.move[1] = 0;
        controller.input.jump = false;
        if (faceX !== undefined) controller.input.look[1] = Math.atan2(-(faceX - atX!), -(faceZ! - atZ!));
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

    onTick(ctx, ({ delta }) => {
        for (const [npc, controller, transform] of npcs) {
            // dead NPCs (no AliveTrait) just stand until they respawn.
            if (!getTrait(npc._node, AliveTrait)) {
                idle(controller);
                continue;
            }

            let brain = brains.get(npc._node.id);
            if (!brain) {
                brain = { path: [], waypoint: 0, repathIn: 0, castIn: Math.random() * NPC_CAST_COOLDOWN };
                brains.set(npc._node.id, brain);
            }

            const pos = getWorldPosition(transform);

            // nearest alive player within chase range.
            let target: Vec3 | null = null;
            let bestDistSq = CHASE_RANGE * CHASE_RANGE;
            for (const [, , playerTransform] of players) {
                const pp = getWorldPosition(playerTransform);
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

            // engaged: within cast range with a clear shot → stand, face the
            // player, and fire on a cooldown instead of closing to melee.
            const eye: Vec3 = [pos[0], pos[1] + EYE_HEIGHT, pos[2]];
            const aimPoint: Vec3 = [target[0], target[1] + CHEST_OFFSET, target[2]];
            const toAimX = aimPoint[0] - eye[0];
            const toAimY = aimPoint[1] - eye[1];
            const toAimZ = aimPoint[2] - eye[2];
            const inCastRange = toAimX * toAimX + toAimY * toAimY + toAimZ * toAimZ < CAST_RANGE * CAST_RANGE;
            brain.castIn -= delta;
            if (inCastRange && clearShot(eye, aimPoint)) {
                idle(controller, target[0], target[2], pos[0], pos[2]); // stop + face the player
                if (brain.castIn <= 0) {
                    brain.castIn = NPC_CAST_COOLDOWN;
                    const dir = vec3.normalize(vec3.create(), [toAimX, toAimY, toAimZ]);
                    const aim = quat.rotationTo(quat.create(), [0, 0, -1], dir);
                    const origin: Vec3 = [eye[0] + dir[0] * 1.2, eye[1] + dir[1] * 1.2, eye[2] + dir[2] * 1.2];
                    spawnProjectile(ctx.node, npc._node, origin, dir, aim);
                }
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
        quat.setAxisAngle(_spin, PROJECTILE_SPIN_AXIS, spinAngle);
        for (const [projectile, transform] of projectiles) {
            // aim (synced once) × local roll. faces travel, rolls around it.
            setQuaternion(transform, quat.multiply(_orient, projectile.aim, _spin));
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

// ── client: health bar HUD ──────────────────────────────────────────
// reads the local player's synced HealthTrait and renders a minimalist
// screen-space bar (white, square, black border) into the viewport DOM.

script(WorldTrait, 'health-hud', (ctx) => {
    if (!env.client) return;
    const viewport = ctx.client?.viewport;
    if (!viewport) return;

    const bar = document.createElement('div');
    bar.style.cssText =
        'position:absolute; left:50%; bottom:24px; transform:translateX(-50%); width:220px; height:18px; border:2px solid #000; background:#fff; box-sizing:border-box; font-family:ui-monospace,monospace;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%; width:100%;';
    const label = document.createElement('div');
    label.style.cssText =
        'position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:12px; color:#000; pointer-events:none;';
    bar.append(fill, label);

    onInit(ctx, () => viewport.appendChild(bar));
    onDispose(ctx, () => bar.remove());

    onFrame(ctx, () => {
        const controlNode = getControlNode(ctx);
        const health = controlNode && getTrait(controlNode, HealthTrait);
        if (!health) {
            bar.style.display = 'none';
            return;
        }
        bar.style.display = '';
        const pct = Math.max(0, Math.min(1, health.current / health.max));
        fill.style.width = `${pct * 100}%`;
        fill.style.background = pct > 0.5 ? '#22c55e' : pct > 0.25 ? '#eab308' : '#dc2626';
        label.textContent = `${Math.ceil(health.current)} / ${health.max}`;
    });
});

// ── client: death fade ──────────────────────────────────────────────
// dither the whole character out on death and back in on respawn, driven by
// synced health (current <= 0 = dead). a simple first pass — the hat staying
// behind / tumbling off is a later embellishment.

script(WorldTrait, 'death-fade', (ctx) => {
    if (!env.client) return;

    const FADE_SPEED = 6; // lerp rate toward the target dither (~0.5s in/out)
    const entities = query(ctx, [HealthTrait]);
    const dither = new Map<number, number>(); // per-node current dither (0 solid → 1 gone)

    onFrame(ctx, ({ delta }) => {
        for (const [health] of entities) {
            const node = health._node;
            const target = health.current <= 0 ? 1 : 0;
            const cur = dither.get(node.id) ?? 0;
            if (cur === target) continue;
            let next = cur + (target - cur) * Math.min(delta * FADE_SPEED, 1);
            if (Math.abs(next - target) < 0.01) next = target;
            dither.set(node.id, next);
            traverse(node, (n) => {
                const mesh = getTrait(n, MeshTrait);
                if (mesh) setMeshDither(mesh, next);
            });
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

    onFrame(ctx, ({ delta }) => {
        const node = getControlNode(ctx);
        if (!node || getTrait(node, PlayerControllerTrait)) return; // alive → PC drives

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
