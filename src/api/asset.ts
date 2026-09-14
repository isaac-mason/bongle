/** Module-relative reference to a baked asset; pass `import.meta.url` as `base`. */
/*#__NO_SIDE_EFFECTS__*/
export function asset(rel: string, base: string): string {
    return new URL(rel, base).href;
}
