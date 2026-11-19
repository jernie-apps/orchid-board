import { escapeHtml } from './render.ts';

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/;
const FENCE_END = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// escapeHtml emits this entity for the blockquote marker.
const QUOTE = /^ {0,3}&#62;[ \t]?(.*)$/;

/** Render the inbox's Markdown subset. Every source fragment starts out HTML-escaped. */
export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src).split(/\r\n?|\n/);
  const html: string[] = [];
  const paragraph: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = FENCE.exec(line);
    const heading = HEADING.exec(line);
    const item = listItem(line);
    const quote = QUOTE.exec(line);
    if (line.trim() && !fence && !heading && !item && !quote) {
      paragraph.push(line);
      index++;
      continue;
    }

    flushParagraph(html, paragraph);
    if (fence) {
      const marker = (fence[1] ?? fence[2])!;
      const start = ++index;
      while (index < lines.length) {
        const end = FENCE_END.exec(lines[index]!)?.[1];
        if (end && end[0] === marker[0] && end.length >= marker.length) break;
        index++;
      }
      const newline = index < lines.length && index > start ? '\n' : '';
      html.push(`<pre><code>${lines.slice(start, index).join('\n')}${newline}</code></pre>`);
      index++;
    } else if (heading) {
      const level = heading[1]!.length;
      const title = (heading[2] ?? '').trim().replace(/[ \t]#+$/, '').trimEnd();
      html.push(`<h${level}>${renderInline(title)}</h${level}>`);
      index++;
    } else if (item) {
      index = renderList(html, lines, index, item);
    } else if (quote) {
      html.push('<blockquote>');
      let next: RegExpExecArray | null = quote;
      while (next) {
        const text = next[1]!;
        if (text.trim()) paragraph.push(text);
        else flushParagraph(html, paragraph);
        next = QUOTE.exec(lines[++index] ?? '');
      }
      flushParagraph(html, paragraph);
      html.push('</blockquote>');
    } else {
      index++;
    }
  }
  flushParagraph(html, paragraph);
  return html.join('');
}

function flushParagraph(html: string[], lines: string[]): void {
  if (lines.length === 0) return;
  html.push(`<p>${lines.map(renderInline).join('<br>')}</p>`);
  lines.length = 0;
}

interface ListItem {
  indent: number;
  number: string | undefined;
  text: string;
}

function listItem(line: string): ListItem | null {
  const match = /^([ \t]*)(?:[-*]|(\d{1,9})\.)[ \t]+(.*)$/.exec(line);
  return match ? { indent: match[1]!.replaceAll('\t', '    ').length, number: match[2], text: match[3]! } : null;
}

function renderList(html: string[], lines: string[], index: number, first: ListItem, nested = false): number {
  const ordered = first.number !== undefined;
  const tag = ordered ? 'ol' : 'ul';
  const start = Number(first.number ?? 1);
  html.push(`<${tag}${start === 1 ? '' : ` start="${start}"`}>`);
  let item: ListItem | null = first;
  while (item && (item.number !== undefined) === ordered && (item.indent === first.indent || (nested && item.indent > first.indent))) {
    const task = /^\[([ xX])\](?:[ \t]+|$)(.*)$/.exec(item.text);
    if (task) {
      const checked = task[1] !== ' ';
      html.push(`<li class="md-task"><input type="checkbox"${checked ? ' checked' : ''} disabled aria-label="${checked ? 'Completed' : 'Incomplete'} task"> ${renderInline(task[2]!)}`);
    } else {
      html.push(`<li>${renderInline(item.text)}`);
    }
    item = listItem(lines[++index] ?? '');
    while (!nested && item && item.indent > first.indent) {
      index = renderList(html, lines, index, item, true);
      item = listItem(lines[index] ?? '');
    }
    html.push('</li>');
  }
  html.push(`</${tag}>`);
  return index;
}

function renderInline(text: string): string {
  const html: string[] = [];
  const open: { width: number; index: number }[] = [];
  let end = 0;
  // Match code and links before emphasis, so their literal delimiters stay out of the emphasis stack.
  const tokens = /(?<!`)`([^`]+)`(?!`)|\[([^\[\]]*)\]\(((?:[^()]|\([^()]*\))*)\)|\*+/g;
  for (const token of text.matchAll(tokens)) {
    const [literal, code, label, href] = token;
    html.push(text.slice(end, token.index));
    end = token.index + literal.length;
    if (code !== undefined) {
      html.push(`<code>${code}</code>`);
    } else if (label !== undefined && href !== undefined) {
      // The scheme must appear literally in the escaped source. Entities stay escaped in the attribute.
      html.push(/^(?:https?|mailto):/i.test(href) && !/\s/.test(href)
        ? `<a href="${href}" rel="noopener noreferrer">${renderInline(label)}</a>`
        : literal);
    } else {
      let width = literal.length;
      if (width <= 3 && token.index > 0 && !/\s/.test(text[token.index - 1]!)) {
        let last = open.at(-1);
        while (last && last.width <= width) {
          const tag = last.width === 1 ? 'em' : 'strong';
          html[last.index] = `<${tag}>`;
          html.push(`</${tag}>`);
          width -= last.width;
          open.pop();
          last = open.at(-1);
        }
      }
      if (width > 0 && width <= 3 && end < text.length && !/\s/.test(text[end]!)) {
        // Three asterisks open an italic span containing a bold span.
        for (const part of width === 3 ? [1, 2] : [width]) {
          open.push({ width: part, index: html.length });
          html.push('*'.repeat(part));
        }
      } else {
        html.push('*'.repeat(width));
      }
    }
  }
  html.push(text.slice(end));
  return html.join('');
}
