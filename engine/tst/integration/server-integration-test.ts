// ── server integration test helper ──────────────────────────────────
//
// lightweight server-side integration test utility. creates a real Room
// via Rooms.createRoom() — real physics, real voxels, real block registry,
// and a complete ScriptRuntime. no stubs, no hand-rolling.
//
// traits/scripts must be declared at module scope (via trait() / script()
// calls) BEFORE calling this — they upsert into the engine-global
// `registry` singleton, which `Rooms.createRoom` reads from directly.

import * as Resources from '../../src/core/resources';
import * as Rpc from '../../src/core/rpc';
import type { SerializedSceneGraph } from '../../src/core/scene/nodes';
import * as Nodes from '../../src/core/scene/nodes';
import type { NodesRuntime } from '../../src/core/scene/scripts';
import * as Rooms from '../../src/server/rooms';

// ── types ───────────────────────────────────────────────────────────

export type TestServer = {
    /** the rooms registry */
    rooms: Rooms.Rooms;

    /** the default room — has .nodes, .scriptRuntime, .voxels, .physics */
    room: Rooms.Room;

    /** shorthand for room.scriptRuntime */
    runtime: NodesRuntime;

    /** shorthand for room.nodes */
    nodes: Nodes.Nodes;

    /** destroy the room and clean up */
    dispose(): void;
};

export type TestServerOptions = {
    /** scene to load into the room. if omitted, room starts with an empty scene graph. */
    scene?: SerializedSceneGraph;

    /** room mode. defaults to 'edit'. */
    mode?: 'edit' | 'play';
};

// ── factory ─────────────────────────────────────────────────────────

export function createTestServer(opts: TestServerOptions = {}): TestServer {
    const rooms = Rooms.init();
    const rpc = Rpc.init({
        send: () => {},
        broadcast: () => {},
    });
    const room = Rooms.createRoom(rooms, {
        sceneId: 'test',
        kind: opts.mode ?? 'edit',
        rpc,
        resources: Resources.init(async () => new Uint8Array(), 'server'),
    });

    if (opts.scene) {
        Nodes.loadSceneGraph(room.nodes, opts.scene);
    }

    return {
        rooms,
        room,
        runtime: room.scriptRuntime,
        nodes: room.nodes,
        dispose() {
            Rooms.destroyRoom(rooms, room.id);
        },
    };
}
