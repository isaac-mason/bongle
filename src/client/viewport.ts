/**
 * Engine-global viewport — cached dimensions of the React-mounted `<Viewport>`
 * div. Updated by the engine-client resize hook so per-frame consumers (e.g.
 * the player controller's touch left/right-half split) never trigger layout
 * via `clientWidth` / `clientHeight`.
 */

export type Viewport = {
    domElement: HTMLElement | null;
    width: number;
    height: number;
};

export function init(): Viewport {
    return { domElement: null, width: 0, height: 0 };
}
