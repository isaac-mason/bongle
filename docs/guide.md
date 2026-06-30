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

## Project structure

A scaffolded project is a small npm package. The pieces you work with:

```text
my-game/
├── src/
│   ├── index.ts        your game code (the entry point the engine loads)
│   └── generated/      typed handles the pipeline writes (do not edit)
├── assets/             source files: glTF, textures, audio, sprites
├── content/            editor-authored scenes (.scene.json)
├── dist/               build output: bundle.zip, from `bongle build`
├── package.json        the `bongle` dependency and scripts
└── tsconfig.json
```

- **`src/index.ts`** is where your code lives, the entry the engine loads. Split it
  into more files and import them as the game grows.
- **`src/generated/`** is written for you, not by hand. The asset pipeline scans
  `assets/` and `content/` and regenerates typed handles (`models.ts`, `sounds.ts`,
  `scenes.ts`) so `model('id')` and friends resolve and type-check. Never edit these;
  every build and editor session overwrites them.
- **`assets/`** holds the raw files you reference: a `.gltf` for `model()`, a `.png`
  for `blockTexture()` or `sprite()`, an `.ogg` for `sound()`. Point a declaration's
  `src` at one with `new URL('./assets/...', import.meta.url)`.
- **`content/`** holds what you author in the editor, scenes saved as `.scene.json`.
  The editor regenerates `src/generated/scenes.ts` so code references them by name.
- **`dist/`** is the output of `bongle build`: a self-contained `bundle.zip` of
  client, server, and content, ready to serve or deploy.

Commit `src/index.ts`, `assets/`, `content/`, and the config files. The generated
`src/generated/`, the pipeline's intermediate `resources/`, `dist/`, and
`node_modules/` are all regenerated, and the scaffold gitignores them.

## Your first game

`bongle new my-game` scaffolds a project whose `src/index.ts` is already a
complete, playable game. It is short enough to read in full, so we will walk it
top to bottom. Everything below is imported from `bongle`, except the starter
blocks, which come from `bongle/starter`.

First, register content and size the room:

```ts
// register the starter block set so those blocks exist and show up in the editor
use(blocks);

// cap how many players matchmaking puts in one room
matchmaking({ maxPlayers: 32 });
```

`use(blocks)` pulls in the starter block set so those block types are registered
and appear in the editor palette (it keeps the declarations alive through
bundling). `matchmaking({ maxPlayers: 32 })` sets how many players matchmaking
puts in one room.

Next, a script that sets up the sky and sun:

```ts
// sky + a late-morning sun. { editor: true } runs this in the editor too, so
// the world is lit while you build it, not only at play time.
script(
    WorldTrait,
    'environment',
    (ctx) => {
        onInit(ctx, () => {
            setEnvironment(ctx, ENVIRONMENT_OVERWORLD);
            setEnvironmentTime(ctx, 9);
        });
    },
    { editor: true },
);
```

A script attaches behaviour to a trait. `script(WorldTrait, 'environment',
factory, opts)` runs its factory for every node carrying a `WorldTrait`, which
here is the single world node. Inside, `onInit` registers a one-time setup
callback that calls `setEnvironment` and `setEnvironmentTime` to choose a preset
sky and a 9am sun. The `{ editor: true }` option runs the script in the editor
as well as at play time, so the world is lit while you build it.

Finally, place players as they join:

```ts
// place each joining player. server-authoritative, so it only runs there.
script(WorldTrait, 'spawn', (ctx) => {
    if (!env.server) return;

    onJoin(ctx, ({ playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, [0, 5, 0]);

        // face the new player at a point of interest. setCharacterLookAt aims through
        // the character's eyes, setting its look yaw and pitch; the player controller
        // reads them, so the client's camera starts pointed that way.
        const controller = getTrait(playerNode, CharacterControllerTrait)!;
        setCharacterLookAt(controller, transform, [10, 5, 0]);
    });
});
```

This is server logic, so it returns early unless `env.server` is true (the
[multiplayer model](#the-multiplayer-model) covers why). `onJoin` fires once per
client that joins the room and hands you that client's `playerNode`. We read its
`TransformTrait` with `getTrait` and call `setPosition` to drop the player at
`[0, 5, 0]`, then face them toward a point of interest. The player node also carries
a `CharacterControllerTrait`, and `setCharacterLookAt(controller, transform, target)` aims it at
a world position, computing the look yaw and pitch through the character's eyes. The
player controller reads those angles, so the client's camera starts pointed that way.
(For a raw yaw and pitch, `setCharacterLook(controller, yaw, pitch?)` writes them directly.)

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
covered in [Multiplayer](#multiplayer).

## The programming model

A bongle game is built from three things: nodes, traits, and scripts. Nodes form
the scene tree, traits give a node state and capabilities, and scripts attach
behaviour to a trait. This chapter covers all three, then how code splits across
the client and server.

Every script runs with a **`ctx`**, its `ScriptContext`: the handle it reaches
everything through, from its own `ctx.node` and `ctx.trait` to the room's world
(`ctx.voxels`, `ctx.physics`, `ctx.clock`) and the lifecycle hooks below. `ctx` is
scoped to one **room**, and that matters from the start: a server runs many rooms at
once, each its own independent world, and your script runs once per node in each
room. So per-room state belongs on `ctx`-reachable things, a trait or the world
itself, never in a module-scope variable, which every room in the process would
share. Rooms get a fuller treatment in [Multiplayer](#rooms).

### Nodes and the scene graph

A node is one object in the scene tree. On its own it carries almost nothing;
what it can do comes from the traits you add. `createNode` returns a **detached**
node, `addTrait` gives it a capability, `addChild` attaches it under a parent so
it goes live, and `destroyNode` removes a node and its subtree.

```ts
// build a small subtree: a turret with a barrel child
const turret = createNode({ name: 'turret' });
addTrait(turret, TransformTrait);

const barrel = createNode({ name: 'barrel' });
addTrait(barrel, TransformTrait);
addChild(turret, barrel); // barrel is now a live child of turret

// find a descendant by name, then detach the whole subtree from the scene
const found = findByName(turret, 'barrel');
if (found) destroyNode(found);
```

`addTrait(node, Trait)` returns the new trait instance. `getTrait(node, Trait)`
reads it back later (or `null` if absent), and `hasTrait` tests presence.
`findByName` runs a depth-first search from a node for the first descendant with
a given name.

Every node has a **realm** that decides which sides it lives on. By default a node
inherits its parent's realm, which resolves to `'shared'` under the scene root: a
shared node exists on the server and every client, with the server authoritative and
its state replicated out to clients. The other realms never replicate: `realm:
'server'` lives only on the server, `realm: 'client'` only on the client that created
it, and `realm: 'each'` gives the server and every client their own independent copy.
Realm decides where a node exists; [replication and
authority](#replication-and-authority) decides what crosses the wire and who may
write it.

### Traits

If you have used an entity-component system, a trait is bongle's version of a
component: the node is the entity, and you compose its capabilities by adding
traits rather than subclassing.

A trait is named state, plus the behaviour and replication you attach to it. The
engine ships builtin traits (`TransformTrait`, `CameraTrait`, `RigidBodyTrait`,
and more), and you define your own with `trait(id, body)`. The body is a plain
object of fields; each value is either a literal default or a factory
`() => value` called once per instance.

```ts
// a trait is named state. fields are literals or factories (use a factory for
// any mutable default, such as a vector or array).
const HealthTrait = trait('health', {
    current: 100,
    max: 100,
});

// attach behaviour with script(). ctx.trait is typed as the HealthTrait instance.
script(HealthTrait, 'regen', (ctx) => {
    onTick(ctx, ({ delta }) => {
        ctx.trait.current = Math.min(ctx.trait.max, ctx.trait.current + 5 * delta);
    });
});
```

Two registrars extend a trait. `control` exposes a field to the editor inspector
and saves it in scene files. Its `schema`, built with the `prop` helpers such as
`prop.number()` or `prop.vec3()`, describes the field's type:

#### `control`

```ts
/**
 * register a control on a trait. callable multiple times per trait.
 * declared *after* the trait() literal so `t` is fully typed in get/set.
 * `id` is a stable string used as the persisted key in scene files and
 * the inspector lookup key.
 */
export function control<T extends TraitBase, V>(handle: TraitHandle<T>, controlId: string, body: ControlBody<T, V>): void;
```

`sync` replicates a field across the network. Its rate and authority (which side
may write it) get a fuller treatment under
[replication and authority](#replication-and-authority).

#### `sync`

```ts
/**
 * register a sync on a trait. callable multiple times per trait.
 * `id` is a stable string used for debug and per-attachment diff tracking.
 * returns a SyncHandle for producer-side dirty hints; wire envelope still
 * keys by `SyncHandle.index` (the slot in def.sync).
 */
export function sync<T extends TraitBase, S>(handle: TraitHandle<T>, syncId: string, body: SyncBody<T, S>): SyncHandle<T>;
```

### Scripts and lifecycle

`script(Trait, id, factory, opts?)` attaches behaviour. The factory runs once per
node that carries the trait, with a `ctx` whose `ctx.trait` is the bound instance
(fully typed) and `ctx.node` its node. Inside the factory you register lifecycle
hooks. This script registers every one, with the args each hands you and a note on
when it fires and on which side:

```ts
// every lifecycle hook a script can register, with the args each hands you.
script(WorldTrait, 'hooks', (ctx) => {
    // once, when the script attaches to a node (and again on every hot reload).
    onInit(ctx, () => log(ctx, 'init'));

    // every fixed-timestep tick (60 Hz), on both server and client. gameplay
    // simulation lives here. delta: seconds since the previous tick.
    onTick(ctx, ({ delta }) => log(ctx, 'tick', delta));

    // first thing each frame, ahead of onUpdate and onTick. client only.
    // read input and set intent here. delta: seconds since the previous frame.
    onInput(ctx, ({ delta }) => log(ctx, 'input', delta));

    // once per frame, before that frame's ticks. client only. rarely needed
    // (prefer onInput for input). delta: seconds since the previous frame.
    onUpdate(ctx, ({ delta }) => log(ctx, 'update', delta));

    // once per frame, after the ticks and interpolation. client only. use for
    // camera work and reading final visual positions. delta: as above.
    onFrame(ctx, ({ delta }) => log(ctx, 'frame', delta));

    // a client joined the room. server only. client: the joiner's id;
    // playerNode: their spawned player node (args also carry user, joinData).
    onJoin(ctx, ({ client, playerNode }) => log(ctx, 'join', client, playerNode.id));

    // a client left the room. server only.
    onLeave(ctx, ({ client, playerNode }) => log(ctx, 'leave', client, playerNode.id));

    // the script is being torn down: node removal or hot reload. release here
    // anything the script set up (timers, mounted DOM, loaded assets).
    onDispose(ctx, () => log(ctx, 'dispose'));
});
```

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

```ts
script(WorldTrait, 'enemies', (ctx) => {
    // create the live query once; it stays in sync as nodes match and unmatch
    const enemies = query(ctx, [EnemyTrait, TransformTrait]);

    onTick(ctx, () => {
        // each match is a tuple of the requested trait instances
        for (const [enemy, transform] of enemies) {
            if (enemy.hp <= 0) continue;
            const pos = getWorldPosition(transform);
            console.log(enemy.hp, pos);
        }
    });
});
```

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
[Multiplayer](#multiplayer).

## Multiplayer

[The multiplayer model](#the-multiplayer-model) introduced replication, where most
state crosses the wire for free. This chapter goes deeper: how `sync` replication,
authority, and ownership actually work; client-side prediction; explicit messages
with RPC; and managing multiple rooms.

### Replication and authority

Replication only concerns shared-realm nodes (the [realm](#nodes-and-the-scene-graph)
section covers the rest). Most multiplayer state on them never needs an explicit
message: a trait field with a `sync` is serialized on its authoritative side and
applied everywhere else. The sync's `rate` controls how often it emits: `'realtime'`
(the default) emits on every change, for positions and health; `'dirty'` emits only
when you call the returned handle's `dirty()`, for fields you set once; a number caps
the rate in Hz; and a threshold rate such as `syncRate.distance(0.1)` re-emits only
once the value has moved that far, which is how a body coming to rest goes quiet on
the wire.

**Authority** decides which side may write a synced field. By default it is the
server, so writes from clients are ignored. Set `authority: 'owner'` on the sync to
let the node's owning client write it instead, which is how player-controlled and
client-predicted entities work.

**Ownership** is the separate axis behind that. Each shared node has an **owner**, a
player or none: a player's own node is owned by their client from the moment they
join, and an unowned node is driven by the server. `isOwner(ctx, node)` answers "do I
have write authority here": on the server it is true for unowned nodes, and on a
client it is true only for that client's own nodes, so one shared script can run on
both sides and act only where it has authority. On a client, a node it does not own
is a **proxy**: it renders the replicated state but does not drive it. The engine
assigns ownership; you read it with `isOwner` but do not reassign it.

### Client-side prediction

Waiting for the server to confirm every action would make the game feel laggy, so
predicted entities run their simulation locally and reconcile against the server
afterward. A client simulates the entity the instant it needs to, from your own input
or a dynamic body moving between server snapshots; the server runs the authoritative
version; and when the server's result arrives the client blends its transform toward
it rather than snapping. Your own inputs feel instant while the server stays the
source of truth.

Rigid bodies predict by default. With `RigidBodyTrait`'s `prediction` flag on (the
default), each client runs the dynamic body locally instead of only snapping to
snapshots, so it stays smooth between updates; where a body has a client owner, that
owner runs it ahead of the server and reconciles. The player controller predicts a
player's own movement the same way. Set `def.prediction: false` on a body where a
brief snap on correction is fine and you would rather not pay the cost, such as
distant, low-stakes objects.

### RPC

Replication suits continuous state; for a one-off event, send a message instead.
Declare a command with `command(id, direction, schema)`. The direction is
`CLIENT_TO_SERVER` or `SERVER_TO_CLIENT`, and the schema both types the payload and
serializes it. Handle incoming commands with `listen`, and send with `send` (or
`broadcast` to reach every client).

```ts
// a typed client-to-server command
const FireWeaponCommand = command('fire-weapon', CLIENT_TO_SERVER, pack.object({ charge: pack.float32() }));

script(WorldTrait, 'weapon-rpc', (ctx) => {
    // the server is the only side that handles an incoming client command
    if (env.server) {
        listen(ctx, FireWeaponCommand, (data, from) => {
            console.log('fire', data.charge, 'from', from);
        });
    }

    // the client is the only side that sends it
    if (env.client) {
        onInit(ctx, () => {
            send(ctx, FireWeaponCommand, { charge: 1 });
        });
    }
});
```

That schema is a `pack` schema. `pack` is the engine's binary wire-format builder,
from [packcat](https://github.com/isaac-mason/packcat): you compose a payload shape
from `pack.object`, `pack.float32`, `pack.string`, `pack.list`, `pack.boolean`, and
the rest, plus bongle helpers such as `pack.quaternion()`, and the command serializes to
a compact binary frame rather than JSON. The same `pack` schemas back trait `sync`
replication under the hood, so it is the one wire format the whole engine speaks.
Do not confuse it with `prop` (from the [trait `control`](#traits) schema), which
describes editor-inspectable and persisted fields, not what crosses the network.

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

```ts
// move this client into another gamemode by re-entering matchmaking
script(WorldTrait, 'switch-mode', (ctx) => {
    onInit(ctx, () => {
        if (ctx.client) client.matchmake(ctx, { gameOptions: { mode: 'ffa' } });
    });
});
```

`chat` carries text messages within a room, and `clientToUser` resolves a
connected client to its durable `User`.

## Transforms

Every node with a `TransformTrait` has a position, rotation, and scale. You
write **local-space** values with setters and read **world-space** values with
getters. Setters propagate a dirty flag down the subtree; getters lazily
recompute only when something upstream changed, so reading is cheap when
nothing moved.

The local setters are `setPosition`, `setQuaternion`, and `setScale`, or
`setTransform` to write all three at once:

```ts
/** set local position and mark dirty. only the position slice replicates. */
export function setPosition(t: TransformTrait, v: Vec3): void;
```

The world getters read where a node actually ended up after its parents' transforms
apply: `getWorldPosition`, `getWorldQuaternion`, `getWorldScale`, and
`getWorldMatrix`.

```ts
/** get world-space position, decomposing from worldMatrix if needed. */
export function getWorldPosition(t: TransformTrait): Vec3;
```

To place a node at an absolute world position or orientation regardless of its
parent, write through `setWorldPosition` and `setWorldQuaternion`. And for rendering,
the `getVisualWorld*` family (`getVisualWorldPosition` and friends) reads the
**interpolated** transform rather than the logic one, which is what camera work and
other `onFrame` code should read (see
[Ticks, frames, and interpolation](#ticks-frames-and-interpolation)).

In practice you add a `TransformTrait` to a node, set its local position, then
read back where it lands in world space:

```ts
// give a node a transform, then position it in local space
const crate = createNode({ name: 'crate' });
const transform = addTrait(crate, TransformTrait);
setPosition(transform, [4, 1, -2]);

// read where it ended up in world space (after any parent transforms apply)
const worldPos = getWorldPosition(transform);
console.log(worldPos);
```

See the [API reference](./api.md#transforms--scene-graph) for the full set of
transform setters and getters.

## Math

bongle's math types come from [mathcat](https://github.com/isaac-mason/mathcat), a
small linear-algebra library. Vectors, matrices, and quaternions are plain numeric
tuples, so a `Vec3` is just `[x, y, z]`, and the operations live in namespaces you
import from `mathcat`: `vec2`, `vec3`, `vec4`, `mat3`, `mat4`, and `quat`.

The API is gl-matrix style, so if you know gl-matrix you already know it: an
operation takes its output target first and writes into it, avoiding allocation, as
in `vec3.add(out, a, b)` or `vec3.normalize(out, v)`. Reach for `mathcat` whenever you
do vector math yourself, such as steering, aiming, or camera work.

That output-first shape is built for **scratch buffers**: allocate a few reusable
vectors once and write through them every tick rather than creating a new vector per
operation, which matters in hot paths like `onTick`. Declare them in the script
factory so each script instance gets its own, and prefix them with an underscore
(`_toTarget`) to mark them as throwaway working memory, not state anything reads
later.

```ts
script(MoverTrait, 'move-to-target', (ctx) => {
    // scratch buffers live in the script and are reused every tick, so the hot
    // path allocates nothing. the leading underscore marks them as throwaway
    // working memory, not state to read elsewhere.
    const _toTarget: Vec3 = vec3.create();
    const _step: Vec3 = vec3.create();
    const target: Vec3 = [10, 1, 5];

    onTick(ctx, ({ delta }) => {
        const transform = getTrait(ctx.node, TransformTrait);
        if (!transform) return;
        const position = getWorldPosition(transform);

        // step `speed` metres/second toward the target, writing through the
        // scratch buffers instead of allocating a new vector each tick
        vec3.subtract(_toTarget, target, position);
        vec3.normalize(_toTarget, _toTarget);
        vec3.scaleAndAdd(_step, position, _toTarget, ctx.trait.speed * delta);
        setPosition(transform, _step);
    });
});
```

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

```ts
// a prefab clones a scene's node children under each instance's root
const PenguinPrefab = prefab('penguin', {
    type: 'nodes',
    deps: [PenguinScene],
    fn: (ctx) => {
        for (const child of PenguinScene.node.children) {
            addChild(ctx.root, cloneNode(child));
        }
    },
});
```

To place an instance, call `createPrefab` from a script. Like `createNode`, it
returns a **detached** node; `addChild` attaches it, and the engine builds the
prefab's contents on the next tick.

```ts
// instantiate inside a script: createPrefab returns a detached node, attach
// it to make it live
script(WorldTrait, 'spawn-penguins', (ctx) => {
    onInit(ctx, () => {
        const penguin = createPrefab(ctx, PenguinPrefab);
        addChild(ctx.node, penguin);
    });
});
```

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

```ts
// declare each asset once at module scope; the handle is what you reference
// src is a `new URL('./file', import.meta.url)`, so each asset co-locates with the
// module that declares it and survives bundling (a plain project-root path also works)
const MascotModel = model('mascot', { src: new URL('./assets/mascot.gltf', import.meta.url) });
const ChimeSound = sound('chime', { src: new URL('./assets/chime.ogg', import.meta.url) });
const MarbleBlockTexture = blockTexture('marble', { src: new URL('./assets/marble.png', import.meta.url) });
const SmokeSprite = sprite('smoke', { src: new URL('./assets/smoke.png', import.meta.url) });

// a block texture feeds a block model
const MarbleBlock = block('guide:marble', {
    name: 'Marble',
    model: () => ({ type: 'cube', textures: { all: { texture: MarbleBlockTexture } } }),
});

// keep handles that nothing else references in code alive through bundling
use(MascotModel, ChimeSound, SmokeSprite, MarbleBlock);
```

The asset pipeline processes these sources when you build or edit, generating the
typed handles in `src/generated/` (`models.ts`, `sounds.ts`, `scenes.ts`) so named
content is available without hand-wiring it. Because a bundler can drop a
declaration that nothing references in code, pass any handle that is only named in
data, such as a scene's block palette or a prefab id, to `use` so it stays alive.

A texture or sprite source need not be a file. Pass a `draw()` descriptor as the
`src` and it paints the image at bake time with a 2D canvas context, which is
handy for procedural or composed textures.

```ts
// a texture's src can be a draw() descriptor that paints the image at bake time,
// instead of loading a file
const CheckerBlockTexture = blockTexture('checker', {
    src: draw(
        (c) => {
            c.fillStyle = '#222';
            c.fillRect(0, 0, 16, 16);
            c.fillStyle = '#eee';
            c.fillRect(0, 0, 8, 8);
            c.fillRect(8, 8, 8, 8);
        },
        { size: [16, 16] },
    ),
});
use(CheckerBlockTexture);
```

## Voxels & blocks

The world's terrain is a voxel grid. Every cell holds a block type, the grid is
split into fixed-size chunks, and you can change it freely while the game runs.

### Defining a block type

`block(id, options)` declares a block at module scope. The most common model is a
textured cube: map a texture to `all` faces, or to `top`, `bottom`, and `sides`
separately. The starter pack ships ready-made textures under `bongle/starter`.

```ts
// declare a block type at module scope. a cube model maps a texture to its
// faces; `all` covers every face (use top/bottom/sides to differ them).
const RubyBlock = block('guide:ruby', {
    name: 'RubyBlock Block',
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.stone } } }),
});
```

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

```ts
// a block with a boolean `lit` property, so it has two states
const LampBlock = block('guide:lamp', {
    name: 'LampBlock',
    states: blockState.create({ lit: blockState.bool() }),
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.stone } } }),
});

// address a specific state by its property values; pass the key to setBlock
const litKey = LampBlock.stateKey({ lit: true });
console.log(litKey);
```

### Reading and writing the world

Blocks live in the per-room `Voxels`, reachable in any script as `ctx.voxels`, and
the block types themselves in the per-room block registry, `ctx.blocks`. `setBlock`
writes a block by world coordinate and `getBlock` reads its key back; `getBlockState`
reads the numeric **state id**, the block kind plus its block-state values in one
integer (the same id a raycast hit reports). The empty cell has state id `AIR`, so
compare `getBlockState` against it to test for air. `forEachBlock` walks every block
that has been set. Server edits replicate to clients automatically.

```ts
// read and write blocks through ctx.voxels, addressed by world x/y/z
script(WorldTrait, 'place-ruby', (ctx) => {
    onInit(ctx, () => {
        // write a block; server edits replicate to clients automatically
        setBlock(ctx.voxels, 0, 0, 0, RubyBlock.defaultKey());

        // read a block's key, and its numeric state id (block kind + block state)
        const key = getBlock(ctx.voxels, 0, 0, 0);
        const stateId = getBlockState(ctx.voxels, 0, 0, 0);
        log(ctx, key, stateId);

        // AIR is the empty-cell state id: compare a state against it to test for air
        if (getBlockState(ctx.voxels, 0, 1, 0) === AIR) {
            log(ctx, 'nothing above the block');
        }

        // walk every non-air block that has been set
        forEachBlock(ctx.voxels, (x, y, z, blockKey) => {
            log(ctx, 'block at', x, y, z, blockKey);
        });
    });
});
```

To find which block a ray hits, for a build cursor or a hitscan weapon, use
`raycastVoxels` (covered under [Scene queries](#scene-queries)). The starter blocks
also include presets such as doors; toggle one with `getDoorOpen` and `setDoorOpen`.

### Reacting to changes

To run logic when the world changes, register a block event for a block type.
`onBlockBuild` and `onBlockBreak` fire when a block of that type is placed or
broken, and `onBlockStateChange` fires when it changes state in place. All three
are server-only and hand you the world coordinates of the change.

```ts
// react when a block of this type is placed or broken (server-only)
script(WorldTrait, 'ruby-events', (ctx) => {
    onBlockBuild(ctx, RubyBlock, (ev) => {
        console.log('placed at', ev.worldX, ev.worldY, ev.worldZ);
    });
    onBlockBreak(ctx, RubyBlock, (ev) => {
        console.log('broke at', ev.worldX, ev.worldY, ev.worldZ);
    });
});
```

## Rendering & visuals

Everything the player sees comes from a handful of built-in pieces: the camera and
lighting, the traits that draw a node, the model and character system that brings in
glTF art, and particles. This chapter covers them all, then drops to the renderer
for anything they do not:

- [Camera](#camera): the room's view and projection, and the controllers that move it.
- [Lighting and sky](#lighting-and-sky): sky presets, time of day, and voxel lighting.
- [Models and meshes](#models-and-meshes): bringing in glTF geometry (the 99% path) and the low-level mesh trait.
- [glTF support](#gltf-support): exactly which glTF/GLB features are imported.
- [Characters](#characters): rigged humanoids that players and NPCs render as.
- [Avatars](#avatars): the model a humanoid renders with, and spawning NPCs.
- [Animation](#animation): playing a model's glTF clips.
- [Procedural animation](#procedural-animation): posing bones from code each frame.
- [Voxel meshes](#voxel-meshes): standalone, movable block meshes.
- [Sprites](#sprites): 2D billboards and extruded sprite slabs.
- [Shadows](#shadows): cheap blob shadows under a node.
- [Particles](#particles): short-lived sprite effects such as smoke, sparks, and dust.

### Camera

Every room has a camera node, reachable in a client script as `ctx.client.camera`.
Its `CameraTrait` holds the projection (`fov`, `near`, `far`). The builtin
controllers (orbit, fly, player) write its pose each frame, but you can read the
trait to adjust field of view or seed a pose before adding a controller.

```ts
// the room already has a camera node; read its CameraTrait to set field of view
script(WorldTrait, 'camera-setup', (ctx) => {
    onInit(ctx, () => {
        if (!ctx.client) return;
        const camera = getTrait(ctx.client.camera, CameraTrait);
        if (camera) camera.fov = (60 * Math.PI) / 180;
    });
});
```

### Lighting and sky

`setEnvironment` and `setEnvironmentTime` choose a sky preset and time of day
(`ENVIRONMENT_OVERWORLD` is the default daylight preset). Voxel lighting is
flood-filled through the grid; turn it on and set a floor level with the
server-only `configureFloodFillLighting`.

```ts
// sky preset + voxel flood-fill lighting, set once on the world
script(
    WorldTrait,
    'lighting',
    (ctx) => {
        onInit(ctx, () => {
            setEnvironment(ctx, ENVIRONMENT_OVERWORLD);
            if (ctx.server) configureFloodFillLighting(ctx, { enabled: true, minLevel: 4 });
        });
    },
    { editor: true },
);
```

### Models and meshes

Most visible 3D content is glTF. A plain **model** is any glTF you place in the
world, such as a prop, a pickup, or a piece of scenery. A **character** is a rigged
humanoid that animates and that players and NPCs render as. They share the loading
machinery here but differ in how you drive them.

In almost every case you bring 3D geometry into the world by declaring a model and
instancing it, not by building meshes by hand. `model(id, { src })` declares a model
from a glTF at module scope and returns a handle; `cloneModel(handle.scene)` copies
its subtree and installs the render slot a visible node needs, and you attach the
clone to the scene.

```ts
// declare a model from a glTF at module scope
const ChestModel = model('chest', { src: new URL('./assets/chest.gltf', import.meta.url) });

script(WorldTrait, 'place-chest', (ctx) => {
    onInit(ctx, () => {
        // clone the model's scene and attach it; cloneModel installs the
        // render slot a visible subtree needs
        const chest = cloneModel(ChestModel.scene);
        addChild(ctx.node, chest);
    });
});
```

A model is a tree of named nodes, and you often want to drive one part of it from
code: open a chest lid, mount an item on a hand, attach an effect to a turret. The
handle indexes everything the glTF contains by name, as `handle.nodes`,
`handle.meshes`, and `handle.animations`. On a placed clone, reach the live instance
of a named node with `findByName(clone, name)`, then read or write its traits.

```ts
// a model's named glTF nodes are reachable on the placed clone by name, so you can
// drive a sub-part from code: open a lid, mount an item on a hand, attach an effect.
script(WorldTrait, 'open-chest', (ctx) => {
    onInit(ctx, () => {
        const chest = cloneModel(ChestModel.scene);
        addChild(ctx.node, chest);

        const lid = findByName(chest, 'lid');
        if (lid) {
            const lidTransform = getTrait(lid, TransformTrait);
            if (lidTransform) setPosition(lidTransform, [0, 0.4, -0.4]); // swing the lid up and back
        }
    });
});
```

Underneath, the trait that actually draws geometry is `MeshTrait`: it renders one
mesh referenced by `meshId`, such as `handle.meshes.<Name>.id`. Reach for it directly
only when you want a single mesh without the surrounding model subtree. It carries
the shared render knobs every visual trait has (`tint`, `glow`, `flash`, `unlit`,
`visible`), set through helpers such as `setMeshTint` and `setMeshGlow`.

Models load at build time from your declarations. For the rare case where a model's
source is only known at runtime, `loadModel`, `getModel`, `ensureModel`, and
`releaseModel` fetch and reference-count one on the fly; prefer a declared `model()`
when you can.

### glTF support

**TLDR: author with [bongle-blockbench](https://blockbench.bongle.io)** and you stay
inside the supported subset by construction. It is a build of
[Blockbench](https://www.blockbench.net/) set up for bongle (the same tool the
[Characters](#characters) section uses) that exports engine-ready glTF, so you rarely
need the specifics below.

If you bring a model from elsewhere, bongle imports a deliberate subset. Either
`.gltf` or `.glb` works; the asset pipeline normalizes the source at build time and
the engine reads the canonical result. Exactly what it uses:

- **Geometry**: triangle meshes with `POSITION`, optional `NORMAL`, and one UV set,
  `TEXCOORD_0`. Multiple primitives on a mesh are flattened into one. Indices may be
  unsigned byte, short, or int.
- **Materials**: the PBR **base-color texture** only, sampled through `TEXCOORD_0`.
  Metallic-roughness, normal, emissive, and occlusion maps are not used.
- **Animation**: node **TRS** tracks (`translation`, `rotation`, `scale`) with
  `LINEAR`, `STEP`, or `CUBICSPLINE` interpolation.
- **Hierarchy**: the node tree and each node's local transform.

Everything else is ignored: skinning, morph targets, vertex colors, tangents,
cameras, lights, and glTF extensions. Because there is no skinning, animation moves
whole nodes rather than deforming a mesh, which is why character rigs are built from
separate bone nodes (see [Animation](#animation)).

### Characters

A character is a node with a `CharacterTrait`, which carries its model, sounds, and
effects and pairs with the `CharacterControllerTrait` from [Physics](#physics).
Player nodes get one automatically from their avatar (covered just below); for NPCs
you assign one yourself.

Character models follow a canonical humanoid rig, the `6bone` rig: a `waist` hub with
`body`, `head`, `arm_left`, `arm_right`, `leg_left`, and `leg_right` bones, plus three
attach sockets for gear, `hand_left`, `hand_right`, and `back`:

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

The feet are origined at world y=0. The bones may sit at scene root or under whatever
parent the authoring tool produced; the rig contract only requires the seven bones be
present somewhere reachable, so resolve any of them by name with
`findByName(node, 'head')`. The three sockets are always built as persistent rig
nodes for mounting held items and back-mounted props; when an avatar doesn't author
one, the engine derives its rest position from the parent bone's geometry, so
creators get usable mount points for free, while an authored socket keeps its own
transform.

You author character models in
[bongle-blockbench](https://github.com/isaac-mason/bongle-blockbench), a build of
[Blockbench](https://www.blockbench.net/) set up for bongle. It starts you from that
rig, validates it as you work, and exports an engine-ready glTF in one click. Run it
online at [blockbench.bongle.io](https://blockbench.bongle.io), or install it into
the Blockbench desktop app.

### Avatars

An avatar is the model a humanoid renders with. Player nodes receive one
automatically on join, resolved by the platform, so you rarely touch avatars for
players directly. The script-facing API is mainly for **NPCs**, ambient characters
you spawn yourself: `sampleAvatars` pulls a batch of platform avatars (it resolves to
an empty array off-server, so fall back to a default), and `loadAvatar` loads one and
returns the `{ modelId, rigType }` you hand to `assignAvatar`, which points a node's
`CharacterTrait` at that model. Balance each `loadAvatar` with a `releaseAvatar` when
the NPC despawns, and `randomDisplayName` gives ambient NPCs a plausible name.

```ts
// spawn an NPC and give it a platform avatar. server-only.
script(WorldTrait, 'spawn-npc', (ctx) => {
    if (!env.server) return;

    async function spawnNpc() {
        const avatars = await sampleAvatars(ctx);
        if (avatars.length === 0) return; // none available; fall back to a default

        const npc = createNode({ name: randomDisplayName() });
        addTrait(npc, TransformTrait);
        addTrait(npc, CharacterTrait);
        addChild(ctx.node, npc);

        // load, then point the node's CharacterTrait at the model
        const { modelId, rigType } = loadAvatar(ctx, avatars[0]!);
        assignAvatar(npc, modelId, rigType);
    }

    onInit(ctx, () => {
        void spawnNpc();
    });
});
```

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

```ts
// any glTF that ships clips can be animated, not just characters. bongle plays the
// glTF's TRS tracks (node translation/rotation/scale). there is no skinning.
const CrabModel = model('crab', { src: new URL('./assets/crab.gltf', import.meta.url) });

script(WorldTrait, 'crab-anim', (ctx) => {
    onInit(ctx, () => {
        const node = cloneModel(CrabModel.scene);
        addChild(ctx.node, node);

        const animator = getTrait(node, AnimatorTrait);
        if (!animator) return;

        // resolve clips to actions, then blend from idle into scuttle
        const idle = Animation.clip(animator, CrabModel.animations.idle);
        const scuttle = Animation.clip(animator, CrabModel.animations.scuttle);
        Animation.play(idle);
        Animation.crossFadeTo(idle, scuttle, 0.3);
    });
});
```

On a **character**, prefer procedural animation (below) for ongoing motion. Clip
playback writes the same bone TRS as the built-in procedural locomotion and
head-look, so the two fight; reserve clips on characters for one-shot emotes layered
on top, and let procedural code drive the moment-to-moment pose.

### Procedural animation

Some pose work can't come from a baked clip: a head that tracks the camera, a
spring that reacts to the parent's motion, a constraint that clamps a joint. Use
`onPostAnimate`, which fires after the animator has sampled this tick's clips but
before world matrices are recomputed. At that point a bone's local TRS is fresh, so
writes here layer on top of the sampled pose rather than being overwritten by it.
Built-in character locomotion (arm and leg swing, head-look) runs in exactly this
phase.

```ts
script(WorldTrait, 'head-look', (ctx) => {
    // fires after the animator samples this tick's clips, before world matrices
    // recompute: write bone local TRS here to layer a head-look, spring, or
    // joint clamp on top of the sampled pose instead of being overwritten by it
    onPostAnimate(ctx, () => {
        // e.g. findByName(ctx.node, 'head') and nudge its local rotation
    });
});
```

### Voxel meshes

`VoxelMeshTrait` draws a standalone `VoxelModel`: the same greedy-meshed block look
as the terrain, but as a movable scene node rather than part of the world grid, for
vehicles, doors, and detached chunks of structure. It shares the same render knobs
as `MeshTrait`.

Build one from blocks: make a standalone grid with `createVoxels(ctx.blocks)`, paint
it with `setBlock`, wrap it in a model with `createVoxelModel`, and point a
`VoxelMeshTrait` at it.

```ts
script(WorldTrait, 'spawn-platform', (ctx) => {
    if (!ctx.client) return; // VoxelMeshTrait is a visual; build the model client-side

    onInit(ctx, () => {
        // a standalone voxel grid, separate from the world, using the room's
        // block registry (ctx.blocks). paint into it with setBlock.
        const grid = createVoxels(ctx.blocks);
        for (let x = 0; x < 4; x++) {
            for (let z = 0; z < 4; z++) setBlock(grid, x, 0, z, PlankBlock.defaultKey());
        }

        // wrap the grid in a VoxelModel and draw it through a VoxelMeshTrait
        const platform = createNode({ name: 'platform', realm: 'client' });
        addTrait(platform, TransformTrait);
        addTrait(platform, VoxelMeshTrait).model = createVoxelModel(grid);
        addChild(ctx.node, platform);
    });
});
```

To make the structure solid and movable, build the same `VoxelModel` on the server,
turn it into a collider with `createVoxelModelShape(model)`, and adopt that shape
into a `RigidBodyTrait` (see [Rigid bodies](#rigid-bodies)). The example games float
platforms and boats exactly this way.

### Sprites

`SpriteTrait` draws 2D art as a billboard that always faces the camera. Point its
`sprite` at a `sprite()` handle, size it with `width` and `height` (in source
pixels) and `worldScale`, and set `fps` to play a multi-frame sprite as an
animation. Billboards suit items, pickups, foliage, and cheap characters.
`ExtrudedSpriteMeshTrait` takes the same sprite art but extrudes it into a 3D slab
of `depth`, the chunky paper-craft look (think Crossy Road) that reads from any
angle rather than only head-on.

### Shadows

`ShadowCasterTrait` drops a soft blob shadow onto the ground beneath a node, a cheap
way to ground characters and props without full shadow mapping. Tune its `radius`
and the `maxDistance` it searches downward for a surface.

### Particles

Particles are short-lived sprites for effects like smoke, sparks, and dust.
Declare a particle type with `particle(id, { sprite, playback, update })`, pairing
a sprite with a motion `update` (the `particleUpdate.*` helpers cover the common
ones), then emit instances at a position with `spawnParticle`. The starter pack
bundles ready-made presets under `particlePresets` in `bongle/starter`.

```ts
// a particle type pairs a sprite with a motion update
const SmokeSprite = sprite('smoke', { src: new URL('./assets/smoke.png', import.meta.url) });
const SmokeParticle = particle('smoke', {
    sprite: SmokeSprite,
    playback: 'stretch',
    update: particleUpdate.smoke,
});

script(WorldTrait, 'smoke-puffs', (ctx) => {
    onInit(ctx, () => {
        // emit one at a position; no-ops on the server
        spawnParticle(ctx, SmokeParticle, [0, 2, 0]);
    });
});
```

## Physics

bongle has two physics systems, both running per room, colliding with the voxel
world, simulating on the server, and replicating to clients (optionally with
[client-side prediction](#client-side-prediction)). **Rigid-body physics** is the
full solver: bodies with
mass, friction, and restitution that collide and respond realistically. **AABB
physics** is a lighter axis-aligned system for large numbers of simple movers that
do not need that fidelity. Reach for rigid bodies for props and ragdolls, AABB
bodies for projectiles, pickups, and crowds.

### Rigid bodies

Rigid-body physics in bongle is [crashcat](https://github.com/isaac-mason/crashcat),
the engine's physics library, and these docs lean into it rather than hide it.
crashcat runs the full solver: bodies with a shape, mass, friction, and restitution
that collide and respond. Every rigid body in a room is a crashcat body living in the
world at `ctx.physics.rigid.world`.

`RigidBodyTrait` is a convenience over that. It binds a crashcat body to a scene
node, replicates it, and tears it down with the node, so you rarely touch crashcat
for the common cases. It works in two modes.

**def mode** is the declarative path. Assign the trait's `def`, a recipe whose fields
mirror crashcat's `RigidBodySettings`, and the trait builds and owns the body: a
`shape` (`box`, `sphere`, `capsule`, `hull`, or `mesh`) plus optional `motionType`
(`MotionType.STATIC`, `KINEMATIC`, or `DYNAMIC`, the default), `friction`,
`restitution`, `mass`, `collisionGroups` / `collisionMask`, `sensor`, and the rest of
the `RigidBodySettings` surface.

```ts
// a dynamic body is a node with a RigidBodyTrait. assign its `def` to build one.
script(WorldTrait, 'drop-ball', (ctx) => {
    if (!env.server) return; // spawn on the server; physics replicates to clients

    onInit(ctx, () => {
        const ball = createNode({ name: 'ball' });
        const transform = addTrait(ball, TransformTrait);
        setPosition(transform, [0, 15, 0]);

        const bodyTrait = addTrait(ball, RigidBodyTrait);
        bodyTrait.def = { shape: { type: 'sphere', radius: 0.5 }, restitution: 0.4, friction: 0.5 };

        addChild(ctx.node, ball);
    });
});
```

**adopt mode** is the escape hatch. Leave `def` null, build a crashcat body yourself
against `ctx.physics.rigid.world` with the full crashcat API, and assign it to the
trait's `body`. The trait adopts it: it replicates the body and removes it on dispose
just as in def mode (null `body` first if you want to keep it alive). Reach for this
when you need a shape, joint, or setting the declarative `def` does not expose.

```ts
// "adopt mode": leave `def` null and hand the trait a crashcat body you built
// yourself, for shapes or settings the declarative def does not expose. the trait
// replicates it and tears it down on dispose, just as if it had built it.
script(WorldTrait, 'custom-body', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        const crate = createNode({ name: 'crate' });
        addTrait(crate, TransformTrait); // the body's transform syncs onto this node

        const body = rigidBody.create(ctx.physics.rigid.world, {
            shape: box.create({ halfExtents: [0.5, 0.5, 0.5] }),
            objectLayer: OBJECT_LAYER_NODE_MOVING,
            motionType: MotionType.DYNAMIC,
            position: [0, 12, 0],
            restitution: 0.4,
        });

        const bodyTrait = addTrait(crate, RigidBodyTrait); // def stays null
        bodyTrait.body = body; // adopt the body; the trait owns and replicates it from here

        addChild(ctx.node, crate);
    });
});
```

### AABB bodies

The `aabbBody` namespace builds the lighter axis-aligned bodies. They skip full
rigid-body solving, so they scale to many simple movers; drive one directly with
`aabbBody.setVelocity`.

### Character controller

`CharacterControllerTrait` is a kinematic mover for players and NPCs: it walks,
steps, and slides against the world without the wobble of a dynamic body. It pairs
with `CharacterTrait` for the visible body, covered under
[Characters](#characters).

You drive it through its `input`: `input.move` is a planar `[strafe, forward]`
vector, `input.look` is the `[_, yaw, pitch]` look spherical, and `input.jump`,
`input.sprint`, and `input.crouch` are held flags. The controller turns those into
motion each tick. For a player, a [`PlayerControllerTrait`](#players--input) fills
`input` from device input for you. For an NPC you write `input` yourself: set
`input.move` to steer, and aim with `setCharacterLook(controller, yaw, pitch?)` or
`setCharacterLookAt(controller, transform, target)` (which points the character at a world
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

```ts
// CoinTrait marks a pickup; `value` is how much it is worth.
const CoinTrait = trait('coin', { value: 1 });

// a coin is a static sensor body carrying a ContactsTrait, so players pass
// through it but still register a contact.
function spawnCoin(parent: Node, position: [number, number, number]) {
    const coin = createNode({ name: 'coin' });
    setPosition(addTrait(coin, TransformTrait), position);
    addTrait(coin, CoinTrait);
    addTrait(coin, ContactsTrait);
    addTrait(coin, RigidBodyTrait).def = {
        shape: { type: 'sphere', radius: 0.5 },
        motionType: MotionType.STATIC,
        sensor: true,
    };
    addChild(parent, coin);
}

script(WorldTrait, 'coins', (ctx) => {
    if (!env.server) return; // the server owns pickups

    // per-room running total. factory-scope state lives in this one script
    // instance (one per world node), never module scope, which every room shares.
    let coinsCollected = 0;

    const coins = query(ctx, [CoinTrait, ContactsTrait]);
    const players = query(ctx, [PlayerTrait]);

    onInit(ctx, () => {
        spawnCoin(ctx.node, [2, 1, 0]);
        spawnCoin(ctx.node, [4, 1, 0]);
    });

    // ContactsTrait fills `added` after each physics step; award and despawn any
    // coin a player's body just touched.
    onPostPhysicsStep(ctx, () => {
        const playerNodeIds = new Set<number>();
        for (const [player] of players) playerNodeIds.add(player._node.id);

        for (const [coin, contacts] of coins) {
            const touchedByPlayer = contacts.added.some(
                (c) => c.type === 'rigidBody' && playerNodeIds.has(c.nodeId),
            );
            if (touchedByPlayer) {
                coinsCollected += coin.value;
                log(ctx, `coin collected (total ${coinsCollected})`);
                destroyNode(coin._node);
            }
        }
    });
});
```

For lower-level control, `onPhysicsContact(ctx, 'added' | 'persisted', fn)` fires
during the step with the raw crashcat bodies and manifold, and lets you tune the
contact in place, such as zeroing friction for an ice patch or flagging it a sensor.

### Sensors

A **sensor** is a body that detects overlaps without colliding: other bodies pass
straight through it, but the overlap still registers as a contact. Sensors are how
you build triggers, pickups, and zones. Set `sensor: true` on a `RigidBodyDef` (or in
the crashcat body settings in adopt mode), pair the node with a `ContactsTrait`, and
react to what enters in `onPostPhysicsStep`. The coin pickup above is a worked
sensor: a static sensor body that awards and despawns the instant a player overlaps
it.

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

```ts
// hit-test the block grid: walk a ray from an origin along a direction and read
// the first solid block hit (build cursor, hitscan vs terrain, line of sight).
script(WorldTrait, 'block-pick', (ctx) => {
    onInit(ctx, () => {
        const out = createVoxelRaycastResult();
        raycastVoxels(
            out,
            ctx.voxels,
            ctx.blocks, // the block registry, for per-block flags
            0, 10, 0, // origin x/y/z
            0, -1, 0, // direction x/y/z (straight down)
            32, // max distance
            BLOCK_FLAG_COLLISION, // only blocks with collision count as a hit
        );
        if (out.hit) {
            // out.voxelX/Y/Z: the block cell; out.nx/ny/nz: the hit normal;
            // out.distance: range; out.stateId: which block kind was hit
            log(ctx, 'hit block at', out.voxelX, out.voxelY, out.voxelZ);
        }
    });
});
```

### Raycasting the physics world

For bodies rather than blocks, cast against the crashcat world at
`ctx.physics.rigid.world`. bongle deliberately does not wrap this: you call the
crashcat ray API directly (`castRay` with `createClosestCastRayCollector` and
`createDefaultCastRaySettings`) and read the hit off the collector. This is the same
direct-crashcat escape hatch described under [Rigid bodies](#rigid-bodies), and it is
the encouraged way to do physics queries.

```ts
// hit-test the physics world (rigid bodies, character controllers). bongle does
// not wrap this; cast against the crashcat world directly with the crashcat API.
script(WorldTrait, 'body-pick', (ctx) => {
    onInit(ctx, () => {
        const world = ctx.physics.rigid.world;

        // a filter scopes the query. start from the world's layers, then disable
        // the voxel terrain layer so the ray hits only bodies, not blocks.
        const rayFilter = crashcatFilter.forWorld(world);
        crashcatFilter.disableObjectLayer(rayFilter, world.settings.layers, OBJECT_LAYER_VOXELS);

        const collector = createClosestCastRayCollector();
        const settings = createDefaultCastRaySettings();
        castRay(world, collector, settings, [0, 10, 0], [0, -1, 0], 32, rayFilter);

        if (collector.hit.status === CastRayStatus.COLLIDING) {
            const distance = collector.hit.fraction * 32; // fraction is 0..1 along the ray
            log(ctx, 'hit body', collector.hit.bodyIdB, 'at', distance);
        }
    });
});
```

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

```ts
// where the NPC is heading (recompute this toward the nearest player for a chaser)
const GOAL: [number, number, number] = [12, 1, 8];

// the successor the search expands over. groundDropActions also walks off ledges
// and drops down; for gap-jumps, spread nav.groundMoves with longer offsets and
// build one with nav.gridActions(moves, nav.groundWalkable()).
const NPC_ACTIONS = nav.groundDropActions({ maxDrop: 8 });

// drive an NPC's character controller along a path to GOAL. actor-style: this runs
// once per node carrying a CharacterControllerTrait.
script(CharacterControllerTrait, 'npc-nav', (ctx) => {
    if (!env.server) return; // the server owns NPC movement; the result replicates

    const transform = getTrait(ctx.node, TransformTrait);
    if (!transform) return;

    let path: ReturnType<typeof nav.findPath> = [];
    let waypoint = 0;
    let repathIn = 0;

    onTick(ctx, ({ delta }) => {
        const controller = ctx.trait;
        const pos = getWorldPosition(transform);

        // repath a couple of times a second rather than every tick
        repathIn -= delta;
        if (repathIn <= 0) {
            repathIn = 0.5;
            const start: [number, number, number] = [Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])];
            const raw = nav.findPath(ctx.voxels, start, GOAL, NPC_ACTIONS, { maxIterations: 2000 });
            path = raw ? nav.smoothPath(ctx.voxels, raw, nav.groundShortcut()) : [];
            waypoint = 1; // skip the cell we're standing in
        }

        // drop waypoints we've reached (horizontal distance only)
        while (path && waypoint < path.length) {
            const cell = path[waypoint]!;
            const dx = cell[0] + 0.5 - pos[0];
            const dz = cell[2] + 0.5 - pos[2];
            if (dx * dx + dz * dz > 0.25) break;
            waypoint++;
        }

        if (!path || waypoint >= path.length) {
            controller.input.move[0] = 0;
            controller.input.move[1] = 0; // arrived, or no route: stand still
            return;
        }

        // steer toward the next waypoint: face it, then walk straight forward
        const cell = path[waypoint]!;
        const dx = cell[0] + 0.5 - pos[0];
        const dz = cell[2] + 0.5 - pos[2];
        setCharacterLook(controller, Math.atan2(-dx, -dz)); // face the next waypoint
        controller.input.move[0] = 0; // no strafe
        controller.input.move[1] = 1; // full forward
        controller.input.jump = controller.state.horizontalCollision; // hop when a full-block step stalls us
    });
});
```

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

```ts
// onInput runs first each frame, so read input and set intent here
script(WorldTrait, 'read-input', (ctx) => {
    onInput(ctx, () => {
        if (!ctx.client) return;
        const mouseKeyboard = ctx.client.input.mouseKeyboard;
        const forward = isKeyDown(mouseKeyboard, 'KeyW');
        const back = isKeyDown(mouseKeyboard, 'KeyS');
        if (forward !== back) {
            // drive movement, aim a weapon, etc.
        }
    });
});
```

These take the `mouseKeyboard` input. `code` is a `KeyboardEvent.code` such as
`'KeyW'` or `'Space'`, and `button` is `'left'`, `'middle'`, or `'right'`.

| Predicate | Reads |
| --- | --- |
| `isKeyDown(mouseKeyboard, code)` | key is held this frame |
| `isKeyJustDown(mouseKeyboard, code)` | key went down this frame (press edge) |
| `isKeyJustUp(mouseKeyboard, code)` | key went up this frame (release edge) |
| `isMouseDown(mouseKeyboard, button)` | mouse button is held |
| `isMouseJustDown(mouseKeyboard, button)` | button went down this frame |
| `isMouseJustUp(mouseKeyboard, button)` | button went up this frame |
| `isMouseTap(mouseKeyboard, button)` | a quick press-and-release landed this frame |
| `isMouseDragStart(mouseKeyboard, button)` | a drag began this frame |

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

```ts
// a PlayerControllerTrait already auto-mounts a move joystick and jump button on
// touch devices. mount game-specific controls yourself, gated on isTouchPrimary so
// tablets and touch laptops get them too, not just small phone screens.
script(WorldTrait, 'touch-controls', (ctx) => {
    if (!ctx.client || !isTouchPrimary(ctx)) return;

    // createTouchButton mounts under the room's touch overlay and returns a
    // disposer (it no-ops and returns null on the server).
    const fireButton = createTouchButton(ctx, {
        id: 'fire',
        right: 24,
        bottom: 24,
        width: 96,
        height: 96,
        label: 'Fire',
        look: true, // dragging the button also rotates the camera, so it doubles as an aim surface
    });

    onInput(ctx, () => {
        const touch = ctx.client?.input.touch;
        if (touch && isTouchButtonDown(touch, 'fire')) {
            // set fire intent for this frame
        }
    });

    onDispose(ctx, () => fireButton?.dispose());
});
```

## Audio

Audio plays from declared sound handles. `sound(id, { src })` declares a sound at
module scope, and three primitives play it: `playMono` for non-positional audio such
as UI and music, `playAt` for a fixed world position, and `playOnNode` for a source
that follows a moving node. All three are safe to call from shared scripts; they
no-op and return `null` on the server.

```ts
// declare a sound at module scope, then play it following a node
const ChimeSound = sound('chime', { src: new URL('./assets/chime.ogg', import.meta.url) });

script(WorldTrait, 'play-chime', (ctx) => {
    onInit(ctx, () => {
        // panner tracks the node each frame; safely no-ops on the server
        playOnNode(ctx, ChimeSound, ctx.node);
    });
});
```

Spatial sounds are heard relative to the `AudioListenerTrait`, which rides the
active camera.

## UI

Game UI is yours to build with the web platform: HTML, CSS, and JavaScript, with all
the freedom that brings. Every room has a viewport wrapping its canvas, exposed to
client scripts as `ctx.client.viewport`; append HTML to it for HUDs and menus. The
viewport ignores pointer events by default, so set `pointer-events: auto` on
anything interactive.

```ts
// append a screen-space overlay to the room's viewport (client only)
script(WorldTrait, 'hud', (ctx) => {
    onInit(ctx, () => {
        if (!ctx.client) return;
        const hud = document.createElement('div');
        hud.textContent = 'Score: 0';
        hud.style.pointerEvents = 'none';
        ctx.client.viewport.appendChild(hud);
    });
});
```

For UI anchored to a scene node rather than the screen, use the `HtmlTrait`, which
positions an HTML element at a node's world position, and `UILayer` controls
stacking order when overlays need to sit above or below one another. For a drawable
surface inside the world, such as a sign or screen, the `CanvasTrait` renders a 2D
canvas onto a node. And because the world renders with
[gpucat](https://github.com/isaac-mason/gpucat), advanced UI that needs custom
rendering can draw into the gpucat scene directly via `ctx.client.scene`.

## Persistence

bongle persists data at two scopes, both server-only: the **game** and a single
**game-user**. `gameStorage` is the game-scoped store, shared across every room and
player, for leaderboards and shared world state. `userStorage` is scoped to one
player, for inventory, progression, and settings; key it by the player's user id,
which you resolve from a client with `clientToUser(ctx, client).id`. Both are simple
key-value stores.

```ts
type PlayerSave = { version: number; coins: number; level: number };
const SAVE_VERSION = 1;

// normalize whatever was stored into the current shape: fill defaults, and
// migrate older versions forward as SAVE_VERSION grows.
function loadSave(stored: JsonValue | undefined): PlayerSave {
    const data = (stored ?? {}) as Partial<PlayerSave>;
    return { version: SAVE_VERSION, coins: data.coins ?? 0, level: data.level ?? 1 };
}

// userStorage is server-only and per-player; onJoin runs on the server.
script(WorldTrait, 'profiles', (ctx) => {
    async function onPlayerJoin(client: ClientId) {
        const user = clientToUser(ctx, client);

        const entry = await userStorage.get(ctx, user.id, 'save');
        const save = loadSave(entry?.value);

        // award a daily login bonus, then persist (the version travels with it)
        await userStorage.set(ctx, user.id, 'save', {
            version: save.version,
            coins: save.coins + 100,
            level: save.level,
        });
    }

    onJoin(ctx, ({ client }) => {
        void onPlayerJoin(client);
    });
});
```

Both scopes expose the same four async operations, `get`, `set`, `delete`, and
`list`. They take `ctx` first; the user store also takes a `userId` (resolve it with
`clientToUser(ctx, client).id`):

#### `gameStorage`

```ts
/** Game-scoped KV, shared across every room and player of this game. */
export const gameStorage: {
    get(ctx: ScriptContext, key: string): Promise<StorageEntry | null>;
    set(ctx: ScriptContext, key: string, value: JsonValue, opts?: {
        ifVersion?: string;
    }): Promise<StorageSetResult>;
    delete(ctx: ScriptContext, key: string, opts?: {
        ifVersion?: string;
    }): Promise<StorageDeleteResult>;
    list(ctx: ScriptContext, opts?: StorageListOpts): Promise<StorageListPage>;
};
```
#### `userStorage`

```ts
/**
 * Per-(game, user) KV, private to one player within this game. `userId`
 * is the durable platform identity (`User.id`). Resolve it from a
 * `Client` via `clientToUser(ctx, client).id`.
 */
export const userStorage: {
    get(ctx: ScriptContext, userId: string, key: string): Promise<StorageEntry | null>;
    set(ctx: ScriptContext, userId: string, key: string, value: JsonValue, opts?: {
        ifVersion?: string;
    }): Promise<StorageSetResult>;
    delete(ctx: ScriptContext, userId: string, key: string, opts?: {
        ifVersion?: string;
    }): Promise<StorageDeleteResult>;
    list(ctx: ScriptContext, userId: string, opts?: StorageListOpts): Promise<StorageListPage>;
};
```

`get` returns the stored entry or `null`. The value comes back wrapped with a storage
`version`:

#### `StorageEntry`

```ts
export type StorageEntry = {
    value: JsonValue;
    version: string;
};
```

`set` and `delete` return a result you should check rather than assume succeeded: a
write can fail with a `version_conflict` (another writer got there first) or a limit
such as `too_large`:

#### `StorageSetResult`

```ts
export type StorageSetResult = {
    ok: true;
    version: string;
} | {
    ok: false;
    code: 'version_conflict' | 'too_large' | 'rate_limited' | 'cap_exceeded';
};
```

`list` pages through a scope's keys, optionally filtered by `prefix`, and returns a
`nextCursor` to pass back for the next page:

#### `StorageListOpts`

```ts
export type StorageListOpts = {
    prefix?: string;
    cursor?: string;
    limit?: number;
};
```
#### `StorageListPage`

```ts
export type StorageListPage = {
    items: Array<{
        key: string;
        value: JsonValue;
        version: string;
    }>;
    nextCursor: string | null;
};
```

Stamp a `version` field inside every value you store. When the shape changes in a
later release, you read that version and fold old saves forward on load, the way
`loadSave` does above, so existing players keep their data. This is your own schema
version, separate from the storage `version` above, which is a concurrency token: pass
it back as `opts.ifVersion` on a write to reject changes that raced with another
writer.

## Building & deploying

`bongle build` compiles your project into `dist/bundle.zip`, a self-contained
bundle of the client, server, and content. `bongle start` serves a built `dist/`
locally, so you can play the production build before shipping it.

Deploying that bundle lands it as a **draft**. Promoting a draft to live is a
separate, deliberate step, so a deploy never changes what players see until you
publish it.

## Examples

The [`examples/`](../examples) directory holds small, self-contained programs, each
isolating one feature. Clone the repo and run any of them, as the
[Getting Started](#getting-started) section shows.

Feature examples:

- [audio](../examples/audio): playing sounds, non-positional, pitch-shifted, and a spatial source that follows a node.
- [blocks](../examples/blocks): defining block types with `block` and `blockPreset`, including procedural `draw()` textures.
- [sprites](../examples/sprites): the `SpriteTrait` billboard modes alongside particles.
- [dom-ui](../examples/dom-ui): the UI traits, `HtmlTrait` and `CanvasTrait`.
- [voxel-model](../examples/voxel-model): a movable `VoxelModel` with a collider, a floating boat you can stand on.
- [terrain](../examples/terrain): a fuller scene, generated terrain with blocks and an animated character.
- [persistent-data](../examples/persistent-data): per-player and game-wide progress with `userStorage` and `gameStorage`.
- [rooms](../examples/rooms): managing multiple rooms and moving clients between them.

Performance stress tests, each loading one subsystem heavily:

- [performance-terrain](../examples/performance-terrain): large terrain generation and streaming.
- [performance-chunks](../examples/performance-chunks): heavy voxel chunk edits and remeshing.
- [performance-lighting](../examples/performance-lighting): voxel flood-fill lighting under load.
- [performance-meshes](../examples/performance-meshes): many static glTF meshes.
- [performance-animated-meshes](../examples/performance-animated-meshes): many animated character models at once.
- [performance-physics-rigid-body](../examples/performance-physics-rigid-body): many rigid bodies in one simulation.
- [performance-physics-aabb-body](../examples/performance-physics-aabb-body): many lightweight AABB bodies.

## API reference

For the exhaustive signature list, see the [API reference](./api.md).
