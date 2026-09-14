// dashcat ships one small stylesheet, injected once on first use. everything
// is scoped under `.dashcat` and driven by css custom properties so a consumer
// can retheme by overriding the vars, without touching the rules.
//
// the palette + metrics mirror the makecat editor: dark, monospace, low padding.

const STYLE_ID = 'dashcat-styles';

export const css = /* css */ `
.dashcat {
    /* palette (makecat editor tokens) */
    --dc-desktop: #0e0f12;
    --dc-surface: #17191e;
    --dc-surface-muted: #202329;
    --dc-fg: #e7e8ea;
    --dc-fg-muted: #8b9096;
    --dc-border: #3a3f47;
    --dc-border-subtle: #2a2e35;
    --dc-accent: #2b5fd9;
    --dc-on-accent: #ffffff;
    --dc-fill: #2a4576;
    --dc-danger: #f87171;
    --dc-success: #4ade80;
    --dc-warn: #fbbf24;

    /* metrics */
    --dc-font: ui-monospace, 'Roboto Mono', monospace;
    --dc-size: 11px;
    --dc-size-sm: 10px;
    --dc-radius: 0;
    --dc-row-h: 22px;
    --dc-pad-x: 8px;
    --dc-pad-y: 2px;
    --dc-gap: 4px;

    font-family: var(--dc-font);
    font-size: var(--dc-size);
    color: var(--dc-fg);
    line-height: 1.4;
    box-sizing: border-box;
}
.dashcat *, .dashcat *::before, .dashcat *::after { box-sizing: border-box; }

/* defensive reset — everything is scoped under .dashcat, and our component
   rules (class selectors, specificity 0,1,0) already beat a host page's bare
   element selectors (0,0,1). this only pins the inherited + commonly-clobbered
   properties that would otherwise leak in from a page reset / css framework,
   without touching native rendering (checkbox / range / color stay themselves). */
.dashcat {
    font-weight: 400;
    font-style: normal;
    letter-spacing: normal;
    text-transform: none;
    text-align: left;
    text-shadow: none;
}
.dashcat button,
.dashcat input,
.dashcat select,
.dashcat textarea {
    font: inherit;
    color: inherit;
    letter-spacing: inherit;
    text-transform: none;
    text-align: left;
    margin: 0;
    box-shadow: none;
    box-sizing: border-box;
}

/* ---- panel layer -------------------------------------------------- */
/* a full-cover layer that passes clicks through, except over its panels/popovers */
.dashcat.dc-layer { position: fixed; inset: 0; z-index: 1000; pointer-events: none; }
.dashcat.dc-layer--target { position: absolute; }
.dc-layer > * { pointer-events: auto; }

/* ---- floating panel ---------------------------------------------- */
.dc-panel {
    position: absolute;
    width: min(320px, calc(100vw - 24px));
    max-height: calc(100vh - 24px);
    display: flex;
    flex-direction: column;
    background: var(--dc-surface);
    border: 1px solid var(--dc-border);
    border-radius: var(--dc-radius);
    box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.4);
    user-select: none;
    overflow: hidden;
}
.dc-panel-title {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    padding: 4px 6px 4px var(--dc-pad-x);
    background: var(--dc-desktop);
    border-bottom: 1px solid var(--dc-border);
    cursor: grab;
}
.dc-panel-title:active { cursor: grabbing; }
.dc-panel-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--dc-size-sm); color: var(--dc-fg); text-transform: lowercase; letter-spacing: 0.02em; }
.dc-panel-collapse, .dc-panel-close { flex: 0 0 auto; background: transparent; border: none; color: var(--dc-fg-muted); cursor: pointer; padding: 0 4px; font-size: 10px; }
.dc-panel-collapse:hover { color: var(--dc-fg); }
.dc-panel-close:hover { color: var(--dc-danger); }
.dc-panel--collapsed > .dc-content, .dc-panel--collapsed .dc-tabs-region { display: none; }
.dc-panel--collapsed > .dc-panel-resize { display: none; }
/* resize grip in the bottom-right corner */
.dc-panel-resize { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 2; }
.dc-panel-resize::after { content: ''; position: absolute; right: 3px; bottom: 3px; width: 6px; height: 6px; border-right: 2px solid var(--dc-border); border-bottom: 2px solid var(--dc-border); }

/* ---- tabs() region ------------------------------------------------ */
.dc-tabs-region { display: flex; flex-direction: column; }
.dc-tabs-content, .dc-tab-panel { display: flex; flex-direction: column; }
.dc-tabstrip {
    display: flex;
    flex: 0 0 auto;
    align-items: stretch;
    background: var(--dc-desktop);
    border-bottom: 1px solid var(--dc-border);
    overflow: hidden;
    /* stay visible when the tab's content scrolls the panel body */
    position: sticky;
    top: 0;
    z-index: 1;
}
/* the tabs scroll between the fixed grip (left) and collapse chevron (right) */
.dc-tabs {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    align-items: stretch;
    overflow-x: auto;
    scrollbar-width: none;
}
.dc-tabs::-webkit-scrollbar { display: none; }
.dc-tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font-size: var(--dc-size-sm);
    text-transform: lowercase;
    letter-spacing: 0.02em;
    color: var(--dc-fg-muted);
    background: transparent;
    border: none;
    border-right: 1px solid var(--dc-border);
    cursor: pointer;
    white-space: nowrap;
    max-width: 180px;
}
.dc-tab:hover:not(.dc-tab--active) { color: var(--dc-fg); background: rgba(255, 255, 255, 0.04); }
/* active tab: flush, filled to the panel surface, top accent bar, and merges
   into the content below by covering the strip's bottom border */
.dc-tab--active {
    color: var(--dc-fg);
    background: var(--dc-surface);
    margin-bottom: -1px;
    border-bottom: 1px solid var(--dc-surface);
}
.dc-tab--active::before {
    content: '';
    position: absolute;
    left: 0; right: 0; top: 0;
    height: 2px;
    background: var(--dc-accent);
}
.dc-tab-title { overflow: hidden; text-overflow: ellipsis; }
.dc-tab-close {
    opacity: 0;
    color: var(--dc-fg-muted);
    padding: 0 2px;
    border-radius: var(--dc-radius);
    font-size: 9px;
}
.dc-tab:hover .dc-tab-close,
.dc-tab--active .dc-tab-close { opacity: 0.65; }
.dc-tab-close:hover { opacity: 1; color: var(--dc-danger); }
/* explanatory hover tooltip */
.dc-tip {
    max-width: 210px;
    padding: 5px 7px;
    font-size: 9px;
    line-height: 1.5;
    color: var(--dc-fg-muted);
    pointer-events: none;
}
.dc-tip b { color: var(--dc-fg); font-weight: 500; }

/* popover (color picker, select dropdown, joystick) */
.dc-popover {
    position: fixed;
    z-index: 3000;
    background: var(--dc-surface);
    border: 1px solid var(--dc-border);
    box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.4);
    padding: 6px;
}

/* context menu */
.dc-menu {
    position: fixed;
    z-index: 3000;
    min-width: 150px;
    padding: 3px;
    background: var(--dc-surface);
    border: 1px solid var(--dc-border);
    box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.4);
    font-size: var(--dc-size-sm);
}
.dc-menu-item {
    padding: 4px 8px;
    color: var(--dc-fg);
    cursor: pointer;
    white-space: nowrap;
    text-transform: lowercase;
}
.dc-menu-item:hover { background: var(--dc-accent); color: var(--dc-on-accent); }
.dc-menu-item--disabled { color: var(--dc-fg-muted); cursor: default; }
.dc-menu-item--disabled:hover { background: transparent; color: var(--dc-fg-muted); }
.dc-menu-sep { height: 1px; margin: 3px 0; background: var(--dc-border-subtle); }

.dc-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.dc-content::-webkit-scrollbar { width: 8px; height: 8px; }
.dc-content::-webkit-scrollbar-thumb { background: var(--dc-border); border-radius: var(--dc-radius); }

/* ---- panel body --------------------------------------------------- */
.dc-panel { display: flex; flex-direction: column; }

/* label + control row */
.dc-row {
    display: flex;
    align-items: center;
    gap: var(--dc-gap);
    min-height: var(--dc-row-h);
    padding: var(--dc-pad-y) var(--dc-pad-x);
    border-bottom: 1px solid var(--dc-border-subtle);
}
.dc-row--disabled { opacity: 0.5; pointer-events: none; }
.dc-row--hidden { display: none; }
.dc-row--filtered { display: none; }
/* multi-field controls (vec / rotation / interval) put the label on its own
   line and give the fields the full row width — room for 3–4 digit numbers */
.dc-row--stacked { flex-direction: column; align-items: stretch; gap: 3px; }
.dc-row--stacked .dc-label { flex: none; max-width: none; width: 100%; }
.dc-row--stacked .dc-control { width: 100%; }
/* an optional control: leading toggle + greyed-out control when off */
.dc-control--disabled { opacity: 0.4; pointer-events: none; }
.dc-optional { flex: 0 0 auto; margin-right: 2px; }

/* panel filter/search field */
.dc-filter-row { padding: 4px var(--dc-pad-x); border-bottom: 1px solid var(--dc-border); background: var(--dc-surface); }
.dc-filter { width: 100%; }
.dc-label {
    flex: 0 0 32%;
    max-width: 32%;
    color: var(--dc-fg);
    font-size: var(--dc-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dc-control { flex: 1 1 auto; display: flex; align-items: center; gap: var(--dc-gap); min-width: 0; }

/* ---- inputs ------------------------------------------------------- */
.dc-input {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    background: var(--dc-surface-muted);
    color: var(--dc-fg);
    font-family: var(--dc-font);
    font-size: var(--dc-size-sm);
    padding: var(--dc-pad-y) 6px;
    border: 1px solid var(--dc-border);
    border-radius: var(--dc-radius);
    outline: none;
}
.dc-input:focus { border-color: var(--dc-fg-muted); }
.dc-input--num { flex: 0 0 auto; width: 56px; text-align: right; font-variant-numeric: tabular-nums; }

/* custom slider: a thin squared track with an accent fill and a bar thumb */
.dc-slider {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    height: 14px;
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: none;
}
.dc-slider::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 4px;
    transform: translateY(-50%);
    background: var(--dc-surface-muted);
    border: 1px solid var(--dc-border);
}
.dc-slider-fill {
    position: absolute;
    left: 0;
    top: 50%;
    height: 4px;
    transform: translateY(-50%);
    background: var(--dc-accent);
    pointer-events: none;
}
.dc-slider-thumb {
    position: absolute;
    top: 50%;
    width: 2px;
    height: 12px;
    background: var(--dc-fg);
    transform: translate(-50%, -50%);
    pointer-events: none;
}

/* a number field wired for drag-to-scrub */
.dc-scrub { cursor: ew-resize; }
.dc-scrub:focus { cursor: text; }

/* fill-backed slider: the number field, with the value as a background fill */
.dc-slidernum {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    text-align: center;
    cursor: ew-resize;
    appearance: textfield;
    -moz-appearance: textfield;
}
.dc-slidernum:focus { cursor: text; }
.dc-slidernum::-webkit-inner-spin-button,
.dc-slidernum::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }

.dc-check {
    flex: 0 0 auto;
    width: 15px; height: 15px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--dc-surface-muted);
    border: 1px solid var(--dc-border);
    color: var(--dc-on-accent);
    font-size: 10px;
    line-height: 1;
    padding: 0;
    cursor: pointer;
}
.dc-check:hover { border-color: var(--dc-fg-muted); }
.dc-check--on { background: var(--dc-accent); border-color: var(--dc-accent); }

.dc-select {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    background: var(--dc-surface-muted);
    color: var(--dc-fg);
    font-family: var(--dc-font);
    font-size: var(--dc-size-sm);
    padding: var(--dc-pad-y) 6px;
    border: 1px solid var(--dc-border);
    cursor: pointer;
}
.dc-select:hover { border-color: var(--dc-fg-muted); }
.dc-select-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-select-caret { flex: 0 0 auto; color: var(--dc-fg-muted); font-size: 9px; }
.dc-select-list { display: flex; flex-direction: column; max-height: 240px; overflow-y: auto; margin: -6px; }
.dc-select-option { padding: 4px 8px; cursor: pointer; white-space: nowrap; color: var(--dc-fg); font-size: var(--dc-size-sm); }
.dc-select-option:hover { background: var(--dc-accent); color: var(--dc-on-accent); }
.dc-select-option--on { background: var(--dc-surface-muted); }

.dc-button {
    flex: 1 1 auto;
    background: var(--dc-surface-muted);
    color: var(--dc-fg);
    font-family: var(--dc-font);
    font-size: var(--dc-size-sm);
    text-transform: lowercase;
    padding: 3px var(--dc-pad-x);
    border: 1px solid var(--dc-border);
    border-radius: var(--dc-radius);
    cursor: pointer;
}
.dc-button:hover { background: var(--dc-accent); color: var(--dc-on-accent); border-color: var(--dc-accent); }
.dc-button:active { transform: translateY(1px); }

/* vector grid: N fields sharing a row. each field is one bordered unit —
   an inset axis label + hairline divider + a borderless, tabular number. */
.dc-vec { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 3px; flex: 1 1 auto; min-width: 0; }
.dc-vec-field {
    display: flex;
    align-items: stretch;
    min-width: 0;
    background: var(--dc-surface-muted);
    border: 1px solid var(--dc-border);
}
.dc-vec-field:focus-within { border-color: var(--dc-fg-muted); }
.dc-vec-axis {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    padding: 0 4px;
    color: var(--dc-fg-muted);
    font-size: 9px;
    border-right: 1px solid var(--dc-border);
    user-select: none;
}
.dc-vec .dc-input {
    width: 100%;
    min-width: 0;
    text-align: right;
    padding: 2px 4px;
    background: transparent;
    border: none;
    font-variant-numeric: tabular-nums;
}

/* vector tools: joystick + link toggle */
.dc-vec-tool {
    flex: 0 0 auto;
    align-self: stretch;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--dc-surface-muted);
    border: 1px solid var(--dc-border);
    color: var(--dc-fg-muted);
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
    padding: 0 6px;
}
.dc-vec-tool:hover { color: var(--dc-fg); }
.dc-vec-tool--on { color: var(--dc-on-accent); background: var(--dc-accent); border-color: var(--dc-accent); }

/* joystick pad */
.dc-pad {
    position: relative;
    width: 132px;
    height: 132px;
    background: var(--dc-surface-muted);
    border: 1px solid var(--dc-border);
    cursor: crosshair;
    touch-action: none;
}
.dc-pad::before, .dc-pad::after { content: ''; position: absolute; background: var(--dc-border-subtle); }
.dc-pad::before { left: 50%; top: 0; bottom: 0; width: 1px; }
.dc-pad::after { top: 50%; left: 0; right: 0; height: 1px; }
.dc-pad-cursor {
    position: absolute;
    width: 8px; height: 8px;
    background: var(--dc-accent);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
    transform: translate(-50%, -50%);
    pointer-events: none;
}

/* color */
.dc-color { display: flex; align-items: center; gap: var(--dc-gap); flex: 1 1 auto; min-width: 0; }
.dc-swatch {
    flex: 0 0 auto;
    width: 22px; height: 18px;
    border: 1px solid var(--dc-border);
    padding: 0;
    cursor: pointer;
}
.dc-color-hex { flex: 1 1 auto; min-width: 0; text-align: left; text-transform: uppercase; }

/* color picker popover */
.dc-cp { display: flex; flex-direction: column; gap: 6px; width: 168px; }
.dc-cp-sv {
    position: relative;
    width: 100%;
    height: 120px;
    cursor: crosshair;
    touch-action: none;
    background-image:
        linear-gradient(to top, #000, rgba(0, 0, 0, 0)),
        linear-gradient(to right, #fff, rgba(255, 255, 255, 0));
}
.dc-cp-cursor {
    position: absolute;
    width: 10px; height: 10px;
    border: 1px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
    transform: translate(-50%, -50%);
    pointer-events: none;
}
.dc-cp-hue {
    position: relative;
    width: 100%;
    height: 12px;
    cursor: pointer;
    touch-action: none;
    background: linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%);
}
.dc-cp-hue-cursor {
    position: absolute;
    top: -1px; bottom: -1px;
    width: 3px;
    background: #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
    transform: translateX(-50%);
    pointer-events: none;
}

/* ---- folder ------------------------------------------------------- */
.dc-folder { display: flex; flex-direction: column; border-bottom: 1px solid var(--dc-border); }
.dc-folder-title {
    display: flex;
    align-items: center;
    gap: var(--dc-gap);
    padding: 4px var(--dc-pad-x);
    font-size: var(--dc-size-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--dc-fg-muted);
    background: var(--dc-surface-muted);
    cursor: pointer;
}
.dc-folder-title:hover { color: var(--dc-fg); }
.dc-folder-chevron { flex: 0 0 auto; transition: transform 0.12s ease; }
.dc-folder--collapsed .dc-folder-chevron { transform: rotate(-90deg); }
.dc-folder-body { display: flex; flex-direction: column; }
.dc-folder--collapsed .dc-folder-body { display: none; }
/* tiles: a responsive grid of compact widgets. grid-template-columns is set inline. */
.dc-folder-body--grid { display: grid; gap: 6px; align-items: start; }
.dc-folder-body--grid > * { min-width: 0; }

/* ---- monitors ----------------------------------------------------- */
.dc-monitor-value { color: var(--dc-fg); font-variant-numeric: tabular-nums; text-align: right; flex: 1 1 auto; }
.dc-monitor-value--copy { cursor: pointer; }
.dc-monitor-value--copy:hover { text-decoration: underline dotted; text-underline-offset: 2px; }
.dc-monitor-value--copied { color: var(--dc-success); }
.dc-graph { display: block; position: static; inset: auto; width: 100%; height: 46px; background: var(--dc-surface-muted); border: 1px solid var(--dc-border); border-radius: var(--dc-radius); }
.dc-graph-row { flex-direction: column; align-items: stretch; gap: 3px; }
.dc-graph-head { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--dc-size-sm); color: var(--dc-fg); }
.dc-graph-now { font-variant-numeric: tabular-nums; color: var(--dc-fg); }
/* runtime stacked/lines switch, sits at the right of the head */
.dc-graph-toggle { flex: none; background: transparent; border: 1px solid var(--dc-border); border-radius: var(--dc-radius); color: var(--dc-fg-muted); cursor: pointer; padding: 0 5px; font-size: 9px; line-height: 14px; text-transform: lowercase; }
.dc-graph-toggle:hover { color: var(--dc-fg); border-color: var(--dc-fg-muted); }
/* fixed equal slots (not space-between) so a changing digit count never reflows siblings */
.dc-graph-stats { display: flex; gap: 8px; font-size: 9px; color: var(--dc-fg-muted); font-variant-numeric: tabular-nums; }
.dc-graph-stats > * { flex: 1 1 0; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dc-graph-stats > *:nth-child(2):not(:last-child) { text-align: center; }
.dc-graph-stats > *:last-child:not(:first-child) { text-align: right; }
.dc-graph-stats b { color: var(--dc-fg); font-weight: 500; }

/* ---- watch widgets ------------------------------------------------ */
/* legend, shared by lines (series) and states (dwell %). labels are static so they
   show at natural width; only the value changes, so it gets a fixed-width right-aligned
   slot — the item width stays constant as digits change, so nothing reflows. */
.dc-legend { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-top: 1px; font-size: 9px; color: var(--dc-fg-muted); font-variant-numeric: tabular-nums; }
.dc-legend-item { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
/* a series clicked out of the isolated set: dimmed but still readable */
.dc-legend-item--hidden { opacity: 0.4; }
.dc-legend-swatch { width: 9px; height: 3px; flex: none; }
.dc-legend-key { color: var(--dc-fg-muted); white-space: nowrap; }
.dc-legend-val { color: var(--dc-fg); flex: none; width: 7ch; text-align: right; overflow: hidden; }
/* the series under the cursor while hovering a lines chart */
.dc-legend-item--active .dc-legend-key { color: var(--dc-fg); font-weight: 500; }
.dc-legend-item--active .dc-legend-swatch { height: 5px; }

/* stat: a headline number with optional delta + sparkline */
.dc-stat-row { flex-direction: column; align-items: stretch; gap: 1px; }
.dc-stat-label { font-size: var(--dc-size-sm); color: var(--dc-fg-muted); }
.dc-stat-main { display: flex; align-items: baseline; gap: 6px; }
.dc-stat-value { font-size: 20px; line-height: 1.15; color: var(--dc-fg); font-variant-numeric: tabular-nums; }
.dc-stat-delta { font-size: 9px; color: var(--dc-fg-muted); font-variant-numeric: tabular-nums; }
.dc-stat-delta--up { color: var(--dc-success); }
.dc-stat-delta--down { color: var(--dc-danger); }
.dc-stat-spark { display: block; width: 100%; height: 20px; margin-top: 2px; }

/* bars: one dom bar per category */
.dc-bars { display: flex; flex-direction: column; gap: 3px; width: 100%; }
.dc-bar { display: flex; align-items: center; gap: 6px; }
.dc-bar-label { flex: 0 0 auto; width: 66px; font-size: var(--dc-size-sm); color: var(--dc-fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dc-bar-track { flex: 1 1 auto; height: 10px; min-width: 0; background: var(--dc-surface-muted); border: 1px solid var(--dc-border); }
.dc-bar-fill { display: block; height: 100%; background: var(--dc-accent); transition: width 0.1s linear; }
.dc-bar-val { flex: 0 0 auto; width: 46px; text-align: right; font-size: var(--dc-size-sm); color: var(--dc-fg); font-variant-numeric: tabular-nums; }

/* gauge: an arc meter */
.dc-gauge { display: block; width: 100%; height: 72px; }

/* states: a colored timeline strip */
.dc-states { display: block; width: 100%; height: 16px; background: var(--dc-surface-muted); border: 1px solid var(--dc-border); }

/* log view */
.dc-log {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    height: 140px;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--dc-surface-muted);
    border: 1px solid var(--dc-border);
    font-size: var(--dc-size-sm);
    font-variant-numeric: tabular-nums;
}
.dc-log::-webkit-scrollbar { width: 8px; }
.dc-log::-webkit-scrollbar-thumb { background: var(--dc-border); }
/* the spacer: its height is count * line-height, driving the scrollbar */
.dc-log-sizer { position: relative; width: 100%; }
/* virtualized rows — a pool of these is positioned by transform, one per visible line */
.dc-log-line {
    position: absolute;
    left: 6px;
    right: 6px;
    top: 0;
    height: 18px;
    line-height: 18px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--dc-fg-muted);
    will-change: transform;
}
.dc-log-line--info { color: var(--dc-fg); }
.dc-log-line--warn { color: var(--dc-warn); }
.dc-log-line--error { color: var(--dc-danger); }
.dc-log-time { margin-right: 6px; color: var(--dc-fg-muted); opacity: 0.7; }

/* ---- switch (flip between editors) -------------------------------- */
.dc-switch { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.dc-switch .dc-row { padding: 0; border-bottom: 0; min-height: auto; }
.dc-switch .dc-label { display: none; }
.dc-switch-toggle {
    flex: 0 0 auto;
    align-self: flex-start;
    background: var(--dc-surface-muted);
    color: var(--dc-fg-muted);
    border: 1px solid var(--dc-border);
    border-radius: var(--dc-radius);
    font-family: var(--dc-font);
    font-size: 9px;
    padding: 0 5px;
    cursor: pointer;
}
.dc-switch-toggle:hover { color: var(--dc-fg); border-color: var(--dc-fg-muted); }
`;

/** inject (or refresh) the dashcat stylesheet. safe to call repeatedly. */
export function injectStyles(doc: Document = document): void {
    let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
        style = doc.createElement('style');
        style.id = STYLE_ID;
        doc.head.appendChild(style);
    }
    style.textContent = css;
}
