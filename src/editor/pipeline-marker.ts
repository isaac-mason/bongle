// Pipeline-page marker — set by `__kit.pipeline()` before
// `EngineClient.load()` to declare this page as the kit's icon-producer.
// `loadEditorAssets()` in editor/index.ts reads it to short-circuit its
// boot-time fetch (the pipeline-page produces the icons it would otherwise
// race to fetch).
//
// Kept in its own module so `bongle/internal` → `__kit.ts` can wire
// `__kit.pipeline` without dragging the full editor module (and the client
// UI graph it pulls in via editor/index.ts → client/rooms → client/ui/ui →
// editor.css) into the gameServer env's bundle.

let isPipelinePage = false;

export function markPipelinePage(): void {
    isPipelinePage = true;
}

export function isPipelinePageMarked(): boolean {
    return isPipelinePage;
}
