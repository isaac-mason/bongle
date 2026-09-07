// os/boot-marks.ts — console boot marks for a realm, in the shape the editor shell's boot timer
// prints (`[boot:<ctx>] <label>  +<delta>ms  (<total>ms)`), so a realm's phases line up with
// the main document's in one console.

export function bootMarks(ctx: string): (label: string) => void {
    const start = performance.now();
    let prev = start;
    return (label) => {
        const now = performance.now();
        console.log(`[boot:${ctx}] ${label}  +${(now - prev).toFixed(0)}ms  (${(now - start).toFixed(0)}ms)`);
        prev = now;
    };
}
