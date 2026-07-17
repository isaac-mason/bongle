// Demo: persistent player progress backed by bongle's storage API.
//
//   userStorage  → each player's lifetime spark count (private)
//   projectStorage  → all-time project-wide spark count (shared)
//
// Walk over a spark to collect it. Both counters CAS-increment with a
// small retry budget; the spark hides for 5s then respawns. On join,
// the server logs your persisted score and the global total.

import {
    addChild,
    addTrait,
    broadcast,
    type ClientId,
    clientToUser,
    cloneModel,
    command,
    ContactsTrait,
    env,
    projectStorage,
    getTrait,
    listen,
    log,
    matchmaking,
    MotionType,
    onInit,
    onJoin,
    onTick,
    pack,
    PlayerTrait,
    query,
    RigidBodyTrait,
    script,
    type ScriptContext,
    send,
    SERVER_TO_CLIENT,
    setBlock,
    setPosition,
    trait,
    TransformTrait,
    userStorage,
    warn,
} from 'bongle';
import { blocks, models } from 'bongle/starter';

// ── matchmaking ─────────────────────────────────────────────────────

matchmaking({ maxPlayers: 4 });

const Grass = blocks.grass;
const SparkModel = models.spark;

const CollectableTrait = trait('collectable', {}, { persist: false });

// ── hud sync commands ───────────────────────────────────────────────
//
// score is private (sent only to the matching client); total is shared
// (broadcast to everyone whenever it changes).

const ScoreUpdate = command('persistent_data.score', SERVER_TO_CLIENT, pack.object({ score: pack.varuint() }));

const TotalUpdate = command('persistent_data.total', SERVER_TO_CLIENT, pack.object({ total: pack.varuint() }));

// ── gameplay ────────────────────────────────────────────────────────

const GameplayTrait = trait('gameplay');

const FLOOR_SIZE = 14;
const FLOOR_Y = 0;
const SPARK_Y = 2;
const HIDDEN_Y = -1000;
const RESPAWN_MS = 3000;
const CAS_RETRIES = 5;
const SPARK_HALF_EXTENT = 0.4;

const SPARK_POSITIONS: [number, number, number][] = [
    [3, SPARK_Y, 3],
    [7, SPARK_Y, 3],
    [11, SPARK_Y, 3],
    [3, SPARK_Y, 7],
    [11, SPARK_Y, 7],
    [3, SPARK_Y, 11],
    [7, SPARK_Y, 11],
    [11, SPARK_Y, 11],
];

script(
    GameplayTrait,
    'session',
    (ctx) => {
        // Floor + sparks are spawned on the server only. Voxel writes
        // and server-created nodes both sync to clients via the engine's
        // discovery channel.
        if (env.server) {
            onInit(
                ctx,
                () => {
                    const grassKey = Grass.defaultKey();
                    for (let x = 0; x < FLOOR_SIZE; x++) {
                        for (let z = 0; z < FLOOR_SIZE; z++) {
                            setBlock(ctx.voxels, x, FLOOR_Y, z, grassKey);
                        }
                    }
                    log(ctx, `built ${FLOOR_SIZE}x${FLOOR_SIZE} grass floor at y=${FLOOR_Y}`);

                    for (let i = 0; i < SPARK_POSITIONS.length; i++) {
                        const pos = SPARK_POSITIONS[i]!;
                        const mesh = cloneModel(SparkModel.scene);
                        mesh.name = `spark-${i}`;
                        mesh.persist = false;
                        const t = addTrait(mesh, TransformTrait);
                        setPosition(t, pos);
                        addTrait(mesh, CollectableTrait);
                        const rb = addTrait(mesh, RigidBodyTrait);
                        rb.def = {
                            shape: {
                                type: 'box',
                                halfExtents: [SPARK_HALF_EXTENT, SPARK_HALF_EXTENT, SPARK_HALF_EXTENT],
                            },
                            motionType: MotionType.STATIC,
                            sensor: true,
                        };
                        addTrait(mesh, ContactsTrait);
                        addChild(ctx.node, mesh);
                    }
                    log(ctx, `spawned ${SPARK_POSITIONS.length} sparks`);
                },
            );
        }

        if (ctx.mode === 'edit') return;

        if (env.client) {
            // Mount a tiny score HUD into the per-room viewport div.
            // The viewport is auto-removed when the room is disposed,
            // so we don't need explicit teardown.
            onInit(ctx, () => {
                const viewport = ctx.client?.viewport;
                if (!viewport) return;

                const hud = document.createElement('div');
                hud.style.cssText = [
                    'position: absolute',
                    'top: 12px',
                    'left: 12px',
                    'padding: 8px 12px',
                    'background: white',
                    'border: 1px solid black',
                    'font-family: ui-monospace, monospace',
                    'font-size: 13px',
                    'line-height: 1.4',
                    'pointer-events: none',
                    'white-space: pre',
                ].join('; ');
                hud.textContent = 'score: —\ntotal: —';
                viewport.appendChild(hud);

                let score = 0;
                let total = 0;
                const render = () => {
                    hud.textContent = `score: ${score}\ntotal: ${total}`;
                };

                listen(ctx, ScoreUpdate, (msg) => {
                    score = msg.score;
                    render();
                });
                listen(ctx, TotalUpdate, (msg) => {
                    total = msg.total;
                    render();
                });
            });
            return;
        }

        // Per-spark respawn timestamp. 0 = available, >0 = hidden until then.
        const respawnAt = new Map<TransformTrait, number>();
        // Original Y so we can put the spark back where it came from.
        const originalY = new Map<TransformTrait, number>();
        const sparks = query(ctx, [CollectableTrait, TransformTrait]);
        const players = query(ctx, [PlayerTrait, ContactsTrait]);

        onJoin(ctx, ({ client, playerNode }) => {
            const transform = getTrait(playerNode, TransformTrait)!;
            setPosition(transform, [FLOOR_SIZE / 2, FLOOR_Y + 4, FLOOR_SIZE / 2]);
            addTrait(playerNode, ContactsTrait);

            const user = clientToUser(ctx, client);
            log(ctx, `client ${client} joined as ${user.username} (userId=${user.id})`);
            void greetPlayer(ctx, client, user.id, user.username);
        });

        onTick(ctx, () => {
            const now = Date.now();

            // Respawn expired sparks and index live collectables by nodeId so
            // we can resolve contact targets in the next pass.
            const sparkByNodeId = new Map<number, TransformTrait>();
            for (const [collectable, sparkTransform] of sparks) {
                sparkByNodeId.set(collectable._node.id, sparkTransform);
                const until = respawnAt.get(sparkTransform) ?? 0;
                if (until === 0 || now < until) continue;
                respawnAt.set(sparkTransform, 0);
                const y = originalY.get(sparkTransform) ?? SPARK_Y;
                setPosition(sparkTransform, [sparkTransform.position[0], y, sparkTransform.position[2]]);
            }

            // Drive collection from sensor contact events.
            for (const [playerTrait, contacts] of players) {
                for (const c of contacts.added) {
                    if (c.type !== 'rigidBody') continue;
                    const sparkTransform = sparkByNodeId.get(c.nodeId);
                    if (!sparkTransform) continue;
                    if ((respawnAt.get(sparkTransform) ?? 0) > now) continue;

                    const sx = sparkTransform.position[0];
                    const sy = sparkTransform.position[1];
                    const sz = sparkTransform.position[2];
                    if (!originalY.has(sparkTransform)) originalY.set(sparkTransform, sy);
                    setPosition(sparkTransform, [sx, HIDDEN_Y, sz]);
                    respawnAt.set(sparkTransform, now + RESPAWN_MS);
                    void onCollect(ctx, playerTrait.client, playerTrait.userId, playerTrait.username);
                }
            }
        });
    },
);

// ── storage helpers ─────────────────────────────────────────────────

async function greetPlayer(ctx: ScriptContext, client: ClientId, userId: string, username: string): Promise<void> {
    log(ctx, `reading persisted state for ${username}…`);
    const [scoreEntry, totalEntry] = await Promise.all([
        userStorage.get(ctx, userId, 'score'),
        projectStorage.get(ctx, 'total_sparks'),
    ]);
    const score = numberOr(scoreEntry?.value, 0);
    const total = numberOr(totalEntry?.value, 0);
    log(
        ctx,
        `welcome ${username}! your score: ${score} (v=${scoreEntry?.version ?? 'new'}) | total sparks ever: ${total} (v=${totalEntry?.version ?? 'new'})`,
    );
    // hydrate the joiner's HUD with both numbers.
    send(ctx, ScoreUpdate, { score }, client);
    send(ctx, TotalUpdate, { total }, client);
}

async function onCollect(ctx: ScriptContext, client: ClientId, userId: string, username: string): Promise<void> {
    log(ctx, `${username} collected a spark — persisting…`);
    const [score, total] = await Promise.all([casIncrementUser(ctx, userId, 'score'), casIncrementGame(ctx, 'total_sparks')]);
    log(ctx, `+1 ${username} — score: ${score} | total sparks ever: ${total}`);
    // private update for the collector; global update for everyone.
    send(ctx, ScoreUpdate, { score }, client);
    broadcast(ctx, TotalUpdate, { total });
}

async function casIncrementUser(ctx: ScriptContext, userId: string, key: string): Promise<number> {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
        const entry = await userStorage.get(ctx, userId, key);
        const next = numberOr(entry?.value, 0) + 1;
        const result = await userStorage.set(ctx, userId, key, next, { ifVersion: entry?.version });
        if (result.ok) return next;
        if (result.code !== 'version_conflict') {
            throw new Error(`userStorage.set failed: ${result.code}`);
        }
        warn(ctx, `CAS conflict on userStorage[${userId}, ${key}] — retrying (attempt ${attempt + 1}/${CAS_RETRIES})`);
    }
    throw new Error('CAS retry budget exceeded for userStorage');
}

async function casIncrementGame(ctx: ScriptContext, key: string): Promise<number> {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
        const entry = await projectStorage.get(ctx, key);
        const next = numberOr(entry?.value, 0) + 1;
        const result = await projectStorage.set(ctx, key, next, { ifVersion: entry?.version });
        if (result.ok) return next;
        if (result.code !== 'version_conflict') {
            throw new Error(`projectStorage.set failed: ${result.code}`);
        }
        warn(ctx, `CAS conflict on projectStorage[${key}] — retrying (attempt ${attempt + 1}/${CAS_RETRIES})`);
    }
    throw new Error('CAS retry budget exceeded for projectStorage');
}

function numberOr(v: unknown, fallback: number): number {
    return typeof v === 'number' ? v : fallback;
}
