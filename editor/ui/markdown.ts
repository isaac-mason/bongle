// editor/ui/markdown.ts — a small, dependency-free Markdown -> HTML renderer for
// the code editor's .md preview. Covers the common README subset: headings,
// fenced code, inline code, bold/italic, links, images, ul/ol lists, GFM pipe
// tables, blockquotes, hr, paragraphs, and RAW HTML passthrough (so `<table>`,
// `<img>`, `<details>` etc. render). NOT full CommonMark (no nested lists).
// Rendering local, user-authored files: only `<script>` and `javascript:` urls
// are stripped; other HTML is trusted.

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const safeUrl = (url: string): string => (/^\s*javascript:/i.test(url) ? '#' : url);
const headingSlug = (text: string): string =>
    text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

/** a heading in reading order, for the table-of-contents sidebar. */
export type TocEntry = { level: number; text: string; id: string };

/** strip inline markdown syntax down to plain text (for TOC labels). */
const inlineToText = (text: string): string =>
    text
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

// heading-collection state threaded through the top-level render; nested renders
// (blockquotes) pass null so their headings stay out of the document TOC.
type TocContext = { toc: TocEntry[]; seen: Map<string, number> };

const S0 = '';
const S1 = ''; // private-use sentinels for extracted code spans

/** inline markdown on raw text; raw inline HTML passes through untouched. */
function inline(text: string): string {
    const codes: string[] = [];
    let t = text.replace(/`([^`]+)`/g, (_m, c: string) => `${S0}${codes.push(`<code>${esc(c)}</code>`) - 1}${S1}`);
    t = t.replace(
        /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        (_m, alt: string, url: string) => `<img src="${safeUrl(url)}" alt="${alt}" style="max-width:100%">`,
    );
    t = t.replace(
        /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        (_m, label: string, url: string) => {
            const h = safeUrl(url);
            return h.startsWith('#')
                ? `<a href="${h}">${label}</a>`
                : `<a href="${h}" target="_blank" rel="noreferrer">${label}</a>`;
        },
    );
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, '<em>$1</em>');
    return t.replace(/(\d+)/g, (_m, i: string) => codes[Number(i)]);
}

// ── GFM pipe tables ──────────────────────────────────────────────────────────
// split a `| a | b |` row into trimmed cells; leading/trailing pipes optional,
// `\|` is a literal pipe inside a cell.
const splitRow = (row: string): string[] =>
    row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replace(/\\\|/g, '|'));

// the row under the header: every cell is `---`, `:--`, `--:`, or `:-:`. Requires
// a pipe so a bare `-----` (an hr) after a `|`-bearing line isn't misread.
const isTableDelimiter = (row: string): boolean => row.includes('|') && splitRow(row).every((c) => /^:?-+:?$/.test(c));

const cellAlign = (c: string): string => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
};
const alignAttr = (a: string): string => (a ? ` style="text-align:${a}"` : '');

const renderTable = (header: string[], aligns: string[], body: string[][]): string => {
    const head = header.map((c, k) => `<th${alignAttr(aligns[k])}>${inline(c)}</th>`).join('');
    const rows = body
        .map((cells) => {
            // GFM pads short rows / ignores extra cells against the header width.
            const tds = header.map((_h, k) => `<td${alignAttr(aligns[k])}>${inline(cells[k] ?? '')}</td>`).join('');
            return `<tr>${tds}</tr>`;
        })
        .join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
};

/** render Markdown to HTML and collect the heading outline in one pass. */
export function renderMarkdownWithToc(src: string): { html: string; toc: TocEntry[] } {
    const ctx: TocContext = { toc: [], seen: new Map() };
    return { html: renderBlocks(src, ctx), toc: ctx.toc };
}

export function renderMarkdown(src: string): string {
    return renderBlocks(src, null);
}

function renderBlocks(src: string, ctx: TocContext | null): string {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    let para: string[] = [];
    const flushPara = () => {
        if (para.length) {
            out.push(`<p>${inline(para.join(' '))}</p>`);
            para = [];
        }
    };

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (/^```/.test(line)) {
            flushPara();
            // capture the info-string language (```ts) — MarkdownView syntax-
            // highlights `code[data-lang]` blocks with Monaco after render.
            const lang = /^```([\w+#-]+)/.exec(line)?.[1]?.toLowerCase() ?? '';
            const buf: string[] = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
            i++; // closing fence
            const code = esc(buf.join('\n'));
            out.push(lang ? `<pre><code data-lang="${lang}">${code}</code></pre>` : `<pre><code>${code}</code></pre>`);
            continue;
        }

        // raw HTML block: a line starting with a tag (or comment). Pass through
        // verbatim until a blank line so multi-line <table>/<details> render.
        if (/^\s*<[a-zA-Z!/]/.test(line)) {
            flushPara();
            const buf: string[] = [];
            while (i < lines.length && !/^\s*$/.test(lines[i])) buf.push(lines[i++]);
            out.push(buf.join('\n'));
            continue;
        }

        // GFM pipe table: a header row + a delimiter row (`--- | :--:`). Detected
        // via the delimiter so a lone `|` in prose isn't misread as a table.
        if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
            flushPara();
            const header = splitRow(line);
            const aligns = splitRow(lines[i + 1]).map(cellAlign);
            i += 2;
            const body: string[][] = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '' && !/^```/.test(lines[i])) {
                body.push(splitRow(lines[i++]));
            }
            out.push(renderTable(header, aligns, body));
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            flushPara();
            const lvl = heading[1].length;
            const text = heading[2].replace(/\s+#*\s*$/, '').trim();
            let id = headingSlug(text);
            if (ctx) {
                // suffix repeats so anchors stay unique and the TOC links resolve.
                const n = ctx.seen.get(id) ?? 0;
                ctx.seen.set(id, n + 1);
                if (n) id = `${id}-${n}`;
                ctx.toc.push({ level: lvl, text: inlineToText(text), id });
            }
            out.push(`<h${lvl} id="${id}">${inline(text)}</h${lvl}>`);
            i++;
            continue;
        }

        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            flushPara();
            out.push('<hr>');
            i++;
            continue;
        }

        if (/^>\s?/.test(line)) {
            flushPara();
            const buf: string[] = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
            out.push(`<blockquote>${renderBlocks(buf.join('\n'), null)}</blockquote>`);
            continue;
        }

        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
            flushPara();
            const ordered = /^\s*\d+\.\s+/.test(line);
            const items: string[] = [];
            while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
                items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
            }
            const lis = items.map((it) => `<li>${inline(it)}</li>`).join('');
            out.push(ordered ? `<ol>${lis}</ol>` : `<ul>${lis}</ul>`);
            continue;
        }

        if (/^\s*$/.test(line)) {
            flushPara();
            i++;
            continue;
        }

        para.push(line.trim());
        i++;
    }
    flushPara();
    // strip <script> as a safety net (local content is otherwise trusted).
    return out.join('\n').replace(/<script[\s\S]*?<\/script\s*>/gi, '');
}
