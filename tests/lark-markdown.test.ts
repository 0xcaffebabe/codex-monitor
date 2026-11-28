import test from 'node:test';
import assert from 'node:assert/strict';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { larkMarkdown } from '../server/notifications/lark-markdown.js';

function markdownNodes(text: string) {
  const nodes: Nodes[] = [],
    pending: Nodes[] = [fromMarkdown(text)];
  while (pending.length) {
    const node = pending.pop()!;
    nodes.push(node);
    if ('children' in node) pending.push(...node.children);
  }
  return nodes;
}

test('Lark cards turn inline and reference images into ordinary HTTP links', () => {
  const markdown = [
    '# 完成截图',
    '',
    '![页面截图](https://example.com/shot_(1).png?a=1&b=2 "截图标题")',
    '![](http://example.com/empty.png)',
    '![引用图片][SHOT]',
    '![重复引用][]',
    '![快捷引用]',
    '',
    '[shot]: https://example.com/reference.png',
    '[SHOT]: https://example.com/ignored-duplicate.png',
    '[重复引用]: https://example.com/collapsed.png',
    '[快捷引用]: https://example.com/shortcut.png',
    '',
    '**完成** [查看会话](https://monitor.example.com/?session=123)',
  ].join('\n');
  const result = larkMarkdown(markdown),
    nodes = markdownNodes(result),
    links = nodes.filter((node) => node.type === 'link');
  assert.equal(
    nodes.some((node) => node.type === 'image' || node.type === 'imageReference'),
    false,
  );
  assert.deepEqual(
    links.map((link) => link.url).sort(),
    [
      'https://example.com/shot_(1).png?a=1&b=2',
      'http://example.com/empty.png',
      'https://example.com/reference.png',
      'https://example.com/collapsed.png',
      'https://example.com/shortcut.png',
      'https://monitor.example.com/?session=123',
    ].sort(),
  );
  assert.ok(result.startsWith('# 完成截图\n\n'));
  assert.ok(result.endsWith('**完成** [查看会话](https://monitor.example.com/?session=123)'));
  assert.ok(result.includes('[图片](<http://example.com/empty.png>)'));
});

test('local and unsupported image sources become plain captions', () => {
  for (const source of [
    '/tmp/screenshot.png',
    'C:/Users/test/screenshot.png',
    'sandbox:/mnt/data/screenshot.png',
    'file:///tmp/screenshot.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'img_v3_unknown',
  ]) {
    assert.equal(
      larkMarkdown(`![页面截图](<${source}>)`),
      '页面截图',
      source,
    );
  }
});

test('image conversion preserves code, escaped syntax, ordinary links and truncated summaries', () => {
  const unchanged = [
    '`![行内示例](https://example.com/inline.png)`',
    '',
    '```markdown',
    '![代码示例](/tmp/code.png)',
    '```',
    '',
    '    ![缩进代码](https://example.com/indented.png)',
    '',
    '\\![转义](https://example.com/escaped.png)',
    '[图片文件](https://example.com/link.png)',
    '![被截断](https://example.com/unfinished',
  ].join('\n');
  const result = larkMarkdown(`![截图](/tmp/real.png)\n\n${unchanged}`);
  assert.equal(result, `截图\n\n${unchanged}`);
});

test('linked thumbnails retain the outer link and image captions cannot introduce new markup', () => {
  const markdown =
    '[![缩略图](https://example.com/thumb.png)](https://example.com/full.png)\n\n' +
    '![图\\[1\\] \\!重点 <b>](https://example.com/label.png)';
  const result = larkMarkdown(markdown),
    nodes = markdownNodes(result),
    links = nodes.filter((node) => node.type === 'link');
  assert.ok(result.startsWith('[缩略图](https://example.com/full.png)'));
  assert.equal(
    nodes.some((node) => node.type === 'image' || node.type === 'html'),
    false,
  );
  assert.deepEqual(links.map((node) => node.url).sort(), [
    'https://example.com/full.png',
    'https://example.com/label.png',
  ]);
  assert.equal(links.find((node) => node.url.endsWith('label.png'))?.children[0].type, 'text');
});
