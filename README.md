![cover](./cover.png)

bongle is a multiplayer voxel game engine built for the web.

it powers [bongle.io](https://bongle.io), and is available here as free open source software.


- 🛠️ built-in editor with client and server hot-module-reload, powered by the vite environments API
- 🎨 asset pipeline for blocks, textures, models, sounds, and sprites
- ⛏️ voxel editing features that should excite WorldEdit fans
- 🌍 an opinionated voxel world, with APIs that give large creative freedom within it
- 🌐 server-authorative multiplayer with distributed entity ownership
- 🔗 "share" functionality powered by cloudflared, so you can playtest with anyone in the world

## Example games

Want a complete game to learn from or remix? These are full multiplayer games built on bongle, each in its own repo so you can fork it and make it your own.

- [bongle-wizard-game](https://github.com/isaac-mason/bongle-wizard-game), a multiplayer wizard arena.

## Engine examples

Smaller, feature-level demos live in [`./examples/`](./examples), each isolating one part of the engine so you can see how it works in a few files. Clone this repo recursively (see below) and run any of them with `npm install && npm run edit`.

- [`audio`](./examples/audio), the script-facing audio API: non-positional one-shots, pitch-shifting, and spatial sources that follow a node.
- [`blocks`](./examples/blocks), defining custom voxel blocks, textures, and presets.
- [`dom-ui`](./examples/dom-ui), in-world UI with the HtmlTrait and CanvasTrait.
- [`persistent-data`](./examples/persistent-data), saving player progress with the storage API.
- [`rooms`](./examples/rooms), multiple scenes and matchmaking across rooms.
- [`sprites`](./examples/sprites), sprite and particle primitives in billboard, y-billboard, and world modes.
- [`terrain`](./examples/terrain), procedural terrain generation.
- [`voxel-model`](./examples/voxel-model), building voxel-model shapes with flood-fill lighting.

The [`performance-*`](./examples) folders are benchmark scenes (chunks, lighting, meshing, physics, terrain) rather than tutorials.

## Getting Started

> NOTE: bongle is in early development and is not yet published to npm. Install directly from this repo:

```sh
npx github:isaac-mason/bongle new my-game
cd my-game
npm run edit
```

Running the above will scaffold a minimal project and start the editor on `http://localhost:3002`.

From there, you can edit the game code in `src/`, and see your changes live in the editor.

If you'd rather poke around without scaffolding, clone this repo and run any of the projects in [`./examples/`](./examples). Clone recursively so the submodules come along:

```sh
git clone --recurse-submodules https://github.com/isaac-mason/bongle.git
cd bongle
```

Already cloned without `--recurse-submodules`? Run `git submodule update --init --recursive`.

### Start from the new-bongle template

[new-bongle](https://github.com/isaac-mason/new-bongle) is a ready-made starter project. Open it in the cloud with one click:

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/isaac-mason/new-bongle)

It boots a container, installs dependencies, and starts the editor (forwarded on `:3002`). You can also clone it and run `npm install && npm run edit` locally.

## Making characters and models

[bongle-blockbench](https://github.com/isaac-mason/bongle-blockbench) is a build of [Blockbench](https://www.blockbench.net/) set up for authoring bongle characters and models. It starts you from the canonical character rig, validates the rig as you work, and exports an engine-ready glTF in one click. Use it online, or install it into the Blockbench desktop app.

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

## Documentation

API documentation is sparse while the engine is in early development, but the [examples](./examples) are a good place to start for brave explorers.

More to come soon!
