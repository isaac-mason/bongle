// time-resources.ts
//
// Engine-global render clock. One wall-clock time source shared by every
// per-frame animation that runs off ./render: voxel block sway, cloud drift,
// editor selection rainbow, and anything future. gpucat no longer ticks time
// itself, so renderer.ts advances this once per frame via tick(); static
// offline renders never tick, leaving it at 0 so all time-driven animation
// freezes (deterministic bakes).
//
// The `elapsedTime` uniform node is threaded by identity into every time-driven
// shader graph (voxel material, editor rainbow) at material-build time; CPU-side
// consumers (cloud drift) read `seconds` off the state.

import { d, type UniformNode, uniform } from 'gpucat';

export type TimeResources = {
    /** elapsed wall-clock seconds uniform. bound by node identity into every
     *  time-driven shader graph. renderGroup: uploaded once per render rather
     *  than per draw. */
    elapsedTime: UniformNode<d.f32>;
    /** CPU mirror of `elapsedTime.value`, for non-shader consumers. */
    seconds: number;
};

export function init(): TimeResources {
    const elapsedTime = uniform('elapsedTime', d.f32);
    elapsedTime.value = 0;
    return { elapsedTime, seconds: 0 };
}

/** Advance the shared render clock to `seconds`. renderer.ts calls this once
 *  per frame before compute/render. */
export function tick(time: TimeResources, seconds: number): void {
    time.seconds = seconds;
    time.elapsedTime.value = seconds;
}
