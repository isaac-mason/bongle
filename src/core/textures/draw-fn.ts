/** Scalar param values, string/number/boolean only, so they JSON-serialize cleanly into the registry `structuralHash`. */
export type DrawParams = Record<string, string | number | boolean>;

/** The shape `DrawFn` keys its resolved input images by; only the keys matter here. */
export type DrawInputs = Record<string, unknown>;

export type DrawFn<I extends DrawInputs, P extends DrawParams> = (
    ctx: CanvasRenderingContext2D,
    inputs: { [K in keyof I]: CanvasImageSource },
    params: P,
) => void;
