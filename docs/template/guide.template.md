# bongle

Read this top to bottom to learn the engine and its API, with examples and
guidance. Reach for the [API reference](./api.md) when you want the exhaustive
signature list.

## Getting Started

> NOTE: bongle is in early development and is not yet published to npm. Install
> directly from the repo:

```sh
npx github:isaac-mason/bongle new my-game
cd my-game
npm run edit
```

Running the above will scaffold a minimal project and start the editor on
`http://localhost:3002`.

From there, you can edit the game code in `src/`, and see your changes live in
the editor.

If you'd rather poke around without scaffolding, clone the repo and run any of
the projects in [`../examples/`](../examples). Clone recursively so the
submodules come along:

```sh
git clone --recurse-submodules https://github.com/isaac-mason/bongle.git
cd bongle
```

Already cloned without `--recurse-submodules`? Run
`git submodule update --init --recursive`.

### Start from the new-bongle template

[new-bongle](https://github.com/isaac-mason/new-bongle) is a ready-made starter
project. Open it in the cloud with one click:

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/isaac-mason/new-bongle)

It boots a container, installs dependencies, and starts the editor (forwarded on
`:3002`). You can also clone it and run `npm install && npm run edit` locally.

## CLI Reference

```sh
# scaffold a new project in `./[dir]/`
bongle new [dir]

# the below commands run in an existing project:

# start the editor for the current project
bongle edit

# build the project into a `dist/bundle.zip`
bongle build

# serve a built dist/ locally
bongle start

# bump the `bongle` dep, install, run migrate
bongle upgrade

# migrates editor-managed content in ./content/* to the latest version
bongle migrate [--check]
```

## Your first game

`bongle new my-game` scaffolds a project whose `src/index.ts` is already a
complete, playable game. It is short enough to read in full, so we will walk it
top to bottom. Everything below is imported from `bongle`, except the starter
blocks, which come from `bongle/starter`.

First, register content and size the room:

<Snippet source="first-game.snippet.ts" select="setup" />

`use(blocks)` pulls in the starter block set so those block types are registered
and appear in the editor palette (it keeps the declarations alive through
bundling). `matchmaking({ maxPlayers: 32 })` sets how many players matchmaking
puts in one room.

Next, a script that sets up the sky and sun:

<Snippet source="first-game.snippet.ts" select="environment" />

A script attaches behaviour to a trait. `script(WorldTrait, 'environment',
factory, opts)` runs its factory for every node carrying a `WorldTrait`, which
here is the single world node. Inside, `onInit` registers a one-time setup
callback that calls `setEnvironment` and `setEnvironmentTime` to choose a preset
sky and a 9am sun. The `{ editor: true }` option runs the script in the editor
as well as at play time, so the world is lit while you build it.

Finally, place players as they join:

<Snippet source="first-game.snippet.ts" select="spawn" />

This is server logic, so it returns early unless `env.server` is true (the
[multiplayer model](#the-multiplayer-model) covers why). `onJoin` fires once per
client that joins the room and hands you that client's `playerNode`. We read its
`TransformTrait` with `getTrait` and call `setPosition` to drop the player at
`[0, 5, 0]`, then face them toward a point of interest. The player node also carries
a `CharacterControllerTrait`, and `setCharacterLookAt(cc, transform, target)` aims it at
a world position, computing the look yaw and pitch through the character's eyes. The
player controller reads those angles, so the client's camera starts pointed that way.
(For a raw yaw and pitch, `setCharacterLook(cc, yaw, pitch?)` writes them directly.)

That is the whole starter: register blocks, size the room, light the world,
spawn players. The rest of this guide unpacks the pieces it leans on, starting
with the [concepts](#concepts) behind the world model and then the
[programming model](#the-programming-model) for nodes, traits, and scripts in
depth.

## Concepts

A world is a voxel grid plus a scene of objects living in it.

### Voxels

The world is a 3D grid of blocks, like Minecraft. The terrain, buildings, and
anything you can stand on or break is voxels, and the grid can change while the
game runs.

**Block types**: every cell holds a block type. Stone, a door, or one you define
yourself, each with its own look and collision.

**Chunks**: the grid is divided into fixed-size chunks, so changing one part of
the world only has to update that chunk, not the whole thing.

### Scene

Everything that isn't a block lives in the scene: a tree of nodes.

**Nodes**: a single object in the tree. A node on its own does almost nothing;
what it is comes from its traits.

**Traits**: the building blocks of a node. A trait bundles state and behaviour:
a transform gives a node a position, a rigid body gives it physics, a sprite
makes it draw. A node is just the traits it carries.

**Scripts**: your game logic. A script attaches to a trait and runs on lifecycle
hooks.

### The multiplayer model

bongle is multiplayer by default. A running game is a server that simulates a
**room** (one instance of the world) plus one client per connected player. Your `src/index.ts` runs on both
sides, and `env.server` / `env.client` are build-time booleans, so a guard like
`if (!env.server) return` compiles the code it protects out of the client bundle
entirely. (`env.editor` does the same for editor-only code.)

The server is authoritative: it owns the simulation, and a script can run on the
server, the client, or both. Players join a room and each gets a `playerNode`;
the server-only `onJoin` and `onLeave` hooks fire as they come and go.

Most state reaches clients without any networking code. A trait declares which
of its fields replicate and how often (`sync` and `syncRate`, covered in [the
programming model](#the-programming-model)): set a value on the server and
clients receive it. Use `'realtime'` for fields that change every tick, like
position or health, and `'dirty'` for fields you set once and rarely touch. When
you need to send a discrete message instead of replicating state, reach for RPC,
covered in [Multiplayer, in depth](#multiplayer-in-depth).

## The programming model

A bongle game is built from three things: nodes, traits, and scripts. Nodes form
the scene tree, traits give a node state and capabilities, and scripts attach
behaviour to a trait. This chapter covers all three, then how code splits across
the client and server.

### Nodes and the scene graph

A node is one object in the scene tree. On its own it carries almost nothing;
what it can do comes from the traits you add. `createNode` returns a **detached**
node, `addTrait` gives it a capability, `addChild` attaches it under a parent so
it goes live, and `destroyNode` removes a node and its subtree.

<Snippet source="scene-graph.snippet.ts" select="hierarchy" />

`addTrait(node, Trait)` returns the new trait instance. `getTrait(node, Trait)`
reads it back later (or `null` if absent), and `hasTrait` tests presence.
`findByName` runs a depth-first search from a node for the first descendant with
a given name.

Every node has a **realm** that decides which sides it lives on. By default a
node inherits its parent's realm, which resolves to `'shared'` under the scene
root: it exists on the server and every client and replicates between them. Pass
`realm: 'server'` to `createNode` for server-only nodes that never replicate, or
`realm: 'client'` for purely local client nodes.

### Traits

If you have used an entity-component system, a trait is bongle's version of a
component: the node is the entity, and you compose its capabilities by adding
traits rather than subclassing.

A trait is named state, plus the behaviour and replication you attach to it. The
engine ships builtin traits (`TransformTrait`, `CameraTrait`, `RigidBodyTrait`,
and more), and you define your own with `trait(id, body)`. The body is a plain
object of fields; each value is either a literal default or a factory
`() => value` called once per instance.

<Snippet source="define-trait.snippet.ts" select="define" />

Two registrars extend a trait. `control` exposes a field to the editor inspector
and saves it in scene files. Its `schema`, built with the `prop` helpers such as
`prop.number()` or `prop.vec3()`, describes the field's type:

<Render select="api/traits:control" heading />

`sync` replicates a field across the network. Its rate and authority (which side
may write it) get a fuller treatment under
[replication and authority](#replication-and-authority).

<Render select="api/traits:sync" heading />

### Scripts and lifecycle

`script(Trait, id, factory, opts?)` attaches behaviour. The factory runs once per
node that carries the trait, with a `ctx` whose `ctx.trait` is the bound instance
(fully typed) and `ctx.node` its node. Inside the factory you register lifecycle
hooks. This script registers every one, with the args each hands you and a note on
when it fires and on which side:

<Snippet source="script-lifecycle.snippet.ts" select="lifecycle" />

The `opts` argument takes `{ editor: true }` to also run the script in the
editor, as the starter's environment script does.

### Ticks, frames, and interpolation

The simulation advances on a fixed 60 Hz timestep, while rendering runs as fast as
the display allows. Each rendered frame the engine runs zero or more fixed ticks
(`onTick`) to catch up to real time, then renders. Because a frame usually falls
between two ticks, it interpolates: each moving object is drawn a fraction of the
way from its previous tick position to its current one, so motion stays smooth at
any framerate.

This gives a node's transform two values. The **logic** transform steps once per
tick; the **visual** transform is the interpolated value used for rendering.
`getWorldPosition` and its siblings read the logic transform, and
`getVisualWorldPosition` reads the interpolated one. So gameplay in `onTick` works
in logic space, while camera-follow code lives in `onFrame` and reads
`getVisualWorldPosition`, so the camera tracks the smoothed body rather than the
stepping one.

Interpolation is opt-in per node with `setInterpolation(node, true)`. The engine
enrolls the nodes that need it automatically, namely replicated transforms and
character controllers, so you only call it for nodes you move yourself on the tick
and want rendered smoothly. A node you move every frame in `onFrame`, or one that
never moves, does not need it.

In short: read input and set intent in `onInput`, put gameplay in `onTick`, and
camera and visual-following work in `onFrame`.

### Time

Lifecycle hooks hand you a `delta`, but for cooldowns, durations, and scheduled
events read the room clock. `ctx.clock.time` is the local tick-aligned time in
seconds, and `ctx.clock.server` is the shared server time, equal on every client,
for anything that must agree across the network.

### Logging

Use `log`, `warn`, and `error` instead of bare `console.log`. Each tags the
message with the script's trait and node and surfaces it in the editor as well as
the console, so you can tell which script and entity it came from.

### Queries

To act on every node carrying a given set of traits, use a query instead of
walking the tree. `query(ctx, [TraitA, TraitB])` returns a **live** query that
stays in sync as nodes gain and lose those traits; iterate it each tick, where
every match is a tuple of the requested trait instances (reach the node itself
with `trait._node`).

<Snippet source="queries.snippet.ts" select="query" />

`filter(ctx, conditions)` is the one-shot version that returns a plain array, and
`first(ctx, Trait)` returns the nearest ancestor carrying a trait.

### Systems and actors

These primitives support two ways to organize logic, and you can mix them.

The **systems** style is ECS-like: put a script on `WorldTrait` (or on your own
trait on the root node), define data-only traits on your entities, and have the
script `query` for those traits and iterate them each tick. Logic is centralized
in a few systems and entities are just data. This suits anything that runs over
many entities at once, such as scoring, spawning, or AI.

The **actor** style puts a script directly on an entity's own trait, so each node
carries its own behaviour. The factory runs once per entity, with `ctx.node` and
`ctx.trait` scoped to that one. This suits self-contained objects: a door, a
pickup, a projectile.

Most games mix the two. A root-level system owns the rules that span entities,
while individual entities keep their own local behaviour.

### Hot reload

In the editor, saving a script re-runs its factory live, so edits take effect
without a restart. The old instance is disposed first, so its `onDispose` runs,
then the new factory runs. Factory-scope locals reset by design; to carry state
across a reload, register `onSwap` with a serialize and deserialize pair.

### Client and server

The same source is bundled for both sides, and `env.server` / `env.client` (plus
`env.editor`) carve out side-specific logic, with the unused branch stripped at
build time. Put authoritative simulation on the server and read its results on
the client through replication: a `sync` on a trait is the usual path, where the
server writes the field and every client receives it at the configured rate. For
discrete events rather than continuous state, use RPC, covered in
[Multiplayer, in depth](#multiplayer-in-depth).

## Transforms

Every node with a `TransformTrait` has a position, rotation, and scale. You
write **local-space** values with setters and read **world-space** values with
getters. Setters propagate a dirty flag down the subtree; getters lazily
recompute only when something upstream changed, so reading is cheap when
nothing moved.

The most common call is `setPosition`, which writes the node's local position:

<Render select="api/transforms:setPosition" />

To read where a node actually ended up in the world (after its parents'
transforms are applied), use `getWorldPosition`:

<Render select="api/transforms:getWorldPosition" />

In practice you add a `TransformTrait` to a node, set its local position, then
read back where it lands in world space:

<Snippet source="transforms.snippet.ts" select="place-node" />

See the [API reference](./api.md#transforms--scene-graph) for the full set of
transform setters and getters.

## Scenes & prefabs

You rarely build a whole level node by node in code. Instead you author content
in the editor and reference it from scripts. The editor saves each authored scene
as a `.scene.json` file and regenerates `src/generated/scenes.ts` so the engine
and editor know about it.

### Scenes

A scene is a saved chunk of content: a subtree of nodes and, optionally, voxels.
Scenes exist as content whether or not your code mentions them. `scene(id)` is how
you make one **referenceable from code**: it returns a stable `SceneHandle` you
read through, with `handle.node` for the node subtree, `handle.voxels` for its
blocks, and `handle.version` to detect reloads. The engine fills the handle in
when the scene loads, and options control which side loads it, for example
`scene('navmesh', { client: false })` for a server-only scene.

Only declare a handle for scenes your code actually uses: to clone from one, read
its blocks, or list it as a prefab dependency. A large level that simply loads as
the world needs no handle.

### Prefabs

A prefab is a template you instantiate many times. `prefab(id, options)` declares
one. Its `type` is `'nodes'`, `'voxels'`, or `'composite'`, and its `fn` builds an
instance by attaching children under `ctx.root` and writing blocks into
`ctx.voxels`. List the scenes or other handles it reads in `deps`, so the editor
re-instantiates it when they change.

<Snippet source="prefabs.snippet.ts" select="define-prefab" />

To place an instance, call `createPrefab` from a script. Like `createNode`, it
returns a **detached** node; `addChild` attaches it, and the engine builds the
prefab's contents on the next tick.

<Snippet source="prefabs.snippet.ts" select="spawn-prefab" />

Prefabs can take arguments. Pass `args: { schema, default }` in the options and a
second parameter arrives in `fn`, so one prefab can produce variants such as a
color, a difficulty, or a team.

## The editor

`bongle edit` starts the editor, the visual workspace for building your game. It
runs your project live on `http://localhost:3002`, so code changes and content
changes show up immediately.

The editor is where you author the content your code references. You place and
paint blocks straight into the world, add nodes and attach traits to them, and
edit trait fields in an inspector. The fields the inspector shows are the ones a
trait exposes with `control`, which is why control-backed values are the ones that
persist.

What you author is saved under the project's `content/` directory as scene files,
and the editor regenerates the typed handles in `src/generated/`, so your code can
reference scenes, models, and sounds by name. Scripts marked `{ editor: true }`
run inside the editor too, so world setup such as lighting is visible while you
build.

When the content format changes between engine versions, `bongle migrate`
upgrades your `content/` to the latest schema.

## Assets

Models, textures, sounds, and sprites come from asset files in your project. You
declare each as a handle at module scope and point it at its source: `model(id,
{ src })` for a glTF, `sound(id, { src })` for audio, and `blockTexture` and
`sprite` for images. That handle is what the rest of your code and the editor
reference.

Give `src` a `new URL('./file', import.meta.url)`. The asset then co-locates with
the module that declares it and survives bundling, which is what lets a shared pack
ship its assets alongside its code. A plain string path relative to the project root
also works, but prefer the URL form.

<Snippet source="assets.snippet.ts" select="declare" />

The asset pipeline processes these sources when you build or edit, generating the
typed handles in `src/generated/` (`models.ts`, `sounds.ts`, `scenes.ts`) so named
content is available without hand-wiring it. Because a bundler can drop a
declaration that nothing references in code, pass any handle that is only named in
data, such as a scene's block palette or a prefab id, to `use` so it stays alive.

A texture or sprite source need not be a file. Pass a `draw()` descriptor as the
`src` and it paints the image at bake time with a 2D canvas context, which is
handy for procedural or composed textures.

<Snippet source="assets.snippet.ts" select="procedural" />

## Voxels & blocks

The world's terrain is a voxel grid. Every cell holds a block type, the grid is
split into fixed-size chunks, and you can change it freely while the game runs.

### Defining a block type

`block(id, options)` declares a block at module scope. The most common model is a
textured cube: map a texture to `all` faces, or to `top`, `bottom`, and `sides`
separately. The starter pack ships ready-made textures under `bongle/starter`.

<Snippet source="blocks.snippet.ts" select="define-block" />

Options beyond `model` cover collision, lighting, sounds, and shape, among them
`cull`, `lightOpacity`, `surfaceHeight`, and `sounds`. As with any content handle,
reference the block in code (or pass it to `use`) so the bundler keeps its
declaration.

You rarely write the harder shapes by hand. The `blockPreset` namespace builds the
common ones for you, wiring up the model, collision, and any block states the shape
needs: `blockPreset.stairs`, `slab`, `wall`, `fence`, `pane`, `carpet`, `trapdoor`,
`door`, `plate`, `ladder`, `torch`, `plant`, `leaves`, `liquid`, `column`, and
`cube`. These cover most of what a world needs without authoring a model. The
starter blocks are the worked examples here: `bongle/starter` is built almost
entirely from these presets, so its source
([src/starter/blocks.ts](../src/starter/blocks.ts)) is the best place to see them in
use. When you need a shape no preset covers, the preset source itself
([src/core/voxels/block-presets.ts](../src/core/voxels/block-presets.ts)) shows how
each one assembles its model and states, which is the template for a custom one.

### Block states

A block can carry named properties, so one block type covers several states: a
lamp that is lit or not, a log with an axis, crops at a growth stage. Define them
with the `states` option, building the schema from `blockState.bool`,
`blockState.enumeration`, and `blockState.int`. Address a specific state by its
property values with the handle's `stateKey` (or `stateId`), the key you then pass
to `setBlock`.

<Snippet source="blocks.snippet.ts" select="block-states" />

### Reading and writing the world

Blocks live in the per-room `Voxels`, reachable in any script as `ctx.voxels`.
`setBlock` writes a block by world coordinate and `getBlock` reads one back. Edits
made on the server replicate to clients automatically.

<Snippet source="blocks.snippet.ts" select="edit-world" />

To find which block a ray hits, for a build cursor or a hitscan weapon, use
`raycastVoxels`. The starter blocks also include presets such as doors; toggle one
with `getDoorOpen` and `setDoorOpen`.

### Reacting to changes

To run logic when the world changes, register a block event for a block type.
`onBlockBuild` and `onBlockBreak` fire when a block of that type is placed or
broken, and `onBlockStateChange` fires when it changes state in place. All three
are server-only and hand you the world coordinates of the change.

<Snippet source="blocks.snippet.ts" select="block-events" />

## Rendering & visuals

Everything the player sees comes from a handful of built-in pieces, each covered
below:

- [Camera](#camera): the room's view and projection, and the controllers that move it.
- [Lighting and sky](#lighting-and-sky): sky presets, time of day, and voxel lighting.
- [Visual traits](#visual-traits): the traits that draw a node, meshes, sprites, and shadows.
- [Particles](#particles): short-lived sprite effects such as smoke, sparks, and dust.
- [Going lower level](#going-lower-level): drop to the gpucat scene for custom rendering.

Rigged glTF models are their own topic, covered in
[Models & characters](#models--characters).

### Camera

Every room has a camera node, reachable in a client script as `ctx.client.camera`.
Its `CameraTrait` holds the projection (`fov`, `near`, `far`). The builtin
controllers (orbit, fly, player) write its pose each frame, but you can read the
trait to adjust field of view or seed a pose before adding a controller.

<Snippet source="visuals.snippet.ts" select="camera" />

### Lighting and sky

`setEnvironment` and `setEnvironmentTime` choose a sky preset and time of day
(`ENVIRONMENT_OVERWORLD` is the default daylight preset). Voxel lighting is
flood-filled through the grid; turn it on and set a floor level with the
server-only `configureFloodFillLighting`.

<Snippet source="visuals.snippet.ts" select="lighting" />

### Visual traits

Most visible objects are a node carrying a visual trait:

- `MeshTrait` draws raw geometry, and `VoxelMeshTrait` draws block meshes.
- `SpriteTrait` draws 2D art as a billboard, and `ExtrudedSpriteMeshTrait` turns
  that art into a 3D slab. Both suit items, foliage, and effects.
- `ShadowCasterTrait` makes a node cast a shadow.

### Particles

Particles are short-lived sprites for effects like smoke, sparks, and dust.
Declare a particle type with `particle(id, { sprite, playback, update })`, pairing
a sprite with a motion `update` (the `particleUpdate.*` helpers cover the common
ones), then emit instances at a position with `spawnParticle`. The starter pack
bundles ready-made presets under `particlePresets` in `bongle/starter`.

<Snippet source="visuals.snippet.ts" select="particles" />

### Going lower level

bongle renders with [gpucat](https://github.com/isaac-mason/gpucat), a lightweight
in-house renderer. When the builtin traits do not cover an effect you need,
advanced games can reach the gpucat scene directly as `ctx.client.scene` to add
custom meshes or materials.

## Physics

bongle has two physics systems, both running per room, colliding with the voxel
world, simulating on the server, and replicating to clients (optionally with
client-side prediction). **Rigid-body physics** is the full solver: bodies with
mass, friction, and restitution that collide and respond realistically. **AABB
physics** is a lighter axis-aligned system for large numbers of simple movers that
do not need that fidelity. Reach for rigid bodies for props and ragdolls, AABB
bodies for projectiles, pickups, and crowds.

### Rigid bodies

A rigid body is a node with a `RigidBodyTrait`. Assign its `def` to build one: a
`shape` (`box`, `sphere`, `capsule`, `hull`, or `mesh`) plus optional `friction`,
`restitution`, and a `motionType` from the `MotionType` enum (`MotionType.STATIC`,
`KINEMATIC`, or `DYNAMIC`, the default). Set `sensor: true` for a body that reports
overlaps without blocking, the basis for triggers and pickups.

<Snippet source="physics.snippet.ts" select="drop-body" />

Rigid-body physics is powered by [crashcat](https://github.com/isaac-mason/crashcat),
bongle's physics engine. `RigidBodyTrait` covers the common cases declaratively. For
advanced use the underlying crashcat world is reachable at `ctx.physics.rigid.world`,
and you can drive it directly with the crashcat API (raw bodies, joints, queries,
custom shapes) alongside the trait-managed bodies in the same simulation.

### AABB bodies

The `aabbBody` namespace builds the lighter axis-aligned bodies. They skip full
rigid-body solving, so they scale to many simple movers; drive one directly with
`aabbBody.setVelocity`.

### Character controller

`CharacterControllerTrait` is a kinematic mover for players and NPCs: it walks,
steps, and slides against the world without the wobble of a dynamic body. It pairs
with `CharacterTrait` for the visible body, covered in
[Models & characters](#models--characters).

You drive it through its `input`: `input.move` is a planar `[strafe, forward]`
vector, `input.look` is the `[_, yaw, pitch]` look spherical, and `input.jump`,
`input.sprint`, and `input.crouch` are held flags. The controller turns those into
motion each tick. For a player, a [`PlayerControllerTrait`](#players--input) fills
`input` from device input for you. For an NPC you write `input` yourself: set
`input.move` to steer, and aim with `setCharacterLook(cc, yaw, pitch?)` or
`setCharacterLookAt(cc, transform, target)` (which points the character at a world
position through its eyes) rather than writing the look angles by hand. The
[Pathfinding](#pathfinding) snippet drives an NPC exactly this way.

### Contacts

To run game logic when bodies touch, add a `ContactsTrait` to a node. After each
physics step it holds that node's contacts for the step, split into `added` (first
seen this step), `persisted` (ongoing), and `removed` (gone this step). Each entry
carries the contact `point` and `normal`, and a contact against another body also
carries the other `nodeId`, which you match against your own nodes to tell what you
touched. Read these in `onPostPhysicsStep`, which runs once the contacts are
populated.

A coin pickup is the canonical example: give each coin a sensor body and a
`ContactsTrait`, then award and despawn it the moment a player's body shows up in
its `added` list.

<Snippet source="physics.snippet.ts" select="coin-pickup" />

For lower-level control, `onPhysicsContact(ctx, 'added' | 'persisted', fn)` fires
during the step with the raw crashcat bodies and manifold, and lets you tune the
contact in place, such as zeroing friction for an ice patch or flagging it a sensor.

### The player controller

`PlayerControllerTrait` drives a player node from input, handling first and
third-person movement and the camera so you do not write that math by hand. Add it
to the player node and it consumes input each frame. Input itself is covered in
[Players & input](#players--input).

## Scene queries

To ask "what is here" or "what does this ray hit", query the world. Blocks and
bodies live in two separate systems, so you query them separately: the voxel grid
holds the terrain, and the physics world holds rigid bodies, AABB bodies, and the
character controllers.

### Raycasting the voxels

`raycastVoxels` walks the block grid from an origin along a direction and reports
the first solid block hit, for a build cursor, a hitscan weapon against terrain, or
a line-of-sight check. It takes `ctx.voxels`, the block registry `ctx.blocks`, the
ray as plain numbers, a max distance, and a block-flag mask (`BLOCK_FLAG_COLLISION`
restricts hits to blocks that collide). Allocate the result once with
`createVoxelRaycastResult` and reuse it.

<Snippet source="scene-queries.snippet.ts" select="raycast-voxels" />

### Raycasting the physics world

For bodies rather than blocks, cast against the crashcat world at
`ctx.physics.rigid.world`. bongle deliberately does not wrap this: you call the
crashcat ray API directly (`castRay` with `createClosestCastRayCollector` and
`createDefaultCastRaySettings`) and read the hit off the collector. This is the same
direct-crashcat escape hatch described under [Rigid bodies](#rigid-bodies), and it is
the encouraged way to do physics queries.

<Snippet source="scene-queries.snippet.ts" select="raycast-physics" />

### Object layers and filters

A physics query is scoped by a **filter** built over the world's object layers. Each
body sits on a layer: `OBJECT_LAYER_VOXELS` is the terrain body, while
`OBJECT_LAYER_NODE_MOVING` and `OBJECT_LAYER_NODE_NOT_MOVING` are dynamic and static
node bodies. Start a filter from crashcat's `filter.forWorld(world)` (every layer
on), then `disableObjectLayer` the ones to skip, as the snippet above does to ignore
terrain and hit only entities. A filter also carries a `bodyFilter` callback for
excluding one specific body, such as the shooter's own.

### Collision groups

Layers decide which broad category a query or the simulation considers; **collision
groups** give finer, per-body control through a group and mask bitfield, set on a
`RigidBodyTrait` def as `collisionGroups` and `collisionMask`. The engine reserves
the low bits for its own bodies, `COLLISION_GROUP_VOXELS` (`1 << 0`) and
`COLLISION_GROUP_NODES` (`1 << 1`); your game uses `1 << 2` and up for its own
groups. Reach for them when a layer is too coarse for the rule you want: projectiles
that pass through their own team, entities that ignore each other but not the world,
triggers only certain bodies activate.

## Pathfinding

For NPCs that navigate the voxel world, the `nav` namespace provides grid
pathfinding over the blocks. `nav.findPath` runs A-star from a start cell to a goal
and returns the list of cells, and `nav.smoothPath` straightens that into fewer
waypoints. `findPath` returns the path only; moving along it is your job. The
snippet below runs a full NPC loop: repath on a timer, drop waypoints as it reaches
them, and steer its `CharacterControllerTrait` toward the next one by setting the
controller's look yaw and forward input each tick.

<Snippet source="pathfinding.snippet.ts" select="path" />

What moves an agent can make is the **actions** function you pass to `findPath`,
its successor. `nav.groundActions` is the default: walk on flat ground and step up
or down one block. To allow other moves, pass a different one. `nav.groundDropActions`
adds walking off a ledge and dropping down to a landing, capped by `maxDrop`. To add
gap-jumps, spread `nav.groundMoves` with your own longer offsets and build a
successor with `nav.gridActions(moves, nav.groundWalkable())`. For anything beyond a
fixed offset set, such as ladders, doors, or context-dependent cost, write your own
`Actions`: a function that, given a cell, calls `step(x, y, z, cost)` for each
neighbour the agent can reach from it.

## Players & input

### Players

Each connected client has a **player node** that the engine creates and tags with
a `PlayerTrait` (carrying its `playerId`, `username`, and owning `client`). The
local player is `ctx.client.player`; a joining player arrives as the `playerNode`
in `onJoin`, as the starter's spawn script uses. You usually drive the player with
a `PlayerControllerTrait` rather than writing movement from scratch.

### Reading input

Input is client only and polled once per frame. Read it in `onInput`, the hook that
fires first each frame, ahead of every `onUpdate` and `onTick`: set your movement
and action intent there and everything later in the frame, including the player
controller and the tick simulation, sees it. (`onUpdate` also runs before the ticks,
but reaching for it to read input is rarely what you want.) Reach input through
`ctx.client.input`, which holds `.mouseKeyboard` for keyboard and mouse and `.touch`
for touch. The predicates all take the input instance as their first argument and
report this frame's state:

<Snippet source="input.snippet.ts" select="read-input" />

These take the `mouseKeyboard` input. `code` is a `KeyboardEvent.code` such as
`'KeyW'` or `'Space'`, and `button` is `'left'`, `'middle'`, or `'right'`.

| Predicate | Reads |
| --- | --- |
| `isKeyDown(mk, code)` | key is held this frame |
| `isKeyJustDown(mk, code)` | key went down this frame (press edge) |
| `isKeyJustUp(mk, code)` | key went up this frame (release edge) |
| `isMouseDown(mk, button)` | mouse button is held |
| `isMouseJustDown(mk, button)` | button went down this frame |
| `isMouseJustUp(mk, button)` | button went up this frame |
| `isMouseTap(mk, button)` | a quick press-and-release landed this frame |
| `isMouseDragStart(mk, button)` | a drag began this frame |

Touch input (joysticks, buttons, pinch) is read with its own predicates, covered
under [Touch controls](#touch-controls).

### Touch controls

A `PlayerControllerTrait` handles the basics for you: on a touch device it
auto-mounts a movement joystick and a jump button and reads them, so walking and
jumping work on mobile with no extra code. It reads them at the well-known ids in
`PlayerControllerTouchIds` (`move`, `jump`, `sprint`, `crouch`), so to reposition or
restyle one you mount your own joystick or button at that id and the controller
still picks it up.

For game-specific actions, mount your own controls with `createJoystick` and
`createTouchButton`, then read them with `getJoystick(touch, id)` and
`isTouchButtonDown(touch, id)`, where `touch` is `ctx.client.input.touch`. Both
factories mount under the room's touch overlay, no-op on the server, and return a
disposer to call from `onDispose`. A button with `look: true` doubles as an aim
surface: dragging it rotates the camera while it is held.

Gate your controls on `isTouchPrimary`, a coarse-pointer check, rather than screen
size, so tablets and touch laptops get them too. Keep `isMobile`, which is true only
on a small touch screen, for laying out a compact HUD, not for deciding whether to
show touch controls at all.

<Snippet source="input.snippet.ts" select="touch" />

## Models & characters

bongle has two kinds of model. A plain **model** is any glTF you place in the
world, such as a prop, a pickup, or a piece of scenery. A **character** is a
rigged humanoid that animates and that players and NPCs render as. They share the
loading machinery below but differ in how you drive them.

### Models

`model(id, { src })` declares a model from a glTF at module scope and returns a
handle. Instance it with `cloneModel(handle.scene)`, which copies the model's
subtree and installs the render slot a visible node needs, then attach the clone
to the scene.

<Snippet source="character.snippet.ts" select="place-model" />

A model is a tree of named nodes, and you often want to drive one part of it from
code: open a chest lid, mount an item on a hand, attach an effect to a turret. The
handle indexes everything the glTF contains by name, as `handle.nodes`,
`handle.meshes`, and `handle.animations`. On a placed clone, reach the live instance
of a named node with `findByName(clone, name)`, then read or write its traits.

<Snippet source="character.snippet.ts" select="reference-node" />

### Character models

A character is a node with a `CharacterTrait`, which carries its model, sounds, and
effects and pairs with the `CharacterControllerTrait` from [Physics](#physics).
Player nodes get one automatically from their avatar (see [Avatars](#avatars)); for
NPCs you assign one yourself.

Character models follow a canonical humanoid rig (the `6bone` rig, whose structure
is laid out under [Avatars](#avatars)). You author them in
[bongle-blockbench](https://github.com/isaac-mason/bongle-blockbench), a build of
[Blockbench](https://www.blockbench.net/) set up for bongle. It starts you from
that rig, validates it as you work, and exports an engine-ready glTF in one click.
Run it online at [blockbench.bongle.io](https://blockbench.bongle.io), or install
it into the Blockbench desktop app.

### Animation

Any model that ships clips can be animated, not just characters. bongle plays the
glTF's **TRS** animation tracks, keyframed node translation, rotation, and scale, so
a clip moves whole nodes of the model: a crab's legs, a turning gear, a swinging
door. There is no skinning, so it does not deform a mesh by bone weights. That makes
clips ideal for props, machines, creatures, and one-shot character emotes.

Animation is driven by an `AnimatorTrait` on the model node. It samples the model's
clips each tick and blends between them. The `Animation` namespace is the
script-facing API: `Animation.clip(animator, clipDef)` resolves one of the model's
clips to an `AnimationAction`, and `Animation.play`, `Animation.stop`,
`Animation.crossFadeTo`, and `Animation.setEffectiveWeight` drive playback and
blending. A model's clips are reachable by name off its handle, as
`CrabModel.animations.idle`.

<Snippet source="character.snippet.ts" select="animate" />

On a **character**, prefer procedural animation (below) for ongoing motion. Clip
playback writes the same bone TRS as the built-in procedural locomotion and
head-look, so the two fight; reserve clips on characters for one-shot emotes layered
on top, and let procedural code drive the moment-to-moment pose.

### Character procedural animation

Some pose work can't come from a baked clip: a head that tracks the camera, a
spring that reacts to the parent's motion, a constraint that clamps a joint. Use
`onPostAnimate`, which fires after the animator has sampled this tick's clips but
before world matrices are recomputed. At that point a bone's local TRS is fresh, so
writes here layer on top of the sampled pose rather than being overwritten by it.
Built-in character locomotion (arm and leg swing, head-look) runs in exactly this
phase.

<Snippet source="character.snippet.ts" select="procedural" />

### Loading models at runtime (advanced)

Almost always you declare a model with `model()` up front, and that is what you
should reach for. For the rare case where a model's source is only known at runtime,
the script context exposes `loadModel`, `getModel`, `ensureModel`, and
`releaseModel` to fetch and reference-count one on the fly. Prefer a declared model
when you can: it is typed, processed by the asset pipeline, and simpler to reason
about.

## Avatars

An avatar is the model a humanoid renders with. Player nodes receive one
automatically on join, resolved by the platform, so you rarely touch avatars for
players directly. The script-facing API is mainly for **NPCs**: ambient
characters you spawn yourself.

Every avatar follows the `6bone` rig: a `waist` hub with `body`, `head`,
`arm_left`, `arm_right`, `leg_left`, and `leg_right` bones, plus three attach sockets
for gear, `hand_left`, `hand_right`, and `back`. Its canonical shape:

```text
waist
├── body
│   └── back          (socket)
├── head
├── arm_left
│   └── hand_left     (socket)
├── arm_right
│   └── hand_right    (socket)
├── leg_left
└── leg_right
```

The feet are origined at world y=0. The bones may sit at scene root or under
whatever parent the authoring tool produced; the rig contract only requires the
seven bones be present somewhere reachable, so resolve any of them by name with
`findByName(playerNode, 'head')`.

The three sockets are always built as persistent rig nodes, there to mount held
items and back-mounted props onto. When an avatar doesn't author one, the engine
derives its rest position from the parent bone's geometry, so creators get usable
mount points for free; an avatar that does author the socket keeps its own transform.

`sampleAvatars` pulls a batch of platform avatars (it resolves to an empty array
off-server, so fall back to a default). `loadAvatar` loads one and returns the
`{ modelId, rigType }` you hand to `assignAvatar`, which points a node's
`CharacterTrait` at that model. Balance each `loadAvatar` with a `releaseAvatar`
when the NPC despawns. `randomDisplayName` gives ambient NPCs a plausible name.

<Snippet source="avatars.snippet.ts" select="spawn-npc" />

## Audio

Audio plays from declared sound handles. `sound(id, { src })` declares a sound at
module scope, and three primitives play it: `playMono` for non-positional audio such
as UI and music, `playAt` for a fixed world position, and `playOnNode` for a source
that follows a moving node. All three are safe to call from shared scripts; they
no-op and return `null` on the server.

<Snippet source="audio.snippet.ts" select="play" />

Spatial sounds are heard relative to the `AudioListenerTrait`, which rides the
active camera.

## UI

Game UI is yours to build with the web platform: HTML, CSS, and JavaScript, with all
the freedom that brings. Every room has a viewport wrapping its canvas, exposed to
client scripts as `ctx.client.viewport`; append HTML to it for HUDs and menus. The
viewport ignores pointer events by default, so set `pointer-events: auto` on
anything interactive.

<Snippet source="ui.snippet.ts" select="hud" />

For UI anchored to a scene node rather than the screen, use the `HtmlTrait`, which
positions an HTML element at a node's world position, and `UILayer` controls
stacking order when overlays need to sit above or below one another. For a drawable
surface inside the world, such as a sign or screen, the `CanvasTrait` renders a 2D
canvas onto a node. And because the world renders with gpucat, advanced UI that
needs custom rendering can draw into the gpucat scene directly (see
[Going lower level](#going-lower-level)).

## Persistence

bongle persists data at two scopes, both server-only: the **game** and a single
**game-user**. `gameStorage` is the game-scoped store, shared across every room and
player, for leaderboards and shared world state. `userStorage` is scoped to one
player, for inventory, progression, and settings; key it by the player's user id,
which you resolve from a client with `clientToUser(ctx, client).id`. Both are simple
key-value stores.

<Snippet source="storage.snippet.ts" select="store" />

Stamp a `version` field inside every value you store. When the shape changes in a
later release, you read that version and fold old saves forward on load, the way
`loadSave` does above, so existing players keep their data. This is your own schema
version, and it is separate from the storage `version` that each `get` and `set`
returns: that one is a concurrency token you pass back as `ifVersion` on a write to
reject changes that raced with another writer.

Both stores also expose `delete` and `list` alongside `get` and `set`.

## Multiplayer, in depth

[The multiplayer model](#the-multiplayer-model) covered replication, where most
state crosses the wire for free. This chapter covers the rest: explicit messages
and multiple rooms.

### RPC

When you need to send a discrete message rather than replicate a field, declare a
command with `command(id, direction, schema)`. The direction is `CLIENT_TO_SERVER`
or `SERVER_TO_CLIENT`, and the schema both types the payload and serializes it.
Handle incoming commands with `listen`, and send with `send` (or `broadcast` to
reach every client).

<Snippet source="multiplayer.snippet.ts" select="rpc" />

That schema is a `pack` schema. `pack` is the engine's binary wire-format builder,
from [packcat](https://github.com/isaac-mason/packcat): you compose a payload shape
from `pack.object`, `pack.float32`, `pack.string`, `pack.list`, `pack.boolean`, and
the rest, plus bongle helpers such as `pack.quaternion()`, and the command serializes to
a compact binary frame rather than JSON. The same `pack` schemas back trait `sync`
replication under the hood, so it is the one wire format the whole engine speaks.
Do not confuse it with `prop` (from the [trait `control`](#traits) schema), which
describes editor-inspectable and persisted fields, not what crosses the network.

### Replication and authority

Most multiplayer state never needs an explicit message: a trait field with a
`sync` is serialized on the server and applied on every client. The sync's `rate`
controls how often it emits. `'realtime'` emits on every change, for positions and
health; `'dirty'` emits only when you call the returned handle's `dirty()`, for
fields you set once; and a number caps the rate in Hz.

Authority decides which side may write a synced field. By default it is the
server, so writes from clients are ignored. Set `authority: 'owner'` on the sync
to let the node's owning client write it instead, which is how player-controlled
and client-predicted entities work. `isOwner(ctx, node)` reports whether the
caller holds that authority, so one shared script can run on both sides and each
act only on the nodes it owns.

### Rooms

A **room** is one running instance of your game: its own copy of the scene,
voxels, physics, and the players currently in it. Everything a script reaches
through `ctx` belongs to its room, and most games run many rooms at once so no
single instance fills up or slows the others.

`matchmaking(config)` decides how arriving players are grouped into rooms (the
starter caps a room at 32 players). When you need rooms beyond the ones
matchmaking creates, for lobbies, private matches, or instanced dungeons, manage
them yourself: `rooms.create` opens one from a scene, `rooms.join` and `rooms.swap`
move a client between rooms, and `rooms.list` and `rooms.view` inspect them.

A client can also re-enter matchmaking itself with `client.matchmake`, handing
over new `gameOptions` to switch gamemodes or move from a lobby into a match.

<Snippet source="multiplayer.snippet.ts" select="rematch" />

`chat` carries text messages within a room, and `clientToUser` resolves a
connected client to its durable `User`.

## Building & deploying

`bongle build` compiles your project into `dist/bundle.zip`, a self-contained
bundle of the client, server, and content. `bongle start` serves a built `dist/`
locally, so you can play the production build before shipping it.

Deploying that bundle lands it as a **draft**. Promoting a draft to live is a
separate, deliberate step, so a deploy never changes what players see until you
publish it.

## API reference

For the exhaustive signature list, see the [API reference](./api.md).
