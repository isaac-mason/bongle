// returns true when a text input / textarea / contenteditable has focus.
// keyboard shortcuts must not fire in this case.
//
// note: game input is now suppressed at the source (client/input.ts keydown
// handler), so most callsites no longer need this check. it remains available
// for any edge cases where code needs to know about focus state directly.
export function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if ((el as HTMLElement).isContentEditable) return true;
    return false;
}
