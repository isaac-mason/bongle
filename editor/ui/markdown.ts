// editor/ui/markdown.ts — a small, dependency-free Markdown -> HTML renderer for
// the code editor's .md preview. Covers the common README subset: headings,
// fenced code, inline code, bold/italic, links, images, ul/ol lists,
// blockquotes, hr, paragraphs, and RAW HTML passthrough (so `<table>`, `<img>`,
// `<details>` etc. render). NOT full CommonMark (no nested lists). Rendering
// local, user-authored files: only `<script>` and `javascript:` urls are
// stripped; other HTML is trusted.

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const safeUrl = (url: string): string => (/^\s*javascript:/i.test(url) ? '#' : url);
const headingSlug = (text: string): string =>
    text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

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

export function renderMarkdown(src: string): string {
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

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            flushPara();
            const lvl = heading[1].length;
            const text = heading[2].replace(/\s+#*\s*$/, '').trim();
            out.push(`<h${lvl} id="${headingSlug(text)}">${inline(text)}</h${lvl}>`);
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
            out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
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
