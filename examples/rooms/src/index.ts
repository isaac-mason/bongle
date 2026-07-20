import {
    CLIENT_TO_SERVER,
    command,
    env,
    getTrait,
    listen,
    matchmaking,
    onDispose,
    onInit,
    onJoin,
    pack,
    rooms,
    scene,
    script,
    type ScriptContext,
    send,
    setBlock,
    setPosition,
    TransformTrait,
    trait,
} from 'bongle';
import { blocks } from 'bongle/kit';

matchmaking({ maxPlayers: 8 });

// 'main' and 'other' load on both sides (server seeds and mirrors). 'local' is
// client-only: no server room is ever made, and each client spins up its own
// ClientRoom via rooms.create(ctx, 'local').
scene('main');
scene('other');
scene('local', { server: false });

const stoneKey = blocks.stone.defaultKey();
const dirtKey = blocks.dirt.defaultKey();
const grassKey = blocks.grass.defaultKey();

// Seed trait for editor-time terrain. Attach `seed` to a scene root in the
// editor and a small platform bakes into the scene's voxels. Save the scene
// and the result lands in <scene>.voxels.json. Pick whichever block matches
// the sceneId. Once you've painted the real environment, detach the trait.
function seedPlatform(ctx: ScriptContext, primaryKey: string): void {
    const SIZE = 10;
    const Y = 4;
    for (let x = 0; x < SIZE; x++) {
        for (let z = 0; z < SIZE; z++) {
            setBlock(ctx.voxels, x, Y, z, primaryKey);
        }
    }
}

function seedKeyForScene(sceneId: string): string {
    if (sceneId === 'main') return grassKey;
    if (sceneId === 'other') return dirtKey;
    return stoneKey; // 'local' / fallback
}

const SeedTrait = trait('seed', {}, { persist: true });

script(
    SeedTrait,
    'seed',
    (ctx) => {
        onInit(ctx, () => {
            const sceneId = ctx.server?.room.sceneId ?? ctx.client?.room?.sceneId;
            if (!sceneId) return;
            seedPlatform(ctx, seedKeyForScene(sceneId));
        });
    },
    { editor: true },
);

type GotoTarget = 'main' | 'other';

const gotoCmd = command(
    'goto',
    CLIENT_TO_SERVER,
    pack.object({ target: pack.string() }),
);

// Each room's client-side nav-trait instance mounts its own HUD into
// ctx.client.viewport, which the engine auto-hides and shows with the active
// room. No global singleton needed.
function mountHud(ctx: ScriptContext): () => void {
    const viewport = ctx.client?.viewport;
    if (!viewport) return () => {};

    const root = document.createElement('div');
    root.style.cssText =
        'position:absolute;top:12px;left:12px;display:flex;gap:8px;font-family:sans-serif;pointer-events:auto;';

    const make = (label: string, onClick: () => void) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText =
            'padding:8px 14px;background:#fff;border:2px solid #000;border-radius:0;cursor:pointer;font-size:14px;font-weight:600;';
        b.onclick = onClick;
        root.appendChild(b);
    };

    make('main', () => requestGoto(ctx, 'main'));
    make('other', () => requestGoto(ctx, 'other'));
    make('local', () => requestGotoLocal(ctx));

    viewport.appendChild(root);
    return () => root.remove();
}

/** Find a ctx scoped to a server-mirrored room so `gotoCmd` reaches
 *  the server's `listen`. From a server-mirrored room we can use the
 *  current ctx directly; from the local room we hop via rooms.view
 *  into whichever server room we're still observing. */
function serverScopedCtx(ctx: ScriptContext): ScriptContext | null {
    const obs = rooms.observed(ctx);
    const active = rooms.active(ctx);
    const inLocal = obs.find((r) => r.local)?.roomId === active?.roomId;
    if (!inLocal) return ctx;
    const server = obs.find((r) => !r.local);
    if (!server) return null;
    return rooms.view(ctx, server.roomId);
}

function requestGoto(ctx: ScriptContext, target: GotoTarget): void {
    const target_ctx = serverScopedCtx(ctx);
    if (!target_ctx) return;
    send(target_ctx, gotoCmd, { target });
}

function requestGotoLocal(ctx: ScriptContext): void {
    let localId = rooms.observed(ctx).find((r) => r.local)?.roomId;
    if (!localId) localId = rooms.create(ctx, 'local');
    rooms.activate(ctx, localId);
}

// Nav trait at runtime: HUD, RPC, spawn, and eager room creation.
const NavTrait = trait('nav', {}, { persist: true });

script(NavTrait, 'nav', (ctx) => {
    if (env.server) {
        onInit(ctx, () => {
            const sceneId = ctx.server!.room.sceneId;
            if (sceneId !== 'main') return;
            const alreadyExists = rooms.list(ctx).some((id) => {
                const v = rooms.view(ctx, id);
                return v?.server?.room.sceneId === 'other';
            });
            if (!alreadyExists) rooms.create(ctx, 'other');
        });

        onJoin(ctx, ({ playerNode }) => {
            const tx = getTrait(playerNode, TransformTrait)!;
            setPosition(tx, [6, 8, 6]);
        });

        listen(ctx, gotoCmd, (data, from) => {
            const targetSceneId = data.target;
            for (const id of rooms.list(ctx)) {
                const v = rooms.view(ctx, id);
                if (v?.server?.room.sceneId === targetSceneId) {
                    rooms.swap(ctx, from, id);
                    return;
                }
            }
        });
    }

    if (env.client) {
        let unmount: (() => void) | null = null;
        onInit(ctx, () => {
            unmount = mountHud(ctx);
        });
        onDispose(ctx, () => {
            unmount?.();
            unmount = null;
        });
    }
});
