# bongle API reference

The exhaustive signature list for the public `bongle` surface, generated from the
package's exports. For a guided, read-top-to-bottom introduction with runnable
examples, see [the guide](./docs.md).

## Scene graph & nodes

Create nodes, compose them with traits, and walk the tree.

<RenderModule select="api/scene-graph" />
<RenderModule select="builtins/transform" />
<RenderModule select="builtins/world" />

## Transforms

Read and write node positions, rotations, and scales in local and world space.

<RenderModule select="api/transforms" />

## Traits & schemas

Define traits and the schemas behind editor controls (`prop`) and network packing (`pack`).

<RenderModule select="api/traits" />
<RenderModule select="api/prop" />
<RenderModule select="api/pack" />

## Scripts & lifecycle

Attach behaviour and register lifecycle hooks.

<RenderModule select="api/scripts" />

## Logging & environment

Tagged logging and the build-time `env` / `platform` flags.

<RenderModule select="api/debug" />
<RenderModule select="api/env" />
<RenderModule select="api/platform" />

## Assets

Declare models, sounds, and sprites, and keep data-only handles alive.

<RenderModule select="api/asset" />
<RenderModule select="api/models" />
<RenderModule select="api/sounds" />
<RenderModule select="api/sprites" />
<RenderModule select="api/use" />

## Scenes & prefabs

Reference authored scenes and instantiate prefabs.

<RenderModule select="api/scenes" />
<RenderModule select="api/prefabs" />

## Voxels & blocks

Define block types, read and write the voxel grid, and react to changes.

<RenderModule select="api/blocks" />

## Rendering & visuals

The camera, lighting and sky, and the traits that draw a node.

<RenderModule select="builtins/camera" />
<RenderModule select="api/subject" />
<RenderModule select="api/lighting" />
<RenderModule select="api/environment" />
<RenderModule select="builtins/mesh" />
<RenderModule select="builtins/voxel-mesh" />
<RenderModule select="builtins/sprite" />
<RenderModule select="builtins/extruded-sprite" />
<RenderModule select="builtins/shadow-caster" />
<RenderModule select="api/particles" />

## Models, characters & animation

Rigged glTF characters and clip playback.

<RenderModule select="builtins/character" />
<RenderModule select="builtins/character-controller" />
<RenderModule select="builtins/animator" />
<RenderModule select="api/animation" />

## Avatars

Platform avatars for players and NPCs.

<RenderModule select="api/avatars" />
<RenderModule select="core/avatar/avatar" />

## Physics

Rigid bodies, AABB bodies, contacts, and the physics layers and groups.

<RenderModule select="api/physics" />
<RenderModule select="builtins/rigid-body" />
<RenderModule select="builtins/aabb-body" />
<RenderModule select="builtins/contacts" />

## Controllers

The player, fly, and orbit controller traits.

<RenderModule select="builtins/player" />
<RenderModule select="builtins/player-controller" />
<RenderModule select="builtins/fly-controller" />
<RenderModule select="builtins/orbit-controller" />

## Pathfinding

Grid pathfinding over the voxel world.

<RenderModule select="api/nav" />

## Players & input

Reading mouse, keyboard, and touch input.

<RenderModule select="api/input" />
<RenderModule select="api/mobile" />
<RenderModule select="api/touch-controls" />
<RenderModule select="api/pointer-lock" />

## Audio

Declaring and playing sounds.

<RenderModule select="api/audio" />
<RenderModule select="builtins/audio-listener" />

## UI

World-anchored HTML, canvases, and layering.

<RenderModule select="builtins/html" />
<RenderModule select="builtins/canvas" />
<RenderModule select="client/ui-layers" />

## Persistence

Server-only key-value stores.

<RenderModule select="api/storage" />

## Multiplayer & rooms

RPC, matchmaking, room management, and chat.

<RenderModule select="api/rpc" />
<RenderModule select="api/matchmaking" />
<RenderModule select="api/rooms" />
<RenderModule select="api/chat" />
<RenderModule select="api/client" />
<RenderModule select="api/clients" />
