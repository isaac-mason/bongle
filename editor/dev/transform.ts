// editor/bundler/transform.ts — the browser wiring of the host-neutral transform.
//
// The transform LOGIC (capture wrapper + TS-strip + module-runner rewrite) lives in
// lib/build (createTransformModule); this only injects the browser oxc/rolldown
// impl. `bongle dev` injects node `rolldown/experimental` the same way. Kept in
// editor/bundler so the @rolldown/browser dependency stays out of the shared core.

import { moduleRunnerTransform, parseSync, transform } from '@rolldown/browser/experimental';
import { createTransformModule, type DepParser, type OxcTransforms } from '../../build';

export const transformModule = createTransformModule({
    transform: transform as unknown as OxcTransforms['transform'],
    moduleRunnerTransform: moduleRunnerTransform as unknown as OxcTransforms['moduleRunnerTransform'],
});

// the capture dep-wrap's parser (browser build) — passed to initDevServer alongside
// the transform, so @rolldown/browser stays out of the shared core.
export const depParser = parseSync as unknown as DepParser;
