// ── server integration test helper ──────────────────────────────────
//
// lightweight server-side integration test utility. creates a real Room
// via Rooms.createRoom() — real physics, real voxels, real block registry,
// and a complete ScriptRuntime. no stubs, no hand-rolling.
//
// traits/scripts must be declared at module scope (via trait() / script()
// calls) BEFORE calling this — they upsert into the engine-global
// `registry` singleton, which `Rooms.createRoom` reads from directly.

import { registry, reindex } from '../../src/core/registry';
import * as Resources from '../../src/core/resources';
import * as Rpc from '../../src/core/rpc';
import type { SerializedSceneTree } from '../../src/core/scene/scene-tree';
import * as SceneTree from '../../src/core/scene/scene-tree';
import type { SceneTreeContext } from '../../src/core/scene/scripts';
import * as Rooms from '../../src/server/rooms';

// ── types ───────────────────────────────────────────────────────────

export type TestServer = {
    /** the rooms registry */
    rooms: Rooms.Rooms;

    /** the default room — has .nodes, .scriptRuntime, .voxels, .physics */
    room: Rooms.Room;

    /** shorthand for room.scriptRuntime */
    runtime: SceneTreeContext;

    /** destroy the room and clean up */
    dispose(): void;
};

export type TestServerOptions = {
    /** scene to load into the room. if omitted, room starts with an empty scene tree. */
    scene?: SerializedSceneTree;

    /** room mode. defaults to 'edit'. */
    mode?: 'edit' | 'play';
};

// ── factory ─────────────────────────────────────────────────────────

export function createTestServer(opts: TestServerOptions = {}): TestServer {
    // module-scope trait/command/block declarations have registered by now;
    // rebuild the derived index fields as a real server boot would, so
    // Rooms.createRoom + wire encoding read live `blockRegistry` / `protocol`.
    reindex(registry);

    const rooms = Rooms.init();
    const rpc = Rpc.init({
        send: () => {},
        broadcast: () => {},
    });
    const room = Rooms.createRoom(rooms, {
        sceneId: 'test',
        kind: opts.mode ?? 'edit',
        rpc,
        resources: Resources.init({ loadBytes: async () => new Uint8Array() }, 'server'),
    });

    if (opts.scene) {
        SceneTree.loadSceneTree(room.nodes, opts.scene);
    }

    return {
        rooms,
        room,
        runtime: room.scriptRuntime,
        dispose() {
            Rooms.destroyRoom(rooms, room.id);
        },
    };
}
