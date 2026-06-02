![cover](./cover.png)

bongle is a multiplayer voxel game engine built for the web.

it powers [bongle.io](https://bongle.io), and is available here as free open source software.


- 🛠️ built-in editor with client and server hot-module-reload, powered by the vite environments API
- 🎨 asset pipeline for blocks, textures, models, sounds, and sprites
- ⛏️ voxel editing features that should excite WorldEdit fans
- 🌍 an opinionated voxel world, with APIs that give large creative freedom within it
- 🌐 server-authorative multiplayer with distributed entity ownership
- 🔗 "share" functionality powered by cloudflared, so you can playtest with anyone in the world

## Getting Started

> NOTE: bongle is in early development and is not yet published to npm. Install directly from this repo:

```sh
npx github:isaac-mason/bongle new my-game
cd my-game
npm run edit
```

Running the above will scaffold a minimal project and start the editor on `http://localhost:3002`.

From there, you can edit the game code in `src/`, and see your changes live in the editor.

If you'd rather poke around without scaffolding, clone this repo and run any of the projects in [`./examples/`](./examples).

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
