import type { DepKey } from '../capture/dep-graph';
import type { DrawFn, DrawInputs, DrawParams } from './draw-fn';

/** A texture from a file: a project-relative path or an `asset()` href. */
export type TextureFileOptions = {
    src: string;
};

/** A texture computed at bake time from other textures. */
export type TextureComputedOptions<I extends Record<string, TextureHandle>, P extends DrawParams> = {
    /** Output canvas dims in pixels. */
    size: [number, number];
    /** Other textures this one is drawn from, keyed by the name `fn` destructures. */
    inputs?: I;
    /** Scalar tweak knobs. Hashed, so a change here invalidates; a value the `fn` closes over instead is invisible to change detection. */
    params?: P;
    /** Drawn at bake time. Sync, and pure with respect to its three arguments. */
    fn: DrawFn<DrawInputs, P>;
};

export type TextureOptions<
    I extends Record<string, TextureHandle> = Record<string, TextureHandle>,
    P extends DrawParams = DrawParams,
> = TextureFileOptions | TextureComputedOptions<I, P>;

/** The declared data for one texture, hashed and swapped wholesale on re-declaration. `inputs` holds `DepKey`s rather than live handles so the def stays plain data. */
export type TextureDef =
    | { id: string; from: 'file'; src: string }
    | {
          id: string;
          from: 'computed';
          size: [number, number];
          inputs: Record<string, DepKey>;
          params: DrawParams;
          fn: DrawFn<DrawInputs, DrawParams>;
      };

/** Stable wrapper around a `TextureDef`; the data is read through `.def`, which is re-pointed on every re-declaration. */
export type TextureHandle = {
    /** The declared id, identity, never changes. */
    readonly id: string;
    readonly dependency: DepKey;
    /** Re-pointed on every re-declaration. */
    def: TextureDef;
};

/** True when the options describe a computed texture rather than a file one. */
export function isComputedOptions<I extends Record<string, TextureHandle>, P extends DrawParams>(
    options: TextureOptions<I, P>,
): options is TextureComputedOptions<I, P> {
    return 'fn' in options;
}

/** The texture ids a computed texture draws from, for `deps`. A file texture has none. */
export function textureInputDeps(def: TextureDef): DepKey[] {
    if (def.from === 'file') return [];
    return Object.values(def.inputs);
}
