import type { Renderer } from '../render/backend';
import * as RenderCamera from '../render/camera';
import * as Performance from './performance';
import { useClient } from './ui/stores/client-store';

/** Cached dimensions of the React-mounted `<Viewport>` div. Per-frame consumers
 *  read these instead of `clientWidth`/`clientHeight`, which trigger layout. */
export type Viewport = {
    domElement: HTMLElement | null;
    width: number;
    height: number;
};

export function init(): Viewport {
    return { domElement: null, width: 0, height: 0 };
}

/** Track the React viewport store: seed the current size, then resize the
 *  renderer and rebind the camera aspect whenever it changes. */
export function bindToStore(viewport: Viewport, renderer: Renderer, profile: Performance.Profile): void {
    const apply = (w: number, h: number): void => {
        if (w === 0 || h === 0) return;
        viewport.domElement = useClient.getState().viewportElement;
        viewport.width = w;
        viewport.height = h;
        renderer.resize(w, h, Performance.cappedPixelRatio(profile));
        RenderCamera.bindAspect(renderer.camera, w, h);
    };

    const initial = useClient.getState();
    apply(initial.viewportWidth, initial.viewportHeight);
    let prevW = initial.viewportWidth;
    let prevH = initial.viewportHeight;
    useClient.subscribe((s) => {
        if (s.viewportWidth === prevW && s.viewportHeight === prevH) return;
        prevW = s.viewportWidth;
        prevH = s.viewportHeight;
        apply(s.viewportWidth, s.viewportHeight);
    });
}
