import MarkdownIt from 'markdown-it';
import { extractAnnotationBody, looksLikeAnnotation, parseAnnotationBody } from './annotations.js';
import { clip } from './safe.js';
import type {
  Annotation,
  CodeBlock,
  HeadingRef,
  InlineCode,
  LinkKind,
  ParsedDocument,
} from './types.js';

type Token = ReturnType<MarkdownIt['parse']>[number];

export const LIMITS = {
  maxBlocks: 2000,
  maxLinks: 5000,
  maxInlineCode: 5000,
  maxHeadings: 5000,
  maxNesting: 40,
  maxHtmlScan: 20000,
} as const;

/** GitHub-compatible heading slug. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

function createParser(): MarkdownIt {
  /* html: true so <img src> / <a href> inside README HTML are discovered (never rendered or executed). */
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false, breaks: false });
  /* maxNesting exists at runtime but is missing from the published typings. */
  (md.options as unknown as Record<string, unknown>)['maxNesting'] = LIMITS.maxNesting;
  return md;
}

function countNewlines(s: string, upTo: number): number {
  let n = 0;
  for (let i = 0; i < upTo && i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function inlineText(tok: Token): string {
  let out = '';
  for (const c of tok.children ?? []) {
    if (c.type === 'text' || c.type === 'code_inline') out += c.content;
  }
  return out;
}

const ATTR_RE = /(src|href)[\s]*=[\s]*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/gi;

interface HtmlRef {
  kind: LinkKind;
  href: string;
  offset: number;
}

/** Extract src/href values from an HTML fragment with a bounded scan. */
export function scanHtmlAttributes(html: string): HtmlRef[] {
  const out: HtmlRef[] = [];
  const text = html.length > LIMITS.maxHtmlScan ? html.slice(0, LIMITS.maxHtmlScan) : html;
  if (text.trimStart().startsWith('<!--')) return out;
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(text)) !== null) {
    const name = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (value === '') continue;
    out.push({ kind: name === 'src' ? 'html-src' : 'html-href', href: value, offset: m.index });
  }
  return out;
}

const ANCHOR_RE = /(?:^|[\s"'<])(?:id|name)[\s]*=[\s]*(?:"([^"]*)"|'([^']*)')/gi;

/** Extract explicit anchor targets from an HTML fragment with a bounded scan. */
export function scanHtmlAnchors(html: string): string[] {
  const out: string[] = [];
  const text = html.length > LIMITS.maxHtmlScan ? html.slice(0, LIMITS.maxHtmlScan) : html;
  if (text.trimStart().startsWith('<!--')) return out;
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(text)) !== null) {
    const v = m[1] ?? m[2] ?? '';
    if (v !== '') out.push(v);
  }
  return out;
}

export function normalizeNewlines(source: string): string {
  return source.split('\r\n').join('\n').split('\r').join('\n');
}

export function parseMarkdown(rawSource: string, file: string): ParsedDocument {
  const source = normalizeNewlines(rawSource);
  const md = createParser();
  const lines = source.split('\n');
  const doc: ParsedDocument = {
    file,
    lineCount: lines.length,
    blocks: [],
    links: [],
    headings: [],
    inlineCode: [],
    htmlAnchors: [],
    annotationIssues: [],
    truncated: [],
  };
  let tokens: Token[];
  try {
    tokens = md.parse(source, {});
  } catch (err) {
    doc.truncated.push(`markdown parser rejected the document: ${(err as Error).message}`);
    return doc;
  }

  const slugCounts = new Map<string, number>();
  const refDefLine = (href: string): number | undefined => {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] as string;
      if (l.includes(']:') && l.includes(href)) return i + 1;
    }
    return undefined;
  };

  const limitHit = new Set<string>();
  const hit = (name: string): void => {
    if (!limitHit.has(name)) {
      limitHit.add(name);
      doc.truncated.push(`too many ${name}; only the first were analysed`);
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as Token;
    const map = tok.map;

    if (tok.type === 'heading_open' && map) {
      const inline = tokens[i + 1];
      const text = inline ? inlineText(inline) : '';
      let slug = slugify(text);
      const count = slugCounts.get(slug) ?? 0;
      slugCounts.set(slug, count + 1);
      if (count > 0) slug = `${slug}-${count}`;
      if (doc.headings.length < LIMITS.maxHeadings) {
        const h: HeadingRef = { text: clip(text, 200), slug, line: map[0] + 1 };
        doc.headings.push(h);
      } else hit('headings');
      continue;
    }

    if ((tok.type === 'fence' || tok.type === 'code_block') && map) {
      if (doc.blocks.length >= LIMITS.maxBlocks) {
        hit('code blocks');
        continue;
      }
      const fenced = tok.type === 'fence';
      const info = fenced ? tok.info.trim() : '';
      const language = (info.split(/[\s{]/)[0] ?? '').toLowerCase();
      const line = map[0] + 1;
      let annotation: Annotation | undefined;
      let annotationLine: number | undefined;
      const prev = tokens[i - 1];
      if (prev && prev.type === 'html_block' && prev.level === tok.level && prev.map) {
        const body = extractAnnotationBody(prev.content);
        if (body !== undefined) {
          annotationLine = prev.map[0] + 1;
          if (!fenced) {
            doc.annotationIssues.push({
              line: annotationLine,
              message: 'annotation is attached to an indented code block',
              fix: 'Use a fenced code block (three backticks) after the annotation comment.',
              evidence: clip(prev.content),
            });
          } else {
            const parsed = parseAnnotationBody(body);
            if (parsed.errors.length > 0) {
              for (const e of parsed.errors) {
                doc.annotationIssues.push({
                  line: annotationLine,
                  message: `invalid annotation: ${e}`,
                  fix: 'Fix the annotation; see "readmeproof --help" for the supported keys.',
                  evidence: clip(prev.content),
                });
              }
            } else annotation = parsed.annotation;
          }
        }
      }
      const block: CodeBlock = {
        id: `${file}:${line}`,
        line,
        endLine: map[1],
        contentLine: fenced ? line + 1 : line,
        kind: fenced ? 'fenced' : 'indented',
        language,
        info,
        content: tok.content,
        annotation,
        annotationLine,
      };
      doc.blocks.push(block);
      continue;
    }

    if (tok.type === 'html_block' && map) {
      if (looksLikeAnnotation(tok.content)) {
        const next = tokens[i + 1];
        /* An indented block is reported (once) when the code block itself is processed. */
        const attached = next && (next.type === 'fence' || next.type === 'code_block') && next.level === tok.level;
        if (extractAnnotationBody(tok.content) === undefined) {
          doc.annotationIssues.push({
            line: map[0] + 1,
            message: 'comment looks like a readmeproof annotation but is malformed',
            fix: 'Use the form: <!-- readmeproof: key=value ... --> on one comment.',
            evidence: clip(tok.content),
          });
        } else if (!attached) {
          doc.annotationIssues.push({
            line: map[0] + 1,
            message: 'annotation is not immediately followed by a fenced code block',
            fix: 'Place the annotation comment directly above the code block it describes.',
            evidence: clip(tok.content),
          });
        }
        continue;
      }
      if (doc.htmlAnchors.length < LIMITS.maxHeadings) doc.htmlAnchors.push(...scanHtmlAnchors(tok.content));
      for (const ref of scanHtmlAttributes(tok.content)) {
        if (doc.links.length >= LIMITS.maxLinks) {
          hit('links');
          break;
        }
        doc.links.push({
          kind: ref.kind,
          href: ref.href,
          line: map[0] + 1 + countNewlines(tok.content, ref.offset),
          approximateLine: false,
        });
      }
      continue;
    }

    if (tok.type === 'inline' && map) {
      const base = map[0] + 1;
      const content = tok.content;
      let cursor = 0;
      const locate = (needle: string): number | undefined => {
        const idx = content.indexOf(needle, cursor);
        if (idx < 0) return undefined;
        cursor = idx + needle.length;
        return base + countNewlines(content, idx);
      };
      for (const child of tok.children ?? []) {
        if (child.type === 'link_open' || child.type === 'image') {
          const hrefAttr = child.attrGet(child.type === 'image' ? 'src' : 'href');
          if (hrefAttr === null || hrefAttr === '') continue;
          if (doc.links.length >= LIMITS.maxLinks) {
            hit('links');
            continue;
          }
          let exact = locate(hrefAttr);
          if (exact === undefined) {
            try {
              exact = locate(decodeURI(hrefAttr));
            } catch {
              exact = undefined;
            }
          }
          let line = exact;
          let approximate = false;
          if (line === undefined) {
            line = refDefLine(hrefAttr) ?? base;
            approximate = true;
          }
          doc.links.push({
            kind: child.type === 'image' ? 'image' : 'link',
            href: hrefAttr,
            line,
            approximateLine: approximate,
          });
        } else if (child.type === 'code_inline') {
          if (doc.inlineCode.length >= LIMITS.maxInlineCode) {
            hit('inline code spans');
            continue;
          }
          const line = locate(child.content) ?? base;
          const ic: InlineCode = { text: child.content, line };
          doc.inlineCode.push(ic);
        } else if (child.type === 'html_inline') {
          const refs = scanHtmlAttributes(child.content);
          if (doc.htmlAnchors.length < LIMITS.maxHeadings) doc.htmlAnchors.push(...scanHtmlAnchors(child.content));
          const line = locate(child.content) ?? base;
          for (const ref of refs) {
            if (doc.links.length >= LIMITS.maxLinks) {
              hit('links');
              break;
            }
            doc.links.push({ kind: ref.kind, href: ref.href, line, approximateLine: false });
          }
        }
      }
    }
  }
  return doc;
}
