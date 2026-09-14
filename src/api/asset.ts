// asset(rel, base) — a module-relative reference to a baked asset file, for the
// `src` of texture / tile / model / sound / sprite. Pass `import.meta.url` as the
// base; the file resolves relative to the CALLING module, so a pack shipped under
// node_modules references its own co-located assets wherever it's installed.
//
// It is deliberately a plain function, NOT `new URL('<literal>', import.meta.url)`:
// that literal form is a bundler asset-emit directive, and for a baked asset
// (which ships inside an atlas/bin, not as a raw file) we'd then have to strip it
// back out. `asset()` sidesteps that — the bundler sees an ordinary call, emits
// nothing, and the pipeline reads the resolved path. Carry-through assets (raw
// files you want shipped + a URL for) use `?url` imports instead.
// Declaring an asset ref is not itself an effect: the pipeline reads the resolved
// path from the registry entry that holds it, so a declaration nothing references
// need not be kept. Without this the whole `tile(id, { src: asset(…) })`
// statement is impure and every kit declaration survives, referenced or not.
/*#__NO_SIDE_EFFECTS__*/
export function asset(rel: string, base: string): string {
    return new URL(rel, base).href;
}
