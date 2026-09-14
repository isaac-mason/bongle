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
import { listen, onJoin, onLeave, onTick } from '../core/scene/scripts';
import { script } from '../core/registry';
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

// hosted on WorldTrait like any other system, so it runs once per room root on both sides;
// the client-side instance early-returns.
script(
    WorldTrait,
    'editor',
    (ctx) => {
        if (!env.server) return;
        const { state, room } = ctx.server!;

        // edit rooms only: play rooms never write scene files. the autosave clock rides onTick;
        // an editor leaving persists what they did; the shutdown flush is engine-server-editor's `dispose`.
        const persist = ctx.mode === 'edit' ? Persist.open(state, room, (message) => chat.message(ctx, message)) : null;
        if (persist) {
            onTick(ctx, ({ delta }) => Persist.tick(persist, delta));
            onLeave(ctx, () => Persist.flush(persist));
        }

        // follows the player's mode, not the room's: play-mode players use a client-local
        // lens instead (lens.ts), so nothing is seeded for them.
        onJoin(ctx, ({ playerNode, mode }) => {
            if (mode === 'edit') addTrait(playerNode, EditorTrait);
        });

        // only the server has authoritative light state, so the listener lives here.
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

        // today the only signal is `env.editor` (dev builds grant edit to any connected client;
        // prod builds grant to no one). decoupled from player mode so a play-mode client with
        // editor toggled on can still issue edit RPCs.
        const canEdit = (_client: Client) => env.editor;
        const editGated =
            <T>(fn: (args: T, client: Client) => void) =>
            (args: T, client: Client) => {
                if (!canEdit(client)) return;
                fn(args, client);
            };

        // flags the room dirty for autosave when the body actually mutated (returns true; guard early-returns don't).
        const editMutate = <T>(fn: (args: T, client: Client) => boolean | undefined) =>
            editGated<T>((args, client) => {
                if (!fn(args, client)) return;
                if (persist) Persist.markDirty(persist);
            });

        // the client names the scene it meant; a mismatch is dropped rather than saving the wrong room.
        listen(
            ctx,
            SaveSceneCommand,
            editGated(({ sceneId }) => {
                if (persist && sceneId === room.sceneId) Persist.flush(persist);
            }),
        );

        // rename/delete write through persist/scenes, which keeps live rooms consistent via the
        // runtime's room helpers (room.sceneId follows a rename; a delete stops the rooms).
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

        listen(
            ctx,
            VoxelEditCommand,
            editMutate(({ ops }) => {
                // BULK: settles block-def hooks inline per op but fires no script observers, no explicit end-of-brush drain needed.
                for (const op of ops) {
                    setBlock(ctx.voxels, op.wx, op.wy, op.wz, op.key, SetBlockFlags.BULK);
                }
                return true;
            }),
        );

        // client ships the ScenePayload extracted from its local selection as JSON; server
        // validates the name (or allocates one) and writes it under content/scenes/blueprints/<name>.scene.json.
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
                // disk write triggers the bongle:scenes file watcher, whose bongle:scene-list emission catches up the editor.
                chat.message(
                    ctx,
                    result.overwritten ? `[blueprint] overwrote ${result.sceneId}` : `[blueprint] saved ${result.sceneId}`,
                );
            }),
        );

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
                // marks the affected subtree dirty so discovery re-evaluates descendants' visibility (mixed rooms).
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
