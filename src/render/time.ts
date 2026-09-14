import { d, type UniformNode, uniform } from 'gpucat';

export type TimeResources = {
    /** Elapsed wall-clock seconds uniform, bound by node identity into every time-driven shader graph. */
    elapsedTime: UniformNode<d.f32>;
    /** CPU mirror of `elapsedTime.value`, for non-shader consumers. */
    seconds: number;
};

export function init(): TimeResources {
    const elapsedTime = uniform('elapsedTime', d.f32);
    elapsedTime.value = 0;
    return { elapsedTime, seconds: 0 };
}

/** Advance the shared render clock. Called once per frame before compute/render; static offline renders never call it, leaving time at 0. */
export function tick(time: TimeResources, seconds: number): void {
    time.seconds = seconds;
    time.elapsedTime.value = seconds;
}
