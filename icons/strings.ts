// Raw inner-SVG markup for the icon set, split out so both consumers share one
// source: ./index wraps each into a React component, and non-React code (the
// engine's touch-button HUD, built via innerHTML in touch-controls.ts) imports
// the string directly, without pulling React into the engine runtime.
//
// The glyphs are pixel art on a 24x24 grid: solid axis-aligned rects filled with
// currentColor, no strokes and no curves, so they sit on whole pixels and match
// the chunky look the rest of the product renders with. The markup is vendored
// from pixelarticons (MIT, see ./PIXELARTICONS-LICENSE.txt); the export names are
// the ones the editors already import, so a few of them name the nearest pixel
// glyph rather than an exact match for the old outline icon.
//
// To add an icon: pick one from pixelarticons.com, paste its inner markup here
// (everything between <svg ...> and </svg>) and add the matching createIcon()
// line in ./index.

export const activity =
    '<path d="M22 22H4v-2h18v2ZM4 20H2V2h2v18Zm4-6H6v-2h2v2Zm8 0h-2v-2h2v2Zm-6-2H8v-2h2v2Zm4 0h-2v-2h2v2Zm4 0h-2v-2h2v2Zm-6-2h-2V8h2v2Zm8 0h-2V8h2v2Zm2-2h-2V6h2v2Z"/>';
export const alertCircle = '<path d="M4 2h16v2H4zm0 18h16v2H4zM20 4h2v16h-2zM2 4h2v16H2zm9 2h2v8h-2zm0 10h2v2h-2z"/>';
export const arrowRightLeft =
    '<path d="M13 13v-2h10v2zm6 2v-2h2v2zm-2 2v-2h2v2zm2-6V9h2v2z"/><path d="M17 15V7h2v8zm-6-2v-2H1v2zm-6 2v-2H3v2zm2 2v-2H5v2zm-2-6V9H3v2z"/><path d="M7 15V7H5v8z"/>';
export const arrowUp =
    '<path d="M11 20h2V4h-2zm2-12h2V6h-2zm2 2h2V8h-2zm2 2h2v-2h-2zm-6-4H9V6h2z"/><path d="M15 10H7V8h8zm2 2H5v-2h12z"/>';
export const article =
    '<path d="M8 2h12v2H8zM6 4h2v16H6zm14 0h2v16h-2zM4 20h16v2H4zm-2-9h2v9H2zm2-2h2v2H4zm6-3h8v2h-8zm0 4h8v2h-8zm0-2h2v2h-2zm6 0h2v2h-2zm-6 5h8v2h-8zm0 3h4v2h-4z"/>';
export const bookmarkPlus =
    '<path d="M6 2h12v2H6zM4 4h2v18H4zm14 0h2v18h-2zm-2 16h2v2h-2zm-2-2h2v2h-2zm-8 2h2v2H6zm2-2h2v2H8zm2-2h4v2h-4z"/>';
export const box =
    '<path d="M14 4h4v2h-4zm-4-2h4v2h-4zM6 8h4v2H6zm0 10h4v2H6zm4-8h4v2h-4zm0 10h4v2h-4zm4-12h4v2h-4zm0 10h4v2h-4zM6 4h4v2H6zM2 6h4v2H2zm0 10h4v2H2zM18 6h4v2h-4zm0 10h4v2h-4z"/><path d="M2 6h2v12H2zm18 0h2v12h-2zm-8 6h2v8h-2z"/>';
export const boxSelect = '<path d="M7 5h10V2h2v3h3v2h-3v10h3v2h-3v3h-2v-3H7v3H5v-3H2v-2h3V7H2V5h3V2h2v3Zm0 12h10V7H7v10Z"/>';
export const check =
    '<path d="M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z"/>';
export const chevronDown =
    '<path d="M13 16h-2v-2h2v2Zm-2-2H9v-2h2v2Zm4 0h-2v-2h2v2Zm-6-2H7v-2h2v2Zm8 0h-2v-2h2v2ZM7 10H5V8h2v2Zm12 0h-2V8h2v2Z"/>';
export const chevronRight =
    '<path d="M16 13v-2h-2v2h2Zm-2-2V9h-2v2h2Zm0 4v-2h-2v2h2Zm-2-6V7h-2v2h2Zm0 8v-2h-2v2h2ZM10 7V5H8v2h2Zm0 12v-2H8v2h2Z"/>';
export const clipboardCopy =
    '<path d="M4 6h2v14H4zm2 14h12v2H6zM18 6h2v14h-2zM6 4h2v2H6zm10 0h2v2h-2zm-6-2h4v2h-4zm0 4h4v2h-4zM8 2h2v6H8zm6 0h2v6h-2z"/>';
export const code =
    '<path d="M11 18H9v-4h2v4Zm-4-1H5v-2h2v2Zm12-2v2h-2v-2h2ZM5 15H3v-2h2v2Zm16 0h-2v-2h2v2Zm-8-1h-2v-4h2v4ZM3 13H1v-2h2v2Zm20 0h-2v-2h2v2ZM5 11H3V9h2v2Zm16 0h-2V9h2v2Zm-6-1h-2V6h2v4ZM7 9H5V7h2v2Zm12 0h-2V7h2v2Z"/>';
export const copy =
    '<path d="M8 6h12v2H8zM4 2h12v2H4zm2 6h2v12H6zM2 4h2v12H2zm6 16h12v2H8zM20 8h2v12h-2zm-4-4h2v2h-2zM4 16h2v2H4z"/>';
export const crosshair =
    '<path d="M5 1h14v2H5zM3 3h2v2H3zm0 16h2v2H3zm16 0h2v2h-2zm0-16h2v2h-2zm2 2h2v14h-2zM5 21h14v2H5zM1 5h2v14H1zm8 0h6v2H9zM5 9h2v6H5zm4 8h6v2H9zm8-8h2v6h-2zm-6 0h2v2h-2zM7 7h2v2H7zm0 8h2v2H7zm8 0h2v2h-2zm0-8h2v2h-2zm-6 4h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2z"/>';
export const debug =
    '<path d="M8 6h8v2H8zm0 14h8v2H8zM6 8h2v12H6zm10 0h2v12h-2zM4 8h2v2H4zm16 0h-2v2h2zM4 18h2v2H4zm16 0h-2v2h2zM2 20h2v2H2zm20 0h-2v2h2zM2 6h2v2H2zm20 0h-2v2h2zM2 13h4v2H2zm20 0h-4v2h4zM6 2h2v2H6zm2 2h2v2H8zm6 0h2v2h-2zm2-2h2v2h-2zm-6 8h4v2h-4zm0 4h4v2h-4z"/>';
export const download =
    '<path d="M21 15v4h-2v-4zm-2 4v2H5v-2zM5 15v4H3v-4zm8-12v14h-2V3z"/><path d="M7 11v2h10v-2zm2 2v2h2v-2zm4 0v2h2v-2z"/><path d="M15 11v2h2v-2z"/>';
export const drone =
    '<path d="M2 8h2v8H2zm2 4h2v2H4zm2-4h2v8H6zm2-2h10v2H8zm10 2h2v2h-2zm2 2h2v6h-2zM8 16h12v2H8zm2 2h2v2h-2zm6 0h2v2h-2zM6 20h16v2H6zM4 2h18v2H4z"/><path d="M12 4h2v8h-2zm2 8h6v2h-6z"/>';
export const eraser =
    '<path d="M15 18h6v2H7v-2h6v-2h2v2Zm-8 0H5v-2h2v2Zm-2-2H3v-2h2v2Zm12 0h-2v-2h2v2ZM7 14H5v-2h2v2Zm8 0h-2v-2h2v2Zm4 0h-2v-2h2v2ZM9 12H7v-2h2v2Zm4 0h-2v-2h2v2Zm8 0h-2v-2h2v2Zm-10-2H9V8h2v2Zm8 0h-2V8h2v2Zm-6-2h-2V6h2v2Zm4 0h-2V6h2v2Zm-2-2h-2V4h2v2Z"/>';
export const eye =
    '<path d="M16 20H8v-2h8v2Zm-8-2H4v-2h4v2Zm12 0h-4v-2h4v2ZM4 16H2v-2h2v2Zm10-6h-2v2h2v-2h2v4h-2v2h-4v-2H8v-4h2V8h4v2Zm8 6h-2v-2h2v2ZM2 14H0v-4h2v4Zm22 0h-2v-4h2v4ZM4 10H2V8h2v2Zm18 0h-2V8h2v2ZM8 8H4V6h4v2Zm12 0h-4V6h4v2Zm-4-2H8V4h8v2Z"/>';
export const file =
    '<path d="M6 4H4v16h2zm10-2H6v2h10zm4 4h-2v14h2zm-2 14H6v2h12zM16 4h2v2h-2zm-4 0h2v6h-2z"/><path d="M12 8h6v2h-6z"/>';
export const files =
    '<path d="M9 3H7v14h2zM5 7H3v14h2zm12-6H9v2h8zm4 4h-2v12h2zm-2 12H9v2h10zm-4 4H5v2h10zm2-18h2v2h-2zm-4 0h2v6h-2z"/><path d="M13 7h6v2h-6zM5 5h2v2H5zm10 14h2v2h-2z"/>';
export const focus =
    '<path d="M9 5h6v2H9zM7 7h2v2H7zm0 8h2v2H7zm8 0h2v2h-2zm0-8h2v2h-2zm2 2h2v6h-2zm-8 8h6v2H9zM5 9h2v6H5zm14 2h4v2h-4zM1 11h4v2H1zM11 1h2v4h-2zm0 18h2v4h-2z"/>';
export const folderInput =
    '<path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-9 12h2v2h-2zm0-10h2v6h-2zm-2 8h6v2H9zm-2-2h10v2H7z"/>';
export const folderOutput =
    '<path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-8.933 4.009h2v-2h-2zm0 10h2v-6h-2zm-2-8h6v-2h-6zm-2 2h10v-2h-10z"/>';
export const folderSync =
    '<path d="M16 4h2v6h-2zm-2-2h2v2h-2zm0 2h2v8h-2zM4 8H2v5h2z"/><path d="M4 6h16v2H4zm4 14H6v-6h2zm2 2H8v-2h2zm0-2H8v-8h2zm10-4h2v-5h-2z"/><path d="M20 18H4v-2h16z"/>';
export const folderTree = '<path d="M4 4h6v2H4zm0 14h16v2H4zM20 8h2v10h-2zM2 6h2v12H2zm8 0h10v2H10z"/>';
export const footprints = '<path d="M10 2h4v4h-4zM3 7h18v2H3zm6 2h2v7H9zm4 0h2v7h-2zm-4 7h2v6H9zm4 0h2v6h-2zm-2-2h2v2h-2z"/>';
export const grab =
    '<path d="M21 7h2v5h-2zm-4-2h2v7h-2zm-4-2h2v8h-2zM9 3h2v8H9zM5 5h2v8H5zm14 0h2v2h-2zm-4-2h2v2h-2zm-4-2h2v2h-2zM7 3h2v2H7zm-4 8h2v2H3zm-2 2h2v2H1zm0 2h2v2H1zm2 2h2v2H3zm2 2h2v2H5zm2 2h12v2H7zm12-2h2v2h-2zm2-7h2v7h-2zM5 13h2v2H5zm2 2h2v2H7z"/>';
export const grid3x3 =
    '<path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM4 8h16v2H4zm0 6h16v2H4z"/><path d="M8 4h2v16H8zm6 0h2v16h-2z"/>';
export const gripVertical =
    '<path d="M15 3v2h-2V3zm0 8v2h-2v-2zm0 8v2h-2v-2zM13 1v2h-2V1zm0 8v2h-2V9zm0 8v2h-2v-2zM11 3v2H9V3zm0 8v2H9v-2zm0 8v2H9v-2zm2-14v2h-2V5zm0 8v2h-2v-2zm0 8v2h-2v-2z"/>';
export const hammer =
    '<path d="M9 22H7v-2h2v2Zm12-6h2v6h-6v-6h2v-6h2v6Zm-2 2v2h2v-2h-2ZM7 20H5v-8h2v8Zm4 0H9v-8h2v8Zm-6-8H3v-2h2v2Zm8 0h-2v-2h2v2ZM3 10H1V4h2v6Zm12 0h-2V4h2v6Zm4 0h-2V4h2v6Zm4 0h-2V4h2v6ZM7 6h2V2h4v2h-2v4H5V4H3V2h4v4Zm14-2h-2V2h2v2Z"/>';
export const image =
    '<path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-4 8h2v2h-2zm-2 2h2v2h-2zm4 0h2v2h-2zm-8 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/><path d="M20 16h2v2h-2zM8 16h2v2H8zm-2 2h2v2H6zM8 6h2v2H8zM6 8h2v2H6zm2 2h2v2H8zm2-2h2v2h-2z"/>';
export const lasso =
    '<path d="M4 12h2v2H4zm-2 2h2v2H2zm2 2h2v4H4zm2-2h4v2H6zm0 6h2v2H6zm4-4h4v2h-4zm0-14h4v2h-4zm4 12h4v2h-4zm4-2h2v2h-2zm0-6h2v2h-2zM6 4h4v2H6zM4 6h2v2H4zm10-2h4v2h-4zm6 4h2v4h-2zM2 8h2v4H2z"/>';
export const lassoSelect =
    '<path d="M12 10h2v12h-2zm2 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-6 4h2v2h-2zm2-2h6v2h-6zM2 16h2v4H2zm2 4h2v2H4zm4 0h2v2H8zM2 10h2v4H2zm0-6h2v4H2zm2-2h2v2H4zm4 0h4v2H8zm6 0h4v2h-4zm6 2h2v4h-2zm0 6h2v2h-2z"/>';
export const layers =
    '<path d="M15 1h6v2h-6zm-2 2h2v6h-2zm2 6h6v2h-6zm6-6h2v6h-2zM3 5h6v2H3zM1 7h2v14H1zm2 14h14v2H3zm14-6h2v6h-2zM3 13h14v2H3z"/><path d="M9 7h2v14H9z"/>';
export const loader2 =
    '<path d="M13 22h-2v-6h2v6Zm-6-3H5v-2h2v2Zm12 0h-2v-2h2v2ZM9 17H7v-2h2v2Zm8 0h-2v-2h2v2Zm-9-4H2v-2h6v2Zm14 0h-6v-2h6v2ZM9 9H7V7h2v2Zm8 0h-2V7h2v2Zm-4-1h-2V2h2v6ZM7 7H5V5h2v2Zm12 0h-2V5h2v2Z"/>';
export const lock = '<path d="M5 8h14v2H5zm0 12h14v2H5zM3 10h2v10H3zm16 0h2v10h-2zM7 4h2v4H7zm2-2h6v2H9zm6 2h2v4h-2z"/>';
export const logs =
    '<path d="M4 2h16v2H4zm2 5h2v2H6zm4 0h8v2h-8zm-4 4h2v2H6zm4 0h8v2h-8zm-4 4h2v2H6zm4 0h8v2h-8zm-6 5h16v2H4zM2 4h2v16H2zm18 0h2v16h-2z"/>';
export const maximize2 =
    '<path d="M4 13h16v-2H4zm7-8h2V3h-2zM9 7h4V5H9zm4 0h2V5h-2zm2 2h2V7h-2zM7 9h8V7H7zm4 10h2v2h-2zm-2-2h4v2H9zm4 0h2v2h-2zm2-2h2v2h-2zm-8 0h8v2H7z"/>';
export const messageSquare = '<path d="M20 2H4v2h16zm0 14H6v2h14zm2-12h-2v12h2zM4 4H2v18h2zm2 14H4v2h2z"/>';
export const minimize2 = '<path d="M7 19h2v-2h2v-2h2v2h2v2h2v2H7v-2Zm13-6H4v-2h16v2Zm-3-8h-2v2h-2v2h-2V7H9V5H7V3h10v2Z"/>';
export const minus = '<path d="M4 11h16v2H4z"/>';
export const monitorPlay =
    '<path d="M4 3h16v2H4zm0 6h16v2H4zM2 5h2v14H2zm18 0h2v14h-2zM4 19h16v2H4zM18 7h-2v2h2zm-8 0H8v2h2zm6-2h-2v2h2zM8 5H6v2h2z"/>';
export const mousePointer2 =
    '<path d="M6 4h2v16H6zm2 0h2v2H8zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-8 6h2v2H8zm2-2h2v2h-2zm2-2h6v2h-6z"/>';
export const move =
    '<path d="M13 2h2v2h2v2h-4v5h5V7h2v2h2v2h2v2h-2v2h-2v2h-2v-4h-5v5h4v2h-2v2h-2v2h-2v-2H9v-2H7v-2h4v-5H6v4H4v-2H2v-2H0v-2h2V9h2V7h2v4h5V6H7V4h2V2h2V0h2v2Z"/>';
export const music =
    '<path d="M4 12h4v2H4zm-2 2h2v4H2zm2 4h4v2H4zM8 6h2v12H8zm10 0h2v12h-2zm-6 8h2v4h-2zm2-2h4v2h-4zm0 6h4v2h-4zM10 4h8v2h-8z"/>';
export const orbit =
    '<path d="M6 2h12v2H6zm0 18h12v2H6zM4 4h2v2H4zm5 0h2v2H9zm0 14h2v2H9zm4 0h2v2h-2zM7 6h2v12H7zm8 0h2v12h-2zm-2-2h2v2h-2zm7 0h-2v2h2zM2 6h2v12H2zm20 0h-2v12h2zM4 18h2v2H4zm16 0h-2v2h2z"/><path d="M3 11h18v2H3z"/>';
export const paintbrush =
    '<path d="M7 2h10v2H7zM5 4h2v10H5zm12-2h2v12h-2z"/><path d="M13 2h2v6h-2zM9 2h2v4H9zm-4 8h14v2H5zm2 4h10v2H7zm2 2h2v4H9zm4 0h2v4h-2zm-4 4h6v2H9z"/>';
export const paintBucket =
    '<path d="M14 2h6v2h-6zm0 18h6v2h-6zM4 20h10v2H4zm8-16h2v16h-2zm8 0h2v16h-2zM2 16h2v4H2zm2-2h8v2H4zm12 2h2v2h-2zM6 12h2v2H6zM4 8h2v4H4zm2-2h4v2H6zm4 2h2v2h-2z"/>';
export const pause = '<path d="M10 20H4V4h6v16Zm8-16v16h-6V4h6Zm-4 2v12h2V6h-2ZM6 18h2V6H6v12Z"/>';
export const pencil =
    '<path d="M4 16H6V18H8V20H10V22H2V14H4V16ZM12 20H10V18H12V20ZM14 18H12V16H14V18ZM10 16H8V14H10V16ZM16 16H14V14H16V16ZM6 14H4V12H6V14ZM12 14H10V12H12V14ZM18 14H16V12H18V14ZM8 12H6V10H8V12ZM14 12H12V10H14V12ZM20 12H18V10H20V12ZM10 10H8V8H10V10ZM18 10H16V8H18V10ZM22 10H20V8H22V10ZM12 8H10V6H12V8ZM16 8H14V6H16V8ZM20 8H18V6H20V8ZM14 6H12V4H14V6ZM18 6H16V4H18V6ZM16 4H14V2H16V4Z"/>';
export const personStanding =
    '<path d="M9 2h6v2H9zm0 8h6v2H9zm6-6h2v6h-2zM7 4h2v6H7zM4 18h2v4H4zm14 0h2v4h-2zM8 14h8v2H8zm-2 2h2v2H6zm10 0h2v2h-2z"/>';
export const pipette =
    '<path d="M3 15h2v4H3zm2 4h4v2H5zm0-6h2v2H5zm4 4h2v2H9zm-2-6h2v2H7zm4 4h2v2h-2zM9 9h2v2H9zm4 4h2v2h-2zm-2-6h2v2h-2zM9 5h2v2H9zm2-2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm-4-4h2v2h-2zm2 2h2v2h-2zM1 19h2v4H1z"/><path d="M1 21h4v2H1z"/>';
export const play =
    '<path d="M15 11h-2V9h2zm0 4h-2v-2h2zm-2 2h-2v-2h2zm0-8h-2V7h2zm-2-2H9V5h2zM9 21H7V3h2zm6-8h2v-2h-2zm-6 4h2v2H9z"/>';
export const plus = '<path d="M13 11h7v2h-7v7h-2v-7H4v-2h7V4h2v7Z"/>';
export const refreshCw =
    '<path d="M13 20H9V18H13V20ZM19 16H21V18H19V20H17V18H15V16H17V8H19V16ZM9 18H7V16H9V18ZM7 6H9V8H7V16H5V8H3V6H5V4H7V6ZM15 16H13V14H15V16ZM23 16H21V14H23V16ZM3 10H1V8H3V10ZM11 10H9V8H11V10ZM17 8H15V6H17V8ZM15 6H11V4H15V6Z"/>';
export const repeat =
    '<path d="M17 5h2v2h-2zM5 17h2v2H5zm6-14h2v6h-2zM9 1h2v8H9zm0 8h2v2H9zm10 8H9v2h10zM5 7H3v10h2z"/><path d="M13 15h-2v6h2zm2-2h-2v8h2zm0 8h-2v2h2zM5 5h10v2H5zm14 12h2V7h-2z"/>';
export const replace =
    '<path d="M5 21H3v-2h2v2Zm16 0h-6v-2h2v-2h2v-2h2v6ZM7 19H5v-2h2v2Zm2-2H7v-2h2v2Zm8 0h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-2-2H9V9h2v2Zm4 0h-2V9h2v2ZM9 9H7V7h2v2Zm8 0h-2V7h2v2Zm4-6v6h-2V7h-2V5h-2V3h6ZM7 7H5V5h2v2ZM5 5H3V3h2v2Z"/>';
export const rotateCw = '<path d="M20 8H6v2h14zM4 10h2v8H4zm2 8h6v2H6z"/><path d="M18 6h-2v6h2zm-2-2h-2v8h2zm0 8h-2v2h2z"/>';
export const save =
    '<path d="M20 22H4V20H6V14H8V20H16V14H18V20H20V22ZM4 20H2V4H4V20ZM22 20H20V6H22V20ZM16 14H8V12H16V14ZM12 10H6V6H12V10ZM20 6H18V4H20V6ZM18 4H4V2H18V4Z"/>';
export const scalingIcon =
    '<path d="M13 9h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v8h-2z"/><path d="M13 3h8v2h-8zm-2 12H9v-2h2zm-2 2H7v-2h2zm-2 2H5v-2h2zm-2 2H3v-8h2z"/><path d="M11 21H3v-2h8z"/>';
export const scissors =
    '<path d="M5 2h4v2H5zm0 12h4v2H5zm0-6h4v2H5zm0 12h4v2H5zM3 4h2v4H3zm0 12h2v4H3zM9 4h2v4H9zm0 12h2v4H9zm0-8h2v2H9zm2 2h2v2h-2zm-2 4h2v2H9zm2-2h2v2h-2zm2-2h2v2h-2zm2 4h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM15 8h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2z"/>';
export const search =
    '<path d="M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm14 0h-2V6h2v8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z"/>';
export const send =
    '<path d="M4 19h4v2H2v-8h2v6Zm8 0H8v-2h4v2Zm4-2h-4v-2h4v2Zm4-2h-4v-2h4v2Zm-10-2H4v-2h6v2Zm12 0h-2v-2h2v2ZM8 5H4v6H2V3h6v2Zm12 6h-4V9h4v2Zm-4-2h-4V7h4v2Zm-4-2H8V5h4v2Z"/>';
export const server = '<path d="M6 7h4v2H6zm0 8h4v2H6zM2 5h2v14H2zm18 0h2v14h-2zM4 19h16v2H4zM4 3h16v2H4zm0 8h16v2H4z"/>';
export const shoppingBag =
    '<path d="M3 6h18v2H3zm2 14h14v2H5zM3 8h2v12H3zm16 0h2v12h-2z"/><path d="M7 4h2v6H7zm2-2h6v2H9zm6 2h2v6h-2z"/>';
export const shuffle =
    '<path d="M10 19H2v-2h8v2Zm12 0h-8v-2h8v2Zm-10-2h-2v-6h2v6Zm6-10h2v2h2v2h-2v2h-2v2h-2v-4h-4V9h4V5h2v2ZM8 11H2V9h6v2Z"/>';
export const square = '<path d="M2 4h2v16H2zm2 16h16v2H4zM20 4h2v16h-2zM4 2h16v2H4z"/>';
export const tags =
    '<path d="M16 22h-4v-2h4v2Zm-4-2h-2v-2h2v2Zm6 0h-2v-2h2v2Zm-8-2H8v-2h2v2Zm10 0h-2v-2h2v2ZM8 16H6v-2h2v2Zm14 0h-2v-4h2v4ZM6 14H4v-2h2v2Zm-2-2H2V4h2v8Zm16 0h-2v-2h2v2Zm-2-2h-2V8h2v2ZM8 8H6V6h2v2Zm8 0h-2V6h2v2Zm-2-2h-2V4h2v2Zm-2-2H4V2h8v2Z"/>';
export const trash2 = '<path d="M18 22H6V20H18V22ZM9 6H15V4H17V6H22V8H20V20H18V8H6V20H4V8H2V6H7V4H9V6ZM15 4H9V2H15V4Z"/>';
export const triangleAlert =
    '<path d="M2 10h2v2H2zm0 4h2v-2H2zm20-4h-2v2h2zm0 4h-2v-2h2zM4 8h2v2H4zm0 8h2v-2H4zm16-8h-2v2h2zm0 8h-2v-2h2zM6 6h2v2H6zm0 12h2v-2H6zM18 6h-2v2h2zm0 12h-2v-2h2zM8 4h2v2H8zm0 16h2v-2H8zm8-16h-2v2h2zm0 16h-2v-2h2zM10 2h2v2h-2zm0 20h2v-2h-2zm4-20h-2v2h2zm0 20h-2v-2h2zm-3-5h2v-2h-2zm0-4h2V7h-2z"/>';
export const undo2 = '<path d="M18 20h-6v-2h6v2Zm2-2h-2v-8h2v8Zm-10-4H8v-2H6v-2H4V8h2V6h2V4h2v4h8v2h-8v4Z"/>';
export const upload = '<path d="M19 21H5v-2h14v2ZM5 19H3v-4h2v4Zm16 0h-2v-4h2v4ZM13 5h2v2h2v2h-4v8h-2V9H7V7h2V5h2V3h2v2Z"/>';
export const volume2 =
    '<path d="M13 22h-2v-2H9v-2h2V6H9V4h2V2h2v20Zm-4-4H7v-2h2v2Zm10 0h-4v-2h4v2ZM7 10H5v4h2v2H3V8h4v2Zm14 6h-2V8h2v8Zm-4-2h-2v-4h2v4ZM9 8H7V6h2v2Zm10 0h-4V6h4v2Z"/>';
export const wandSparkles =
    '<path d="M14 22H12V20H14V22ZM20 22H18V20H20V22ZM5 19H9V21H3V15H5V19ZM18 20H16V18H18V20ZM22 20H20V18H22V20ZM11 19H9V16H11V19ZM20 18H18V16H20V18ZM13 16H11V13H13V16ZM8 15H5V13H8V15ZM11 13H8V11H11V13ZM15 13H13V11H15V13ZM21 13H19V11H21V13ZM4 12H2V10H4V12ZM13 11H11V9H13V11ZM17 11H15V9H17V11ZM15 9H13V7H15V9ZM19 9H17V7H19V9ZM6 8H4V6H6V8ZM17 7H15V5H17V7ZM21 7H19V5H17V3H21V7ZM4 6H2V4H4V6ZM8 6H6V4H8V6ZM13 5H11V3H13V5ZM6 4H4V2H6V4Z"/>';
export const waves =
    '<path d="M2 18h4v-2H2zm0-6h4v-2H2zm0-6h4V4H2zm4 14h4v-2H6zm0-6h4v-2H6zm0-6h4V6H6zm4 10h4v-2h-4zm0-6h4v-2h-4zm0-6h4V4h-4zm4 14h4v-2h-4zm0-6h4v-2h-4zm0-6h4V6h-4zm4 10h4v-2h-4zm0-6h4v-2h-4zm0-6h4V4h-4z"/>';
export const wavesUp =
    '<path d="M2 21h4v-2H2zm0-6h4v-2H2zm4 8h4v-2H6zm0-6h4v-2H6zm4 4h4v-2h-4zm4 2h4v-2h-4zm0-6h4v-2h-4zm-4-2h4v-2h-4zm8 6h4v-2h-4zm0-6h4v-2h-4zm-7-4h2V1h-2z"/><path d="M9 5h6V3H9zM7 7h10V5H7z"/>';
export const wrench =
    '<path d="M18 22H13V24H11V22H6V20H18V22ZM4 22H2V20H4V22ZM22 22H20V20H22V22ZM6 20H4V18H6V20ZM20 20H18V18H20V20ZM4 18H2V13H0V11H2V6H4V18ZM8 18H6V16H8V18ZM22 11H24V13H22V18H20V13H16V16H8V8H16V11H20V6H22V11ZM10 10V14H14V10H10ZM8 8H6V6H8V8ZM6 6H4V4H6V6ZM20 6H18V4H20V6ZM4 4H2V2H4V4ZM13 2H18V4H6V2H11V0H13V2ZM22 4H20V2H22V4Z"/>';
export const x =
    '<path d="M7 19H5V17H7V19ZM19 19H17V17H19V19ZM9 15V17H7V15H9ZM17 17H15V15H17V17ZM11 15H9V13H11V15ZM15 15H13V13H15V15ZM13 13H11V11H13V13ZM11 11H9V9H11V11ZM15 11H13V9H15V11ZM9 9H7V7H9V9ZM17 9H15V7H17V9ZM7 7H5V5H7V7ZM19 7H17V5H19V7Z"/>';
export const zoomIn =
    '<path d="M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm7-5h3v2h-3v3H9v-3H6V9h3V6h2v3Zm7 5h-2V6h2v8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z"/>';
export const zoomOut =
    '<path d="M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm14 0h-2V6h2v8Zm-4-5v2H6V9h8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z"/>';
