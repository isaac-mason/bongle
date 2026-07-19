// editor/ui/fuzzy.ts — subsequence fuzzy scorer shared by the file palette
// (QuickOpen) and the command palette (CommandPalette).

/** subsequence fuzzy score, or null when `q` isn't a subsequence of `text`.
 *  Rewards contiguous runs and matches at word boundaries (start / after a
 *  separator), so `ecs` ranks `engine-client.ts` above an incidental scatter.
 *  `q` must already be lowercased. */
export function fuzzyScore(q: string, text: string): number | null {
    const t = text.toLowerCase();
    let qi = 0;
    let score = 0;
    let streak = 0;
    let prev = -2;
    for (let i = 0; i < t.length && qi < q.length; i++) {
        if (t[i] !== q[qi]) continue;
        streak = prev === i - 1 ? streak + 1 : 0;
        const boundary = i === 0 || /[/._\- ]/.test(text[i - 1]!);
        score += 1 + streak * 2 + (boundary ? 3 : 0);
        prev = i;
        qi++;
    }
    return qi === q.length ? score : null;
}
