// Ambient types for the d.ts build program (tsgo -p tsconfig.build.json).
// The engine relies on these globals; without them the emit scope (src +
// interface, no editor/tst) can't resolve node builtins, WebGPU globals, or
// vite's `?worker` / `import.meta` ambients, and whole files drop from the
// declaration output.
/// <reference types="node" />
/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />
