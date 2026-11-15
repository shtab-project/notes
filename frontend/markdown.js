export const escape = (text = '') => String(text).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const wikiPattern = /\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g;
const tagPattern = /(^|[\s(])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;

const codePattern = /^[ \t]*```[^\n]*(?:\n|$)[\s\S]*?(?:^[ \t]*```[^\n]*$|$(?![\s\S]))|`[^`\n]*`/gm;
const markdownTokens = (source) => source.replace(codePattern, '');

export function rewriteWikiLinks(source, rewrite) {
  const pattern = new RegExp(`${codePattern.source}|${wikiPattern.source}`, 'gm');
  return source.replace(pattern, (full, target, alias) => {
    if (!target) return full;
    const next = rewrite(target.trim());
    return next === target.trim() ? full : `[[${next}${alias ? `|${alias}` : ''}]]`;
  });
}

export function wikiLinks(source) {
  return [...markdownTokens(source).matchAll(wikiPattern)].map((match) => match[1].trim());
}

export function tags(source) {
  return [...new Set([...markdownTokens(source).matchAll(tagPattern)].map((match) => match[2].toLocaleLowerCase('ru')))];
}

function plain(text) {
  let html = '';
  let position = 0;
  for (const match of text.matchAll(tagPattern)) {
    html += escape(text.slice(position, match.index) + match[1]);
    html += `<button type="button" class="tag-link" data-tag="${escape(match[2].toLocaleLowerCase('ru'))}">#${escape(match[2])}</button>`;
    position = match.index + match[0].length;
  }
  return html + escape(text.slice(position));
}

function inline(text, resolve) {
  const pattern = /`([^`]+)`|\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^\s)]+)\)/g;
  let result = '';
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    result += plain(text.slice(position, match.index));
    if (match[1]) result += `<code>${escape(match[1])}</code>`;
    else if (match[2]) {
      const target = match[2].trim();
      const note = resolve(target);
      result += `<button type="button" class="wiki-link${note ? '' : ' missing'}" data-wiki="${escape(target)}">${escape(match[3] || target)}</button>`;
    }
    else if (match[4]) result += `<strong>${inline(match[4], resolve)}</strong>`;
    else if (match[5]) result += `<em>${inline(match[5], resolve)}</em>`;
    else {
      try {
        const url = new URL(match[7]);
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error('Unsafe URL');
        result += `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(match[6])}</a>`;
      } catch {
        result += escape(match[0]);
      }
    }
    position = match.index + match[0].length;
  }
  return result + plain(text.slice(position));
}

// Небольшой безопасный набор Markdown: без выполнения HTML из заметок.
export function markdown(source, resolve = () => undefined) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let result = '';
  let list = null;
  let code = null;
  const closeList = () => {
    if (list) result += `</${list}>`;
    list = null;
  };
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith('```')) {
      closeList();
      if (code === null) code = [];
      else { result += `<pre><code>${escape(code.join('\n'))}</code></pre>`; code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (item) {
      const type = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
      if (list !== type) { closeList(); list = type; result += `<${list}>`; }
      const checkbox = item[1].match(/^\[([ xX])\]\s*(.*)$/);
      result += checkbox
        ? `<li class="check-item"><input type="checkbox" data-check-line="${index}" aria-label="${escape(checkbox[2])}" ${checkbox[1] !== ' ' ? 'checked' : ''}>${inline(checkbox[2], resolve)}</li>`
        : `<li>${inline(item[1], resolve)}</li>`;
      continue;
    }
    closeList();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) result += `<h${heading[1].length}>${inline(heading[2], resolve)}</h${heading[1].length}>`;
    else if (/^>\s?/.test(line)) result += `<blockquote>${inline(line.replace(/^>\s?/, ''), resolve)}</blockquote>`;
    else if (/^\s*---\s*$/.test(line)) result += '<hr>';
    else if (line.trim()) result += `<p>${inline(line, resolve)}</p>`;
  }
  closeList();
  if (code !== null) result += `<pre><code>${escape(code.join('\n'))}</code></pre>`;
  return result;
}
