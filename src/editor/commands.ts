import { CLIENT_TO_SERVER, command } from '../core/rpc';
import { pack } from '../core/scene/pack';

/* ── scene mutation commands ── */

export const DestroyNodeCommand = command('editor.destroy_node', CLIENT_TO_SERVER, pack.object({ id: pack.int32() }));

export const SetNameCommand = command(
    'editor.set_name',
    CLIENT_TO_SERVER,
    pack.object({ id: pack.int32(), name: pack.nullish(pack.string()) }),
);

export const SetRealmCommand = command(
    'editor.set_realm',
    CLIENT_TO_SERVER,
    pack.object({ id: pack.int32(), realm: pack.string() }),
);

export const ReparentCommand = command(
    'editor.reparent',
    CLIENT_TO_SERVER,
    pack.object({ id: pack.int32(), parentId: pack.int32(), index: pack.int32() }),
);

export const ReorderCommand = command('editor.reorder', CLIENT_TO_SERVER, pack.object({ id: pack.int32(), index: pack.int32() }));

export const SetTraitCommand = command(
    'editor.set_trait',
    CLIENT_TO_SERVER,
    pack.object({ id: pack.int32(), traitId: pack.string(), props: pack.string() }),
);

export const AddTraitCommand = command(
    'editor.add_trait',
    CLIENT_TO_SERVER,
    pack.object({ id: pack.int32(), traitId: pack.string(), props: pack.optional(pack.string()) }),
);

export const RemoveTraitCommand = command(
    'editor.remove_trait',
    CLIENT_TO_SERVER,
    pack.object({ id: pack.int32(), traitId: pack.string() }),
);

export const CreateNodeCommand = command(
    'editor.create_node',
    CLIENT_TO_SERVER,
    pack.object({
        id: pack.int32(),
        parentId: pack.int32(),
        index: pack.int32(),
        name: pack.optional(pack.string()),
        persist: pack.optional(pack.boolean()),
        traits: pack.string(),
        // optional JSON of SerializedNode[] for descendants. when present, the
        // server deserializes each child and attaches it under the new node.
        children: pack.optional(pack.string()),
        // optional JSON of PrefabConfig. inlined here (rather than sent as a
        // separate SetPrefabCommand) so the originating client's discovery
        // knowledge isn't stamped before discovery has emitted node_created
        // for this node, that stamping path silently swallows the create.
        prefab: pack.optional(pack.string()),
    }),
);

/* ── prefab commands ── */

export const SetPrefabCommand = command(
    'editor.set_prefab',
    CLIENT_TO_SERVER,
    pack.object({ id: pack.int32(), prefab: pack.optional(pack.string()) }),
);

export const SetNodePersistCommand = command(
    'editor.set_node_persist',
    CLIENT_TO_SERVER,
    pack.object({ id: pack.int32(), persist: pack.boolean() }),
);

/* ── blueprint commands ── */

// save the current selection as a blueprint scene under
// `content/scenes/blueprints/<name>.scene.json`. when `name` is empty/absent
// the server allocates a fresh `blueprint-NNN`. `payload` is a JSON-stringified
// ScenePayload built client-side via Blueprint.selectionToScenePayload.
export const SaveBlueprintCommand = command(
    'editor.save_blueprint',
    CLIENT_TO_SERVER,
    pack.object({
        name: pack.optional(pack.string()),
        payload: pack.string(),
    }),
);

/* ── voxel edit command ── */

export const VoxelEditCommand = command(
    'editor.voxel_edit',
    CLIENT_TO_SERVER,
    pack.object({
        ops: pack.list(
            pack.object({
                wx: pack.int32(),
                wy: pack.int32(),
                wz: pack.int32(),
                key: pack.string(),
            }),
        ),
    }),
);
