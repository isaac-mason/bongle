// editor/server.ts, the server half of the editor module: the room-level editor
// system (a WorldTrait script, so it instantiates on every room root without the
// runtime knowing it exists) that owns the authoritative scene + voxel mutation
// listeners, the /relight command, and the per-player EditorTrait seed. Imported
// only by engine-server-editor.

import type { Client } from 'bongle/interface';
import * as chat from '../api/chat';
import { WorldTrait } from '../builtins/world';
import type { ScenePayload } from '../core/content/scene-store';
import { registry } from '../core/registry';
import {
    addChild,
    addTrait,
    addTraitBySlot,
    bumpNodeVersion,
    createNode,
    deserializeNode,
    destroyNode,
    getNodeById,
    isAncestorOf,
    type Realm,
    removeTraitBySlot,
    reorderChild,
    reparent,
    type SerializedNode,
    setNodePersist,
    setPrefab,
    setRealm,
} from '../core/scene/scene-tree';
import { listen, onJoin, onLeave, onTick, script } from '../core/scene/scripts';
import { SetBlockFlags } from '../core/voxels/block-flags';
import { propagateAllLight } from '../core/voxels/light';
import { setBlock } from '../core/voxels/voxels';
import { env } from '../env';
import * as Discovery from '../server/discovery';
import * as Net from '../server/net';
import * as Rooms from '../server/rooms';
import { setTraitProps } from './actions';
import {
    AddTraitCommand,
    CreateNodeCommand,
    DeleteSceneCommand,
    DestroyNodeCommand,
    OpenSceneCommand,
    RemoveTraitCommand,
    RenameSceneCommand,
    ReorderCommand,
    ReparentCommand,
    SaveBlueprintCommand,
    SaveSceneCommand,
    SetNameCommand,
    SetNodePersistCommand,
    SetPrefabCommand,
    SetRealmCommand,
    SetTraitCommand,
    VoxelEditCommand,
} from './commands';
import { EditorTrait } from './editor-trait';
import * as Blueprints from './persist/blueprints';
import * as Persist from './persist/save';
import * as Scenes from './persist/scenes';

// the room-level editor system. hosted on WorldTrait like any other system, so it
// runs once per room root on both sides; the client-side instance early-returns.
// holds the authoritative voxel/scene mutation listeners and the /relight command,
// seeds the per-player EditorTrait on join, and owns persistence for edit rooms.
script(
    WorldTrait,
    'editor',
    (ctx) => {
        if (!env.server) return;
        const { state, room } = ctx.server!;

        // persistence, edit rooms only: play rooms never write scene files. opened
        // here, after the runtime loaded the scene; the autosave clock rides onTick;
        // an editor leaving persists what they did (covers stop_room and the last
        // editor leaving, both of which destroy the room next, and disconnects); the
        // shutdown flush is engine-server-editor's `dispose`.
        const persist = ctx.mode === 'edit' ? Persist.open(state, room, (message) => chat.message(ctx, message)) : null;
        if (persist) {
            onTick(ctx, ({ delta }) => Persist.tick(persist, delta));
            onLeave(ctx, () => Persist.flush(persist));
        }

        // per-player editor activation follows the player's mode, not the room's:
        // an edit-mode player gets EditorTrait on its player node (also when
        // inspecting a play room), and replication delivers it to the owning
        // client, whose script runs there. play-mode players use a client-local
        // lens instead (lens.ts), so nothing is seeded for them.
        onJoin(ctx, ({ playerNode, mode }) => {
            if (mode === 'edit') addTrait(playerNode, EditorTrait);
        });

        // //relight, full recompute of sky + rgb light for the room. only
        // the server has authoritative light state, so the listener lives
        // here. clients without the editor enabled never see the spec; play
        // clients with /relight typed fall through to plain-chat, which the
        // server ignores for slash inputs.
        const relightCmd = chat.command(ctx, {
            name: '/relight',
            description: 'recompute all light propagation in this room',
            args: [],
        });
        chat.listen(ctx, relightCmd, () => {
            if (!env.editor) return;
            const t0 = performance.now();
            propagateAllLight(ctx.voxels);
            const ms = (performance.now() - t0).toFixed(1);
            chat.message(ctx, `light repropagated in ${ms}ms`);
        });

        // capability gate, does this client have permission to mutate scene
        // state in this room? Today the only signal is `env.editor` (dev builds
        // grant edit to any connected client; prod builds grant to no one).
        // Future: real auth, project owner, role, etc. Decoupled from player
        // mode so a play-mode client with editor toggled on can still issue
        // edit RPCs.
        const canEdit = (_client: Client) => env.editor;
        const editGated =
            <T>(fn: (args: T, client: Client) => void) =>
            (args: T, client: Client) => {
                if (!canEdit(client)) return;
                fn(args, client);
            };

        // editGated; on a body that actually mutated (returns true, guard
        // early-returns don't), flag the room dirty for the autosave. wraps the
        // mutating listeners below.
        const editMutate = <T>(fn: (args: T, client: Client) => boolean | undefined) =>
            editGated<T>((args, client) => {
                if (!fn(args, client)) return;
                if (persist) Persist.markDirty(persist);
            });

        // explicit save (Ctrl+S, the tab menu): this room. the client names the
        // scene it meant; a mismatch is dropped rather than saving the wrong room.
        listen(
            ctx,
            SaveSceneCommand,
            editGated(({ sceneId }) => {
                if (persist && sceneId === room.sceneId) Persist.flush(persist);
            }),
        );

        // scene verbs. open: the edit room for a scene is found or created (edit
        // rooms share the 'editor' namespace) and the sender joins it as an editor;
        // the runtime's activate_room makes it their focused room. rename/delete
        // write through persist/scenes, which keeps live rooms consistent via the
        // runtime's room helpers (room.sceneId follows a rename; a delete stops the
        // rooms). a failed write is reported here, in the room's chat.
        listen(
            ctx,
            OpenSceneCommand,
            editGated(({ sceneId }, client) => {
                const target = Rooms.findOrCreateEditRoom(state, sceneId);
                const player = Rooms.addClientToRoom(state, client, target, 'edit');
                Net.send(state.net, client, { type: 'activate_room', playerId: player.id });
            }),
        );
        listen(
            ctx,
            RenameSceneCommand,
            editGated(({ oldSceneId, newSceneId }) => {
                Scenes.renameScene(state, oldSceneId, newSceneId).catch((err) =>
                    chat.message(ctx, `[scene] rename ${oldSceneId} did not reach disk: ${Scenes.errorMessage(err)}`),
                );
            }),
        );
        listen(
            ctx,
            DeleteSceneCommand,
            editGated(({ sceneId }) => {
                Scenes.deleteScene(state, sceneId).catch((err) =>
                    chat.message(ctx, `[scene] delete ${sceneId} did not reach disk: ${Scenes.errorMessage(err)}`),
                );
            }),
        );

        // voxel edit ops from clients
        listen(
            ctx,
            VoxelEditCommand,
            editMutate(({ ops }) => {
                // BULK: authoring edits settle their block-def hooks inline (each
                // write drains only its own op + chained recomputes) but fire no
                // script observers. no explicit end-of-brush drain needed.
                for (const op of ops) {
                    setBlock(ctx.voxels, op.wx, op.wy, op.wz, op.key, SetBlockFlags.BULK);
                }
                return true;
            }),
        );

        // save-as-blueprint, client extracts the ScenePayload from its
        // local selection and ships it here as JSON; server validates the
        // name (or allocates one), then writes a scene file under
        // `content/scenes/blueprints/<name>.scene.json`.
        listen(
            ctx,
            SaveBlueprintCommand,
            editGated((args) => {
                let payload: ScenePayload;
                try {
                    payload = JSON.parse(args.payload) as ScenePayload;
                } catch {
                    chat.message(ctx, '[blueprint] invalid payload (json parse failed)');
                    return;
                }
                const name = args.name && args.name.length > 0 ? args.name : Blueprints.allocateBlueprintName(state);
                const result = Blueprints.saveBlueprint(state, name, payload);
                if (!result.ok) {
                    chat.message(ctx, `[blueprint] ${result.error}`);
                    return;
                }
                result.written?.catch((err) =>
                    chat.message(ctx, `[blueprint] ${result.sceneId} did not reach disk: ${Scenes.errorMessage(err)}`),
                );
                // disk write → the `bongle:scenes` file watcher fires →
                // `bongle:scene-list` emission catches up the editor.
                chat.message(
                    ctx,
                    result.overwritten ? `[blueprint] overwrote ${result.sceneId}` : `[blueprint] saved ${result.sceneId}`,
                );
            }),
        );

        // scene mutation handlers
        listen(
            ctx,
            CreateNodeCommand,
            editMutate((args, _client) => {
                const sceneTree = room.scene;
                const parent = getNodeById(sceneTree, args.parentId);
                if (!parent) return;
                const node = createNode({
                    id: args.id,
                    name: args.name,
                    persist: args.persist,
                });
                if (args.prefab) {
                    try {
                        node.prefab = JSON.parse(args.prefab);
                    } catch {
                        /* fall through with no prefab */
                    }
                }
                addChild(parent, node);
                const traits: Array<{ id: string; controls?: Record<string, unknown> }> = JSON.parse(args.traits);
                for (const st of traits) {
                    const handle = registry.traits.handles.get(st.id);
                    if (!handle) {
                        if (node.unresolved === null) node.unresolved = new Map();
                        node.unresolved.set(st.id, st.controls);
                        continue;
                    }
                    addTraitBySlot(node, handle.slot, st.controls);
                }
                if (args.children) {
                    const children: SerializedNode[] = JSON.parse(args.children);
                    for (const cdata of children) {
                        addChild(node, deserializeNode(cdata));
                    }
                }
                reorderChild(parent, node, args.index);
                return true;
            }),
        );
        listen(
            ctx,
            DestroyNodeCommand,
            editMutate((args, client) => {
                const node = getNodeById(room.scene, args.id);
                if (!node) return;
                if (node === room.scene.root) return;
                Discovery.forgetNode(state.discovery, state.rooms, client, room.id, args.id);
                destroyNode(room.scene, node);
                return true;
            }),
        );
        listen(
            ctx,
            SetNameCommand,
            editMutate((args, client) => {
                const node = getNodeById(room.scene, args.id);
                if (!node) return;
                node.name = args.name ?? undefined;
                bumpNodeVersion(room.scene, node);
                Discovery.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, room.scene, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            SetRealmCommand,
            editMutate((args, client) => {
                const node = getNodeById(room.scene, args.id);
                if (!node) return;
                if (node === room.scene.root) return;
                // setRealm marks the affected subtree dirty so discovery re-evaluates
                // descendants' visibility (matters for play viewers in mixed rooms).
                setRealm(node, args.realm as Realm);
                Discovery.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, room.scene, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            ReparentCommand,
            editMutate((args, client) => {
                const sceneTree = room.scene;
                const node = getNodeById(sceneTree, args.id);
                if (!node) return;
                if (node === sceneTree.root) return;
                const newParent = getNodeById(sceneTree, args.parentId);
                if (!newParent) return;
                if (node === newParent || isAncestorOf(node, newParent)) return;
                reparent(node, newParent);
                reorderChild(newParent, node, args.index);
                bumpNodeVersion(sceneTree, node);
                Discovery.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            ReorderCommand,
            editMutate((args, client) => {
                const sceneTree = room.scene;
                const node = getNodeById(sceneTree, args.id);
                if (!node?.parent) return;
                reorderChild(node.parent, node, args.index);
                bumpNodeVersion(sceneTree, node);
                Discovery.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            SetTraitCommand,
            editMutate((args, client) => {
                const node = getNodeById(room.scene, args.id);
                if (!node) return;
                setTraitProps(room.scene, node, args.traitId, JSON.parse(args.props));
                Discovery.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, room.scene, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            AddTraitCommand,
            editMutate((args, client) => {
                const sceneTree = room.scene;
                const node = getNodeById(sceneTree, args.id);
                if (!node) return;
                const handle = registry.traits.handles.get(args.traitId);
                if (!handle) {
                    if (node.unresolved === null) node.unresolved = new Map();
                    node.unresolved.set(args.traitId, args.props ? JSON.parse(args.props) : undefined);
                    bumpNodeVersion(sceneTree, node);
                } else {
                    addTraitBySlot(node, handle.slot, args.props ? JSON.parse(args.props) : undefined);
                }
                Discovery.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            RemoveTraitCommand,
            editMutate((args, client) => {
                const sceneTree = room.scene;
                const node = getNodeById(sceneTree, args.id);
                if (!node) return;
                const handle = registry.traits.handles.get(args.traitId);
                if (!handle) {
                    node.unresolved?.delete(args.traitId);
                    bumpNodeVersion(sceneTree, node);
                } else {
                    removeTraitBySlot(node, handle.slot);
                }
                Discovery.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            SetPrefabCommand,
            editMutate((args, client) => {
                const sceneTree = room.scene;
                const node = getNodeById(sceneTree, args.id);
                if (!node) return;
                if (args.prefab) {
                    try {
                        setPrefab(node, JSON.parse(args.prefab));
                    } catch {
                        return;
                    }
                } else {
                    setPrefab(node, null);
                }
                bumpNodeVersion(sceneTree, node);
                Discovery.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            SetNodePersistCommand,
            editMutate((args, client) => {
                const sceneTree = room.scene;
                const node = getNodeById(sceneTree, args.id);
                if (!node) return;
                setNodePersist(node, args.persist);
                bumpNodeVersion(sceneTree, node);
                Discovery.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
    },
    { editor: true },
);
