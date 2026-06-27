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

## Making characters and models

[bongle-blockbench](https://github.com/isaac-mason/bongle-blockbench) is a build
of [Blockbench](https://www.blockbench.net/) set up for authoring bongle
characters and models. It starts you from the canonical character rig, validates
the rig as you work, and exports an engine-ready glTF in one click. Use it
online, or install it into the Blockbench desktop app.
