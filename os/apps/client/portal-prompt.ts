// The editor's answer to an in-game `client.portal(slug)`.
//
// The editor is not a play page, so a portal cannot navigate here without
// throwing away the editing session. It opens the target in a new tab instead,
// which keeps the session and still lets a dev verify the whole flow.
//
// The confirmation is not decoration. `window.open` needs transient activation,
// and a portal call arrives from a game tick, which has none — an unprompted
// open would be silently blocked, and the dev would conclude their code was
// broken. A real button click supplies the activation. It also mirrors the
// production shape (confirm, then go) and gives both branches: Open resolves
// true, Stay resolves false, so the game's "player is leaving" path is
// reachable in the editor at all.
//
// Deliberate difference from production: `true` there means the session is
// over, whereas here the editor keeps running behind the new tab. That is the
// useful lie — watching the teardown branch actually run is the point.

export type MatchmakingOptions = Record<string, string | number | boolean>;

const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_KEYS = 16;
const MAX_VALUE_CHARS = 256;

// `o.` for matchmaking options, `j.` for joinData. `.` sits outside the key
// charset the matchmaking endpoint enforces, so the prefix is unambiguous. The
// new tab is a fresh document and cannot take router state, which is why the
// payload rides the URL here and not in production.
function append(params: URLSearchParams, prefix: string, values: MatchmakingOptions): void {
    let count = 0;
    for (const [key, value] of Object.entries(values)) {
        if (count >= MAX_KEYS) break;
        if (!KEY_PATTERN.test(key)) continue;
        const encoded = String(value);
        // Drop rather than truncate: half a value is worse than none, and the
        // endpoint would reject the request anyway.
        if (encoded.length > MAX_VALUE_CHARS) continue;
        params.set(`${prefix}${key}`, encoded);
        count++;
    }
}

/** `/p/<slug>?o.…&j.…`. Same-origin: the editor is served under the website. */
export function portalUrl(slug: string, options: MatchmakingOptions, joinData: MatchmakingOptions): string {
    const params = new URLSearchParams();
    append(params, 'o.', options);
    append(params, 'j.', joinData);
    const query = params.toString();
    return `/p/${encodeURIComponent(slug)}${query ? `?${query}` : ''}`;
}

/** Ask the developer whether to open `slug`, and open it in a new tab if so.
 *  Resolves what the game should see. Never rejects. */
export function editorPortalPrompt(
    surface: HTMLElement,
    slug: string,
    options: MatchmakingOptions,
    joinData: MatchmakingOptions,
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        // Absolute within the preview surface rather than fixed: covering the
        // whole editor for one preview's dialog would be wrong. Needs a
        // positioned ancestor, and the surface is not guaranteed one.
        if (getComputedStyle(surface).position === 'static') surface.style.position = 'relative';

        const overlay = document.createElement('div');
        overlay.style.cssText = [
            'position:absolute',
            'inset:0',
            'z-index:2147483000',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'background:rgba(0,0,0,0.6)',
            'font:13px/1.4 system-ui,sans-serif',
        ].join(';');

        const card = document.createElement('div');
        card.style.cssText = ['background:#fff', 'color:#000', 'border:1px solid #000', 'padding:12px', 'max-width:320px'].join(
            ';',
        );

        const title = document.createElement('div');
        title.style.cssText = 'font-weight:600;margin-bottom:4px';
        title.textContent = `Play ${slug}?`;

        const body = document.createElement('div');
        body.style.cssText = 'margin-bottom:10px';
        body.textContent = 'The game asked to send you to another project. In the editor it opens in a new tab.';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px';

        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = 'Open';
        open.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #000;background:#000;color:#fff;cursor:pointer';

        const stay = document.createElement('button');
        stay.type = 'button';
        stay.textContent = 'Stay';
        stay.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #000;background:#fff;color:#000;cursor:pointer';

        let settled = false;
        const settle = (ok: boolean) => {
            if (settled) return;
            settled = true;
            overlay.remove();
            resolve(ok);
        };

        // Opened from the click handler, so the activation is still live.
        open.addEventListener('click', () => {
            window.open(portalUrl(slug, options, joinData), '_blank', 'noopener');
            settle(true);
        });
        stay.addEventListener('click', () => settle(false));

        row.append(open, stay);
        card.append(title, body, row);
        overlay.append(card);
        surface.append(overlay);
    });
}
