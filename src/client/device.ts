export type DeviceType = 'mouseOnly' | 'touchOnly' | 'hybrid';

/** Static capability probe, resolved once at boot. Which input is used right now
 *  (gates pointer lock and touch controls) is the live `inputMode` on the client store instead. */
export type Device = {
    /** `hybrid` = has both a fine pointer and touch. Probed from
     *  `any-pointer`/`any-hover`, which query every attached pointer, unlike
     *  `(pointer: coarse)` which reports only the primary. */
    deviceType: DeviceType;
    /** phone-class device, viewport-independent so it holds even when the page
     *  renders desktop-width. Drives the compact phone HUD. */
    mobile: boolean;
};

export function init(): Device {
    const mobile = detectMobile();
    return { deviceType: detectDeviceType(mobile), mobile };
}

type UADataLike = { mobile?: boolean };

/** Prefers UA Client Hints, falling back to a UA regex for Safari/iOS and older
 *  browsers. Not a viewport check, that misfires on desktop-styled host pages. */
function detectMobile(): boolean {
    if (typeof navigator === 'undefined') return false;
    const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
    if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
    return /Android|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(navigator.userAgent || '');
}

/** `maxTouchPoints`/`mobile` backstop the coarse signal; a device with no
 *  signal at all (SSR, ancient browser) is mouseOnly. */
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
