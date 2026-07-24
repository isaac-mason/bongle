/**
 * Static device CAPABILITY probe (resolved once at boot; hardware doesn't change
 * mid-session). The separate question of which input is being used RIGHT NOW —
 * the one that gates pointer lock and touch controls — is the live `inputMode` on
 * the client store (client/ui/client-store), because a single "isTouch" boolean is
 * a category error on hybrids (a touchscreen laptop has a digitizer AND a mouse).
 */

export type DeviceType = 'mouseOnly' | 'touchOnly' | 'hybrid';

export type Device = {
    /** static capability class. `hybrid` = has both a fine pointer and touch
     *  (touchscreen laptop / Surface). Probed from `any-pointer`/`any-hover`, which
     *  query EVERY attached pointer (unlike `(pointer: coarse)`, which reports only
     *  the primary and so can't tell a hybrid from a touch-only tablet). */
    deviceType: DeviceType;
    /** a phone-class device (Client Hints `userAgentData.mobile`, else a UA
     *  regex). viewport-independent, so it holds on a phone even when the page is
     *  rendered desktop-width. drives the compact phone HUD (see `isMobile`). */
    mobile: boolean;
};

export function init(): Device {
    const mobile = detectMobile();
    return { deviceType: detectDeviceType(mobile), mobile };
}

type UADataLike = { mobile?: boolean };

/** a phone-class device. prefers UA Client Hints (`navigator.userAgentData.mobile`,
 *  definitive on Chromium/Android), falling back to a UA regex for Safari/iOS and
 *  older browsers. NOT a viewport check — that misfires on desktop-styled host pages. */
function detectMobile(): boolean {
    if (typeof navigator === 'undefined') return false;
    const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
    if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
    return /Android|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(navigator.userAgent || '');
}

/** classify capability from `any-pointer`/`any-hover` (ALL attached pointers, so a
 *  hybrid is distinguishable from touch-only). `maxTouchPoints`/`mobile` backstop the
 *  coarse signal; a device with no signal at all (SSR, ancient browser) is mouseOnly. */
function detectDeviceType(mobile: boolean): DeviceType {
    const hasFinePointer = matchMediaMatches('(any-pointer: fine)') || matchMediaMatches('(any-hover: hover)');
    const hasTouchPointer =
        (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
        matchMediaMatches('(any-pointer: coarse)') ||
        mobile;
    if (hasFinePointer && hasTouchPointer) return 'hybrid';
    if (hasTouchPointer) return 'touchOnly';
    return 'mouseOnly';
}

function matchMediaMatches(query: string): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}
