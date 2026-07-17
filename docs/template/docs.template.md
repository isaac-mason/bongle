# bongle

Read this guide top to bottom to learn the engine and its API, with examples and
guidance. Reach for the [API reference](./api.md) for the exhaustive signature list.

## What is bongle

bongle is a multiplayer voxel game engine built for the web. It powers
[bongle.io](https://bongle.io) and is free, open-source software.

At its core is a programmable voxel world: terrain made of blocks you can shape,
break, and rebuild while the game runs, with a scene of nodes living inside it that
you bring to life through scripts. Games are multiplayer by default, authoritative on
the server and rendered in every player's browser. The engine gives you:

- a built-in **editor** with client and server hot-module-reload
- an **asset pipeline** for blocks, textures, models, sounds, and sprites
- **voxel editing** with WorldEdit-style patterns and masks
- an opinionated voxel **world**, with APIs that leave broad creative freedom within it
- **client-server multiplayer** with distributed entity authority
- one-click **share**, to edit a world alongside anyone, anywhere

The chapters build this up from zero: scaffold a project, then nodes, traits, and
scripts; the multiplayer model; then rendering, physics, voxels, and the rest.

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

### Start from the new-bongle template

[new-bongle](https://github.com/isaac-mason/new-bongle) is a ready-made starter
project. Not yet set up for local development? You can poke around with a cloud environment like GitHub Codespaces:

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/isaac-mason/new-bongle)

It boots a container, installs dependencies, and starts the editor (forwarded on
`:3002`). You can also clone the `new-bongle` project and run `npm install && npm run edit` locally.

## Project structure

A scaffolded project is a small npm package. The pieces you work with:

```text
my-game/
├── src/
│   ├── index.ts        your game code (the entry point the engine loads)
│   └── generated/      generated code written by the editor (do not edit! changes will be wiped away!)
├── assets/             put your source files here: glTF, textures, audio, sprites
├── content/            editor-authored data (.scene.json)
├── dist/               build output: bundle.zip, from `bongle build`
├── package.json        the `bongle` dependency and scripts
└── tsconfig.json       typescript config, you probably don't need to touch this
```

- **`src/index.ts`** is where your code lives, the entry the engine loads. Split it
  into more files and import them as the game grows.
- **`src/generated/`** is written for you, not by hand. The asset pipeline scans
  `assets/` and `content/` and regenerates typed handles (`models.ts`, `sounds.ts`,
  `scenes.ts`) so `model('id')` and friends resolve and type-check. Never edit these;
  every build and editor session overwrites them.
- **`assets/`** holds the raw files you reference: a `.gltf` for `model()`, a `.png`
  for `blockTexture()` or `sprite()`, an `.ogg` for `sound()`. Point a declaration's
  `src` at one with `asset('./assets/...', import.meta.url)`.
- **`content/`** holds what you author in the editor, scenes saved as `.scene.json`.
  The editor regenerates `src/generated/scenes.ts` so code references them by name.
- **`dist/`** is the output of `bongle build`: a self-contained `bundle.zip` of
  client, server, and content, ready to serve or deploy.

Commit `src/index.ts`, `assets/`, `content/`, and the config files. The generated
`src/generated/`, the pipeline's intermediate `resources/`, `dist/`, and
`node_modules/` are all regenerated, and the scaffold gitignores them.

## Your first scripts

`bongle new my-game` scaffolds a project whose `src/index.ts` is already a complete,
playable game, built from a few short scripts. They are short enough to read in full,
so we will walk them top to bottom. Everything below is imported from `bongle`, except
the starter blocks, which come from `bongle/starter`.

First, register content and size the room:

<Snippet source="first-game.snippet.ts" select="setup" />

`use(blocks)` pulls in the starter block set so those block types are registered
and appear in the editor palette (it keeps the declarations alive through
bundling). `matchmaking({ maxPlayers: 32 })` sets how many players matchmaking
puts in one room.

Next, a script that sets up the sky and sun:

<Snippet source="first-game.snippet.ts" select="environment" />

Game logic lives in scripts. A script attaches behaviour to a trait, and
`system('environment', factory, opts)` is the scene-wide form: sugar for a
script on the always-present world node, so its factory runs once per scene.
(The general form, `script(SomeTrait, ...)`, binds behaviour to a specific
trait, running once per node that carries it, covered in [the programming
model](#the-programming-model).) Inside, `onInit` registers a one-time setup
callback that calls `setEnvironment` and `setEnvironmentTime` to choose a preset
sky and a 9am sun. The `{ editor: true }` option runs it in the editor as well
as at play time, so the world is lit while you build it.

Finally, place players as they join:

<Snippet source="first-game.snippet.ts" select="spawn" />

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
hooks. Scene-wide logic that runs over many entities, spawning, scoring, AI, uses
`system(...)`, a script on the world node.

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

### Nodes and the scene tree

A node is one object in the scene tree. On its own it carries almost nothing;
what it can do comes from the traits you add. `createNode` returns a **detached**
node, `addTrait` gives it a capability, `addChild` attaches it under a parent so
it goes live, and `destroyNode` removes a node and its subtree.

<Snippet source="scene-tree.snippet.ts" select="hierarchy" />

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

### Transforms

Every node with a `TransformTrait` has a position, rotation, and scale. You
write **local-space** values with setters and read **world-space** values with
getters. Setters propagate a dirty flag down the subtree; getters lazily
recompute only when something upstream changed, so reading is cheap when
nothing moved.

The local setters are `setPosition`, `setQuaternion`, and `setScale`, or
`setTransform` to write all three at once:

<Render select="api/transforms:setPosition" />

The world getters read where a node actually ended up after its parents' transforms
apply: `getWorldPosition`, `getWorldQuaternion`, `getWorldScale`, and
`getWorldMatrix`.

<Render select="api/transforms:getWorldPosition" />

To place a node at an absolute world position or orientation regardless of its
parent, write through `setWorldPosition` and `setWorldQuaternion`. And for rendering,
the `getVisualWorld*` family (`getVisualWorldPosition` and friends) reads the
**interpolated** transform rather than the logic one, which is what camera work and
other `onFrame` code should read (see
[Ticks, frames, and interpolation](#ticks-frames-and-interpolation)).

In practice you add a `TransformTrait` to a node, set its local position, then
read back where it lands in world space:

<Snippet source="transforms.snippet.ts" select="place-node" />

See the [API reference](./api.md#transforms--scene-tree) for the full set of
transform setters and getters.

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

Two registrars extend a trait. `control` exposes a field to the editor inspector and
saves it in scene files; `sync` replicates a field across the network. Each takes a
`schema`: `control` uses a `prop` schema (for the editor and persistence), `sync` uses
a `pack` schema (the binary wire format). The two vocabularies mirror each other.

<Render select="api/traits:control" heading />
<Render select="api/traits:sync" heading />

The `prop` builders cover the field types the inspector can edit:

| Builder | Field |
| --- | --- |
| `prop.boolean()`, `prop.string()`, `prop.number({ min, max, step })` | a checkbox, text, or number input |
| `prop.vec2()`, `prop.vec3()`, `prop.vec4()`, `prop.quaternion()` | vector and rotation inputs |
| `prop.enumeration([...])` | a dropdown of fixed choices |
| `prop.list(of)`, `prop.tuple([...])` | a variable-length or fixed array |
| `prop.object({ ... })`, `prop.record(of)` | a nested struct or keyed map |
| `prop.optional(of)`, `prop.nullable(of)`, `prop.nullish(of)` | wrap any of the above as maybe-absent |
| `prop.mesh()`, `prop.prefab()`, `prop.block()` | an asset reference picker |

The `pack` builders (from [packcat](https://github.com/isaac-mason/packcat)) mirror
them for the wire, with explicit sizes since bytes matter:

| Builder | Wire type |
| --- | --- |
| `pack.boolean()`, `pack.string()` | a boolean, a length-prefixed string |
| `pack.uint8()` … `pack.uint32()`, `pack.int8()` … `pack.int32()` | sized integers |
| `pack.varuint()`, `pack.varint()` | variable-length integers (small values cost fewer bytes) |
| `pack.float32()`, `pack.float64()`, `pack.quantized(...)` | floats, or a compressed fixed-range float |
| `pack.enumeration([...])`, `pack.literal(...)` | a fixed choice |
| `pack.list(of)`, `pack.tuple([...])` | a variable or fixed array |
| `pack.object({ ... })`, `pack.record(of)`, `pack.union(...)` | a struct, keyed map, or tagged variant |
| `pack.optional(of)`, `pack.nullable(of)` | maybe-absent / maybe-null |
| `pack.quat()`, and bongle's `pack.position()` / `pack.quaternion()` / `pack.scale()` | rotation and engine vector helpers |

`sync`'s rate and authority (which side may write a field) get a fuller treatment
under [replication and authority](#replication-and-authority).

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
seconds, and `ctx.clock.server` is the shared server time, the same on every client,
for anything that must agree across the network ([Server time](#server-time) covers
it in depth).

<Snippet source="time.snippet.ts" select="cooldown" />

### Logging

Use `log`, `warn`, and `error` instead of bare `console.log`. Each tags the
message with the script's trait and node and surfaces it in the editor as well as
the console, so you can tell which script and entity it came from.

<Snippet source="logging.snippet.ts" select="logging" />

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

The **systems** style is ECS-like: write a `system('name', factory)`, sugar for a
script on the always-present `WorldTrait` world node, define data-only traits on
your entities, and have the system `query` for those traits and iterate them each
tick. Logic is centralized in a few systems and entities are just data. This
suits anything that runs over many entities at once, such as scoring, spawning,
or AI.

The **actor** style puts a `script` directly on an entity's own trait, so each node
carries its own behaviour. The factory runs once per entity, with `ctx.node` and
`ctx.trait` scoped to that one. This suits self-contained objects: a door, a
pickup, a projectile.

Most games mix the two. A root-level system owns the rules that span entities,
while individual entities keep their own local behaviour.

### Client, server, and editor

The same source runs on both sides; a few flags decide where and when each piece
runs, and the unused branches are stripped at build time.

**Which side.** `env.server` and `env.client` are build-time booleans, so a guard like
`if (!env.server) return` compiles its body out of the client bundle entirely. Put
authoritative simulation behind `env.server`, and visuals, input, and UI behind
`env.client`. Inside a script, `ctx.server` and `ctx.client` are the matching runtime
handles, present only on their side.

<Snippet source="sides.snippet.ts" select="sides" />

For moving state from the server to clients, a `sync` on a trait is the usual path;
for discrete events, use RPC ([Multiplayer](#multiplayer) covers both).

**Editor builds.** `env.editor` is true only when the project runs under the editor in
development, and false in production deploys, so authoring helpers and debug overlays
live behind it and never ship.

**Edit vs play.** A script's lifecycle hooks do not run while the editor is in edit
mode by default; pass `{ editor: true }` as the script's options to opt in (the
starter's lighting script does exactly this, so the world is lit while you build it). A
script that runs in both then reads `ctx.mode`, which is `'edit'` or `'play'` per room,
to tell which it is. A classic use is an authoring-only marker, a label over each spawn
point while editing, gone at play time.

<Snippet source="sides.snippet.ts" select="editor-marker" />

### Hot reload

In the editor, saving a script re-runs its factory live, so edits take effect
without a restart. The old instance is disposed first, so its `onDispose` runs,
then the new factory runs. Factory-scope locals reset by design; to carry state
across a reload, register `onSwap` with a serialize and deserialize pair.

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

<Snippet source="math.snippet.ts" select="scratch" />

## Multiplayer

[The multiplayer model](#the-multiplayer-model) introduced replication, where most
state crosses the wire for free. This chapter goes deeper: how `sync` replication,
authority, and ownership actually work; client-side prediction; explicit messages
with RPC; and managing multiple rooms.

### Replication and authority

Most multiplayer state never needs an explicit message: give a trait field a `sync`
and it replicates from its authoritative side to every other side automatically, on
every change. (Replication applies only to shared-realm nodes; the
[realm](#nodes-and-the-scene-tree) section covers the others.)

When a field gets noisy, tune how often it emits with the sync's `rate`. The default
is `'realtime'`, every change. The alternatives trade freshness for bandwidth:
`'dirty'` emits only when you call the handle's `dirty()` (for fields you set once), a
number caps the rate in Hz, and a threshold like `syncRate.distance(0.1)` re-emits
only after the value moves that far, so a body coming to rest goes quiet on the wire.

**Authority** decides which side may write a synced field. By default it is the
server, so writes from clients are ignored. Set `authority: 'owner'` on the sync to
let the node's owning client write it instead, which is how player-controlled and
client-predicted entities work.

<Snippet source="sync.snippet.ts" select="sync" />

**Ownership** is the separate axis behind that. Each shared node has an **owner**, a
player or none: a player's own node is owned by their client from the moment they
join, and an unowned node is driven by the server. `isOwner(ctx, node)` answers "do I
have write authority here": on the server it is true for unowned nodes, and on a
client it is true only for that client's own nodes, so one shared script can run on
both sides and act only where it has authority. On a client, a node it does not own
is a **proxy**: it renders the replicated state but does not drive it. The engine
assigns ownership; you read it with `isOwner` but do not reassign it.

Ownership in bongle is fixed this way rather than transferable at runtime: there is no
take-ownership call. A player owns their own node and nothing else; everything else is
server-owned. For an entity a player should control, like a vehicle they enter or an
object they carry, keep it server-authoritative and route that player's input to it
(over RPC, or by reading their owned player node), rather than handing the entity
itself to the client.

These two axes, per-field authority and per-node ownership, compose, and a player is
the classic case. The player node is owned by its client so movement stays responsive,
but the things a player must not forge, health, score, an inventory, stay
**server-authoritative on the same entity**. Do this per field by leaving those syncs
at the default `authority: 'server'` (the engine's own player node works this way: its
character-controller input is owner-authoritative while its identity is server-owned),
or per node by hanging a server-owned child off the player. Any node you create has no
owner, so the server drives everything on it, which makes a child node a clean home
for a server-owned subsystem like an inventory.

<Snippet source="authority.snippet.ts" select="mixed-authority" />

### Client-only nodes

A `shared` node replicates to every client; there is no per-client visibility filter
that shows it to some clients and hides it from others. When you want something to
exist on one client only, make it a **client-only node**: create it with
`realm: 'client'` and it lives on that client alone, never replicated and never
serialized.

The common pattern is to hang client-only nodes under a server-authoritative parent
for purely local visuals: a name tag, a particle trail, a held-item model, a
selection highlight. The shared parent replicates, and each client builds its own
decoration as a child that rides the parent's transform and is removed automatically
when the parent goes away. Build it in a client context (guard with `ctx.client` or
`env.client`), and make creation idempotent, since a client script can run every
frame: check whether the child already exists before adding it.

<Snippet source="client-nodes.snippet.ts" select="client-node" />

The server never knows these nodes exist, so you animate and update them freely on the
client without touching replication. This is also the answer to showing something to
only some players: there is no visibility flag, so create the node client-side instead
of making it shared.

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

### Server time

`ctx.clock.time` is a private per-side timeline: it starts at 0 on each side and is
not comparable across the wire, so it is only for local cooldowns and durations. For
anything that must agree across clients, a projectile's spawn instant, an ability's
deadline, a round timer, use `ctx.clock.server`, which reads the same timeline on the
server and every client.

On the server `clock.server` is just the tick clock. On a client it is a continuously
synced *estimate* of the server's clock, and deliberately not "now": it is held about
one-way latency behind true server-now, plus a small jitter buffer. The client seeds
it from the join handshake, then locks onto the server clock that rides each tick
packet, converging smoothly and snapping only on a large gap (the first sync, or a
backgrounded tab catching up).

That render-behind offset is the point, not a flaw: it makes a server-stamped event
line up. Stamp the event's time on the server with `ctx.clock.server`, replicate the
stamp, and on the client compare against `ctx.clock.server`. Because the client's clock
sits one-way latency behind, the event's data arrives just as the local clock crosses
its timestamp, so a projectile appears at the muzzle as you see it fired, not already
downrange.

<Snippet source="server-time.snippet.ts" select="server-clock" />

Use it carefully. Treat `clock.server` as "when the things I am seeing happened on the
server", not as a precise current time, and clamp a derived age to be non-negative
(`Math.max(0, now - stamp)`), since a just-arrived stamp can sit a hair ahead of the
local clock. It can jump on a snap, so do not write logic that breaks on a
discontinuity. And for smooth per-frame visuals that never cross the wire, read
`ctx.clock.wall` instead: it advances every frame by real elapsed time and never
stalls, but it is local to each side.

### RPC

Replication suits continuous state; for a one-off event, send a message instead.
Declare a command with `command(id, direction, schema)`. The direction is
`CLIENT_TO_SERVER` or `SERVER_TO_CLIENT`, and the schema both types the payload and
serializes it. Handle incoming commands with `listen`, and send with `send` (or
`broadcast` to reach every client).

<Snippet source="multiplayer.snippet.ts" select="rpc" />

The schema is a `pack` schema, composed from the same `pack` builders that back trait
`sync` ([tabled under Traits](#traits)), so the command serializes to a compact binary
frame rather than JSON.

### Rooms

A **room** is one running instance of your game: its own copy of the scene,
voxels, physics, and the players currently in it. Everything a script reaches
through `ctx` belongs to its room, and most games run many rooms at once so no
single instance fills up or slows the others.

`matchmaking(config)` decides how arriving players are grouped into rooms (the
starter caps a room at 32 players). When you need rooms beyond the ones matchmaking
creates, for lobbies, private matches, or instanced dungeons, manage them yourself:
`rooms.create` opens one from a scene; `rooms.join`, `rooms.swap`, and `rooms.leave`
move a client in and out; `rooms.list` and `rooms.view` inspect them; `rooms.active`
and `rooms.observed` report which room a client is in; and `rooms.stop` closes one.

A client can also re-enter matchmaking itself with `client.matchmake`, handing
over new `gameOptions` to switch gamemodes or move from a lobby into a match.

<Snippet source="multiplayer.snippet.ts" select="rematch" />

`clientToUser` resolves a connected client to its durable `User`, the cross-session
identity you key [persistence](#persistence) by.

### Chat

Every room has a chat channel. `chat.message(ctx, text)` emits a message: on the
server it broadcasts to every client as a system line; on a client it sends the text
as if the player typed it. The text carries inline formatting tags that the chat
panel applies as it renders, `[#rrggbb]` for colour, `[b]`, `[i]`, `[u]`, and `[s]`
for bold, italic, underline, and strike, and `[/]` to reset, so you can colour a kill
feed or highlight an announcement. `chat.onMessage(ctx, fn)`, client-only, fires for
the plain messages players type.

<Snippet source="chat.snippet.ts" select="message" />

Chat is also a command surface. `chat.command(ctx, spec)` registers a typed slash
command from a `{ name, description, args }` spec and returns a handle; `chat.listen`
attaches the handler that runs it. Register the command in a shared script so it
exists on both sides, the client gets autocomplete and argument validation as the
player types, then `listen` on the side that should execute it, usually the server. A
matched command is consumed rather than shown as a chat line. Each argument has a
`type`, a built-in like `'string'` or `'number'`, or one you build with
`chat.argType` or `chat.enumType` for custom resolvers and inline enums; the handler
receives the parsed `args`, any `flags`, and the `from` client.

<Snippet source="chat.snippet.ts" select="command" />

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

Prefabs are placeable in the editor too. A declared prefab appears in the editor
inventory, so you can drop instances into a scene while authoring, the same template
placed by hand instead of spawned from code, and the saved scene carries those
instances with it.

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

### Patterns and masks

The voxel tools, brushes, fill and replace, the heightmap sculptors, share two
parameters borrowed from WorldEdit: a **pattern** that decides *what* block to place,
and a **mask** that decides *which* voxels a stroke is allowed to touch.

A pattern is sampled per voxel to answer "what block goes here":

| Syntax | Description | Example |
| --- | --- | --- |
| `block` | a single block | `stone` |
| `a,b` | an even random mix | `stone,dirt` |
| `N%a,M%b` | a weighted random mix | `10%stone,90%dirt` |
| `$active` | the active hotbar slot's block | `$active` |

A mask filters where the op applies, answering "does this voxel match":

| Syntax | Description | Example |
| --- | --- | --- |
| `block` | matches that block | `stone` |
| `#existing` | any non-air voxel | `#existing` |
| `!mask` | negation | `!stone` |
| `a,b` | or-list (matches either) | `stone,dirt` |
| `a b` | intersection (matches all, space-separated) | `#existing !stone` |
| `%N` | a random N% of voxels | `%50` |

So a brush with pattern `moss` and mask `stone` paints moss onto existing stone only.
These are a small subset of WorldEdit's grammar, enough to place and constrain blocks
across the toolset without scripting.

## Assets

Models, textures, sounds, and sprites come from asset files in your project. You
declare each as a handle at module scope and point it at its source: `model(id,
{ src })` for a glTF, `sound(id, { src })` for audio, and `blockTexture` and
`sprite` for images. That handle is what the rest of your code and the editor
reference.

Give `src` an `asset('./file', import.meta.url)`. The asset then co-locates with
the module that declares it and resolves relative to that module wherever it's
installed, which is what lets a shared pack ship its assets alongside its code. A
plain string path relative to the project root also works, but prefer the `asset()`
form.

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

Blocks live in the per-room `Voxels`, reachable in any script as `ctx.voxels`, and
the block types themselves in the per-room block registry, `ctx.blocks`. `setBlock`
writes a block by world coordinate and `getBlock` reads its key back; `getBlockState`
reads the numeric **state id**, the block kind plus its block-state values in one
integer (the same id a raycast hit reports). The empty cell has state id `AIR`, so
compare `getBlockState` against it to test for air. `forEachBlock` walks every block
that has been set. Server edits replicate to clients automatically.

<Snippet source="blocks.snippet.ts" select="edit-world" />

To find which block a ray hits, for a build cursor or a hitscan weapon, use
`raycastVoxels` (covered under [Scene queries](#scene-queries)). The starter blocks
also include presets such as doors; toggle one with `getDoorOpen` and `setDoorOpen`.

### Reacting to changes

To run logic when the world changes, register a block event for a block type.
`onBlockBuild` and `onBlockBreak` fire when a block of that type is placed or
broken, and `onBlockStateChange` fires when it changes state in place. All three
are server-only and hand you the world coordinates of the change.

<Snippet source="blocks.snippet.ts" select="block-events" />

## Rendering & visuals

Everything the player sees comes from a handful of built-in pieces: the camera and
lighting, the traits that draw a node, the model and character system that brings in
glTF art, and particles. This chapter covers them all, then drops to the renderer
for anything they do not:

- [Camera](#camera): the room's view and projection, and the controllers that move it.
- [Lighting and sky](#lighting-and-sky): sky presets, time of day, and voxel lighting.
- [Models and meshes](#models-and-meshes): bringing in glTF geometry (the 99% path) and the low-level mesh trait.
- [glTF support](#gltf-support): exactly which glTF/GLB features are imported.
- [Visual modifiers](#visual-modifiers): per-instance tint, flash, glow, unlit, and dither.
- [Characters](#characters): rigged humanoids that players and NPCs render as.
- [Avatars](#avatars): the model a humanoid renders with, and spawning NPCs.
- [Animation](#animation): playing a model's glTF clips.
- [Procedural animation](#procedural-animation): posing bones from code each frame.
- [Voxel meshes](#voxel-meshes): standalone, movable block meshes.
- [Sprites](#sprites): 2D billboards and extruded sprite slabs.
- [Particles](#particles): short-lived sprite effects such as smoke, sparks, and dust.

### Camera

Every room has a default camera node, reachable in a client script as
`ctx.client.camera`. Its `CameraTrait` holds the projection (`fov`, `near`,
`far`). `ctx.client.camera` is the *active* camera node: what the renderer
composes the render camera from each frame. The builtin controllers (orbit, fly,
player) write its pose each frame; you can read the trait to adjust field of view
or seed a pose before adding a controller, and `setCamera(ctx, node)` repoints it
at a different camera node.

<Snippet source="visuals.snippet.ts" select="camera" />

Each client has a **subject**: the node local input drives and the engine treats
as this client's point of view (renderer + audio). `getSubject(ctx)` returns it.
Builtin controllers and view-only scripts gate their per-frame work on it with
`getSubject(ctx) === ctx.node`, so only the active subject writes the camera or
consumes input. Read the active camera pose off `getCamera(ctx)`'s
`TransformTrait` for aiming, reticles, or raycasts from the eye (the render camera
object itself is renderer-private).

You write your own controller the same way: gate on being the subject, then drive
`getCamera(ctx)`'s transform however you like (follow, orbit, first-person). The
builtin orbit / fly / player controllers are just this pattern; the snippet below
is a minimal one.

To **possess** a different node, a free-flying spectator or death cam, or a
vehicle you own, call `setSubject(ctx, node)`. That node needs its own controller
so your input drives it and the camera follows; `setSubject` alone only redirects
input + POV. It is client-only and purely local: it changes what that client
controls, never ownership, and never the server-side streaming anchor (that stays
the player node). Pass `null` to clear it. To merely **view** something you do not
control, a fixed shot, another player, call `setCamera(ctx, node)` instead, which
repoints just the render camera and leaves control where it is. The client also
holds `defaultSubject` / `defaultCamera` (seeded to the player node and the room
camera) as the values to restore when a temporary override ends.

<Snippet source="visuals.snippet.ts" select="subject" />

### Lighting and sky

`setEnvironment` and `setEnvironmentTime` choose a sky preset and time of day
(`ENVIRONMENT_OVERWORLD` is the default daylight preset). Voxel lighting is
flood-filled through the grid; turn it on and set a floor level with the
server-only `configureFloodFillLighting`.

<Snippet source="visuals.snippet.ts" select="lighting" />

### Models and meshes

You bring 3D art into the world by declaring a model and placing a copy of it. A
model is loaded from a glTF file (`.gltf` or `.glb`, the format bongle supports) and
can be anything: a prop, a pickup, a piece of scenery, or a character. A **character**
is just a model that follows the humanoid rig, so it can be animated and driven like a
player or an NPC; it gets its own treatment under [Characters](#characters), but
everything here applies to it too.

`model(id, { src })` declares a model from a glTF at module scope and returns a handle.
`cloneModel(handle.scene)` makes a copy of its node subtree, installing the render slot
a visible node needs, which you attach to the scene. You almost never build geometry
by hand.

<Snippet source="character.snippet.ts" select="place-model" />

A model is a tree of named nodes, and you often want to drive one part of it from
code: open a chest lid, mount an item on a hand, attach an effect to a turret. The
handle indexes everything the glTF contains by name, as `handle.nodes`,
`handle.meshes`, and `handle.animations`. On a placed clone, reach the live instance
of a named node with `findByName(clone, name)`, then read or write its traits.

<Snippet source="character.snippet.ts" select="reference-node" />

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

### Visual modifiers

Every rendered mesh carries a set of per-instance, client-only visual fields you drive
from script to restyle an instance without touching its geometry or material. The same
vocabulary recurs across the renderer, on sprites, voxel meshes, and characters, and
particles expose it through their `update` pool (`tintR/G/B/A`, `glow`).

| Setter | Field | Does |
| --- | --- | --- |
| `setMeshTint(t, [r,g,b,a])` | `tint` | recolour toward `rgb` at intensity `a`, lightness-preserving |
| `setMeshFlash(t, [r,g,b,a])` | `flash` | a transient overlay over the tint but under lighting |
| `setMeshGlow(t, n)` | `glow` | self-illumination 0–1: light the mesh in its own colour, `1` = shadow-free |
| `setMeshLitMin(t, n)` | `litMin` | a minimum light floor so it stays readable in the dark |
| `setMeshUnlit(t, b)` | `unlit` | skip world lighting entirely and render the texture flat |
| `setMeshDither(t, n)` | `dither` | a screen-door fade 0–1 that drops fragments to fade an instance out |

`tint` and `flash` both recolour, but `tint` is the persistent one (a team colour you
set once) while `flash` is the momentary one you pulse and decay (a red hit-flash, a
charge-up glow). `litMin`, `glow`, and `unlit` are three points on a lighting-override
scale: `litMin` lifts the dark floor a little, `glow` lights the instance in its own
colour up to shadow-free, and `unlit` drops world lighting altogether, for UI overlays,
icon meshes, and hologram-style effects. `dither` is a transparency you can afford in
bulk: fragments are discarded against a dither pattern, so it stays in the opaque pass
with no sorting or blending (the cost is a slightly pixelly edge). It is how a character
mesh fades out when the camera pushes inside it.

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

<Snippet source="avatars.snippet.ts" select="spawn-npc" />

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

### Procedural animation

Some pose work can't come from a baked clip: a head that tracks the camera, a
spring that reacts to the parent's motion, a constraint that clamps a joint. Use
`onPostAnimate`, which fires after the animator has sampled this tick's clips but
before world matrices are recomputed. At that point a bone's local TRS is fresh, so
writes here layer on top of the sampled pose rather than being overwritten by it.
Built-in character locomotion (arm and leg swing, head-look) runs in exactly this
phase.

<Snippet source="character.snippet.ts" select="procedural" />

### Voxel meshes

`VoxelMeshTrait` draws a standalone `VoxelModel`: the same greedy-meshed block look
as the terrain, but as a movable scene node rather than part of the world grid, for
vehicles, doors, and detached chunks of structure. It shares the same render knobs
as `MeshTrait`.

Build one from blocks: make a standalone grid with `createVoxels(ctx.blocks)`, paint
it with `setBlock`, wrap it in a model with `createVoxelModel`, and point a
`VoxelMeshTrait` at it.

<Snippet source="voxel-model.snippet.ts" select="voxel-model" />

To make the structure solid and movable, build the same `VoxelModel` on the server,
turn it into a collider with `createVoxelModelShape(model)`, and adopt that shape
into a `RigidBodyTrait` (see [Rigid bodies](#rigid-bodies)). The example games float
platforms and boats exactly this way.

### Sprites

`SpriteTrait` draws 2D art as a billboard that always faces the camera. Point its
`sprite` at a `sprite()` handle, whose `src` is a file, a procedural
[`draw()` descriptor](#assets), or an array of either for animation frames. Size it
with `width` and `height` (in source pixels) and `worldScale`, and set `fps` to play
those frames as an animation. Billboards suit items, pickups, foliage, and cheap
characters.
`ExtrudedSpriteMeshTrait` takes the same sprite art but extrudes it into a 3D slab
of `depth`, the chunky paper-craft look (think Crossy Road) that reads from any
angle rather than only head-on.

### Particles

Particles are short-lived sprites for effects like smoke, sparks, and dust.
Declare a particle type with `particle(id, { sprite, playback, update })`, pairing
a sprite with a motion `update`, then emit instances at a position with
`spawnParticle`. The quickest path is a ready-made `update`: `particleUpdate` ships
complete behaviours (`smoke`, `dust`, `spark`, `snow`, `rain`), and the starter pack
bundles whole presets under `particlePresets` in `bongle/starter`.

<Snippet source="visuals.snippet.ts" select="particles" />

For anything past the presets, write your own `update`. It runs once per live particle
each tick with `(pool, i, dt, voxels)`, a structure-of-arrays pool where you mutate the
`i`-th particle directly: `velX/Y/Z` for motion, `posX/Y/Z` for position, `size`,
`glow`, and the `tintR/G/B/A` multiplier (`A` is alpha). Kill one early by setting
`pool.expiresAt[i] = 0`. Build the body from the composable `particleUpdate.*`
primitives, each taking a strength argument, rather than from scratch:

| Primitive | Effect |
| --- | --- |
| `gravity(pool, i, dt, g)` | accelerate downward |
| `drag(pool, i, dt, k)` | damp velocity toward zero |
| `integrate(pool, i, dt)` | advance position by velocity |
| `collideSlide` / `collideBounce` / `collideLand` | resolve against voxels |
| `fadeAlpha(pool, i, dt, rate)` / `fadeRgb(...)` | fade alpha or colour out |

Variety comes from the spawn as much as the update. `spawnParticle`'s options
randomize each instance, `velX/Y/Z`, `lifetime`, `size`, `tint`, `glow`, and an
explicit `seed`, so a single burst scatters instead of moving in lockstep. The
per-particle `seed` is also readable inside the update for stable per-particle noise.

<Snippet source="visuals.snippet.ts" select="varied" />

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

<Snippet source="physics.snippet.ts" select="drop-body" />

**adopt mode** is the escape hatch. Leave `def` null, build a crashcat body yourself
against `ctx.physics.rigid.world` with the full crashcat API, and assign it to the
trait's `body`. The trait adopts it: it replicates the body and removes it on dispose
just as in def mode (null `body` first if you want to keep it alive). Reach for this
when you need a shape, joint, or setting the declarative `def` does not expose.

<Snippet source="physics.snippet.ts" select="adopt-body" />

### AABB bodies

An `AabbBodyTrait` is a lighter physics body: an axis-aligned box that never rotates
and skips the full rigid-body solver. That makes it cheap enough to run in bulk, for
projectiles, pickups, particles, or simple movers, where a [rigid body](#rigid-bodies)
would be overkill. Add one with `addTrait(node, AabbBodyTrait, { ... })` and shape its
behaviour through the trait's declarative fields: `halfExtents` for the box,
`linearVelocity` for initial motion, plus `gravityFactor`, `friction`, `restitution`,
`sensor`, and the `collisionGroups` / `collisionMask` pair that filters what it hits.
It falls under gravity and collides with voxels and other AABB bodies out of the box.

<Snippet source="aabb-body.snippet.ts" select="create" />

For motion the declarative `linearVelocity` can't express, reach for the `aabbBody`
namespace: imperative verbs over a body's live `.body`.
`aabbBody.setVelocity(ctx.physics.aabb, body, vx, vy, vz)` sets its velocity and wakes
it, so you can steer a body every tick, reading where it is from `body.position`.

<Snippet source="aabb-body.snippet.ts" select="drive" />

AABB bodies and rigid bodies simulate in separate worlds and do not collide with each
other by default. To let the character controller and the rigid-body solver collide
with an AABB body, set `rigidBodyImpostor: true`: it presents an impostor box to that
world while still simulating as a cheap AABB. A `ContactsTrait` reports its touches
just as it does for a rigid body.

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

<Snippet source="physics.snippet.ts" select="coin-pickup" />

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

`PlayerControllerTrait` drives a player node from input: each frame it reads movement
and look and moves the [character controller](#character-controller) and the camera, so
you do not write that math by hand. Every player node already carries it (see
[Players](#players)), and it ships first-person by default with a built-in `C` key that
cycles through the perspectives while playing.

Configure it through its `config`. The camera and field of view are per-client view
concerns, so set them on the controlling client:

| `config` field | Default | Controls |
| --- | --- | --- |
| `perspective` | `'first'` | the view: `'first'`, `'third-back'`, or `'third-front'` |
| `thirdPersonDistance` | `4` | camera distance behind the player in third-person |
| `cameraCollisionMargin` | `0.2` | how far the camera stays off walls it would clip through |
| `fov` | 75° | field of view, in radians |
| `fovSprint` | 85° | field of view while sprinting |
| `fovLerpSpeed` | `10` | how fast the fov eases between the two |

<Snippet source="player-controller.snippet.ts" select="configure" />

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
`RigidBodyTrait` def as `collisionGroups` and `collisionMask`. Two bodies collide only
when each one's group is in the other's mask. The engine reserves the low bits for its
own bodies, `COLLISION_GROUP_VOXELS` (`1 << 0`), `COLLISION_GROUP_NODES` (`1 << 1`),
and `COLLISION_GROUP_CHARACTERS` (`1 << 2`); your game uses `1 << 3` and up.

Characters use this by default: their mask excludes `COLLISION_GROUP_CHARACTERS`, so
they pass through each other Minecraft-style while still colliding with the world and
other bodies. Change it through a `CharacterControllerTrait`'s `config.collisionGroups`
/ `config.collisionMask` (applied live each tick); `collisionMask: 0xffffffff`
re-enables character-vs-character collision.

Declare your own groups with `defineCollisionGroups`, which hands out a named bit per
name above the reserved range. Assignment is positional, so it matches on every side;
groups are not synced, so call it once with a fixed list. Build masks with
`onlyGroups(...)` (collide with only these) and `exceptGroups(...)` (collide with all
but these). Reach for groups when a layer is too coarse for the rule you want:
projectiles that pass through their own team, entities that ignore each other but not
the world, triggers only certain bodies activate.

<Snippet source="physics.snippet.ts" select="collision-groups" />

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

Each connected client has a **player node** that the engine creates on join, already
carrying a default set of traits:

| Trait | Gives the player |
| --- | --- |
| `TransformTrait` | a position, rotation, and scale |
| `PlayerTrait` | identity: its `playerId`, `username`, and owning `client` |
| `CharacterTrait` | the humanoid rig and visuals (its [avatar](#avatars)) |
| `CharacterControllerTrait` | a kinematic controller for movement and collision |
| `PlayerControllerTrait` | reads input and drives the controller and the camera |

The node is owned by its client, so its movement is
[owner-authoritative](#replication-and-authority). The local player is
`ctx.client.player`; a joining player arrives as the `playerNode` in `onJoin`, as the
starter's spawn script uses. Add your own gameplay traits, health, score, an inventory,
to it in `onJoin`, and you usually drive movement with the `PlayerControllerTrait`
rather than writing it from scratch.

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

<Snippet source="input.snippet.ts" select="touch" />

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
canvas onto a node. And because the world renders with
[gpucat](https://github.com/isaac-mason/gpucat), advanced UI that needs custom
rendering can draw into the gpucat scene directly via `ctx.client.scene`.

## Persistence

bongle persists data at two scopes, both server-only: the **project** and a single
**project-user**. `projectStorage` is the project-scoped store, shared across every room and
player, for leaderboards and shared world state. `userStorage` is scoped to one
player, for inventory, progression, and settings; key it by the player's user id,
which you resolve from a client with `clientToUser(ctx, client).id`. Both are simple
key-value stores.

<Snippet source="storage.snippet.ts" select="store" />

Both scopes expose the same four async operations, `get`, `set`, `delete`, and
`list`. They take `ctx` first; the user store also takes a `userId` (resolve it with
`clientToUser(ctx, client).id`):

<Render select="api/storage:projectStorage" heading />
<Render select="api/storage:userStorage" heading />

`get` returns the stored entry or `null`. The value comes back wrapped with a storage
`version`:

<Render select="StorageEntry" heading />

`set` and `delete` return a result you should check rather than assume succeeded: a
write can fail with a `version_conflict` (another writer got there first) or a limit
such as `too_large`:

<Render select="StorageSetResult" heading />

`list` pages through a scope's keys, optionally filtered by `prefix`, and returns a
`nextCursor` to pass back for the next page:

<Render select="StorageListOpts" heading />
<Render select="StorageListPage" heading />

Stamp a `version` field inside every value you store. When the shape changes in a
later release, you read that version and fold old saves forward on load, the way
`loadSave` does above, so existing players keep their data. This is your own schema
version, separate from the storage `version` above, which is a concurrency token: pass
it back as `opts.ifVersion` on a write to reject changes that raced with another
writer.

## Performance

Before optimizing anything, measure. Press `` ` `` (backtick) while playing to toggle
the **debug panel**, an on-screen overlay of live performance metrics. Do not guess at
what is slow: open the panel and find the hot row first.

The panel reports three scopes side by side, the client globally, the current room on
the client, and that same room on the **server**, so you can tell a client-render cost
apart from a server-simulation one. It has three views:

- **Summary**: the headline frame time (ms per frame) plus the client and server tick
  times, the quickest read on whether you are CPU-bound and on which side.
- **CPU breakdown**: per-subsystem timings, so you can see which system (meshing,
  physics, lighting, scripts) is eating the frame.
- **Net breakdown**: inbound and outbound bandwidth in kb/s, broken down by message
  kind, for spotting a chatty `sync` or RPC.

The panel is the starting point for every performance question: it turns "the game
feels slow" into a specific row on a specific side.

## Building & deploying

`bongle build` compiles your project into `dist/bundle.zip`, a self-contained
bundle of the client, server, and content. `bongle start` serves a built `dist/`
locally, so you can play the production build before shipping it.

Deploying that bundle lands it as a **draft**. Promoting a draft to live is a
separate, deliberate step, so a deploy never changes what players see until you
publish it.

### CLI reference

The `bongle` CLI covers the whole workflow, from scaffolding a project to building
the bundle you deploy:

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
- [persistent-data](../examples/persistent-data): per-player and project-wide progress with `userStorage` and `projectStorage`.
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
