import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../../src/web/markdown.ts';

test('Markdown renders headings, paragraphs and line breaks', () => {
  assert.equal(renderMarkdown('# Summary\r\n###### Notes\r\n\r\nFirst line\r\nSecond line\n\nAnother paragraph'),
    '<h1>Summary</h1><h6>Notes</h6><p>First line<br>Second line</p><p>Another paragraph</p>');
  assert.equal(renderMarkdown(' \n\t'), '');
});

test('Markdown renders nested emphasis and keeps incomplete markers and code literal', () => {
  assert.equal(renderMarkdown('**bold**, *italic*, **bold and *italic***, *italic and **bold***, ***both***'),
    '<p><strong>bold</strong>, <em>italic</em>, <strong>bold and <em>italic</em></strong>, <em>italic and <strong>bold</strong></em>, <em><strong>both</strong></em></p>');
  assert.equal(renderMarkdown('**unclosed *word* and `**<x>**`'),
    '<p>**unclosed <em>word</em> and <code>**&#60;x&#62;**</code></p>');
  assert.equal(renderMarkdown('* open\n\n2 ** 3 and ****'), '<ul><li>open</li></ul><p>2 ** 3 and ****</p>');
});

test('Markdown renders unordered, ordered and nested lists', () => {
  assert.equal(renderMarkdown('- first\n  1. child\n  2. **next child**\n* second\n\n3. third\n   - nested'),
    '<ul><li>first<ol><li>child</li><li><strong>next child</strong></li></ol></li><li>second</li></ul><ol start="3"><li>third<ul><li>nested</li></ul></li></ol>');
});

test('Markdown renders task items as disabled checkboxes', () => {
  assert.equal(renderMarkdown('- [ ] Test\n  - [x] Write `code`\n- [X] Ship'),
    '<ul><li class="md-task"><input type="checkbox" disabled aria-label="Incomplete task"> Test<ul><li class="md-task"><input type="checkbox" checked disabled aria-label="Completed task"> Write <code>code</code></li></ul></li><li class="md-task"><input type="checkbox" checked disabled aria-label="Completed task"> Ship</li></ul>');
});

test('Markdown renders blockquotes and leaves embedded HTML escaped', () => {
  assert.equal(renderMarkdown('> **Quote**\n> inline <b>HTML</b>\n>\n> Another paragraph\n\nNormal'),
    '<blockquote><p><strong>Quote</strong><br>inline &#60;b&#62;HTML&#60;/b&#62;</p><p>Another paragraph</p></blockquote><p>Normal</p>');
});

test('a fenced Markdown block keeps source text escaped and unformatted', () => {
  assert.equal(renderMarkdown('````js\n<script>\n**literal**\n```\n- [x] literal\n</script>\n````\n\nAfter'),
    '<pre><code>&#60;script&#62;\n**literal**\n```\n- [x] literal\n&#60;/script&#62;\n</code></pre><p>After</p>');
  assert.equal(renderMarkdown('```\n[link](https://example.test)\n'),
    '<pre><code>[link](https://example.test)\n</code></pre>');
  assert.equal(renderMarkdown('~~~\n```\n  one & two\n~~~'),
    '<pre><code>```\n  one &#38; two\n</code></pre>');
});

test('Markdown links allow HTTP, HTTPS and mailto and escape quotes in labels and URLs', () => {
  assert.equal(renderMarkdown('["Guide" & \'FAQ\'](https://example.test/a(b)?q="yes"&x=\'no\') [*HTTP*](http://example.test) [Email](mailto:por@example.test)'),
    '<p><a href="https://example.test/a(b)?q=&#34;yes&#34;&#38;x=&#39;no&#39;" rel="noopener noreferrer">&#34;Guide&#34; &#38; &#39;FAQ&#39;</a> <a href="http://example.test" rel="noopener noreferrer"><em>HTTP</em></a> <a href="mailto:por@example.test" rel="noopener noreferrer">Email</a></p>');
});

test('Markdown leaves unsafe links and injection attempts as escaped text', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n<a href=\'x\'>raw</a>'),
    '<p>&#60;script&#62;alert(1)&#60;/script&#62;<br>&#60;img src=x onerror=&#34;alert(1)&#34;&#62;<br>&#60;a href=&#39;x&#39;&#62;raw&#60;/a&#62;</p>');
  assert.equal(renderMarkdown('[js](JaVaScRiPt:alert(1)) [data](data:text/html,<script>) [encoded](javascript&#58;alert(1)) [relative](//example.test)'),
    '<p>[js](JaVaScRiPt:alert(1)) [data](data:text/html,&#60;script&#62;) [encoded](javascript&#38;#58;alert(1)) [relative](//example.test)</p>');
  assert.equal(renderMarkdown('[inject](https://example.test/" onmouseover="alert(1))'),
    '<p>[inject](https://example.test/&#34; onmouseover=&#34;alert(1))</p>');
});
