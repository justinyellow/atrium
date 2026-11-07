// Rich markdown dialect tests: lossless round-trip of every Atrium block/inline type, Notion-flavored
// Markdown input, and warnings. Run: npx tsx --test src/richmd.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksToDoc, docToBlocks } from './markdown.js';
import { blocksToRich } from './richmd/emit.js';
import { richToBlocks } from './richmd/parse.js';

const BASE = 'https://atrium.example.com';
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const U1 = '33333333-3333-4333-8333-333333333333';
const DB = '44444444-4444-4444-8444-444444444444';
const SYNC = '55555555-5555-4555-8555-555555555555';

const t = (text: string, styles: Record<string, any> = {}) => ({ type: 'text', text, styles });

/** Normalise through the editor schema (fills defaults) and drop generated ids. */
function norm(blocks: any[]): any[] {
  const strip = (b: any): any => {
    const { id: _id, ...rest } = b;
    return { ...rest, children: (b.children ?? []).map(strip) };
  };
  return docToBlocks(blocksToDoc(blocks)).map(strip);
}

function roundTrip(blocks: any[]) {
  const rich = blocksToRich(blocks, { baseUrl: BASE });
  const { blocks: back, warnings } = richToBlocks(rich, { baseUrl: BASE });
  return { rich, back, warnings };
}

function assertRoundTrip(blocks: any[], label = 'round trip') {
  const { rich, back, warnings } = roundTrip(blocks);
  try {
    assert.deepEqual(norm(back), norm(blocks));
  } catch (e) {
    console.error(`--- ${label}: rich markdown was:\n${rich}\n--- warnings: ${JSON.stringify(warnings)}`);
    throw e;
  }
  assert.deepEqual(warnings, [], `${label}: unexpected warnings`);
  return rich;
}

export const KITCHEN_SINK: any[] = [
  { type: 'heading', props: { level: 1 }, content: [t('Project '), t('Atlas', { bold: true }), t(' — C#')] },
  { type: 'paragraph', content: [t('Plain, '), t('bold', { bold: true }), t(', '), t('italic', { italic: true }), t(', '), t('under', { underline: true }), t(', '), t('strike', { strike: true }), t(', '), t('code `x`', { code: true }), t(' and '), t('all', { bold: true, italic: true, underline: true, strike: true })] },
  { type: 'paragraph', content: [t('Red', { textColor: 'red' }), t(' on '), t('blue bg', { backgroundColor: 'blue' }), t(' both', { textColor: 'green', backgroundColor: 'yellow', bold: true })] },
  { type: 'paragraph', content: [t('Specials: * _ ` [ ] < > $ ~ & | \\ # 1. - + = {x}')] },
  { type: 'paragraph', content: [t('  leading spaces and trailing  ')] },
  { type: 'paragraph', content: [t('line one\nline two\n  indented line three')] },
  { type: 'paragraph', content: [t('See '), { type: 'link', href: 'https://example.com/a b(c)', content: [t('a '), t('link', { bold: true })] }, t(' and '), { type: 'link', href: `${BASE}/p/${P2}`, content: [t('internal link')] }] },
  { type: 'paragraph', content: [{ type: 'mention', props: { kind: 'page', id: P1, label: 'Roadmap' } }, t(' owned by '), { type: 'mention', props: { kind: 'user', id: U1, label: 'Priya Shah' } }, t(' due '), { type: 'mention', props: { kind: 'date', date: '2026-11-08' } }, t(' and '), { type: 'mention', props: { kind: 'date', date: '2026-11-09T15:30:00+02:00', reminder: '1d' } }, t('.')] },
  { type: 'paragraph', content: [t('Inline maths '), { type: 'inlineEquation', props: { latex: 'e^{i\\pi} + 1 = 0' } }, t(' costs $5 and $10.')] },
  { type: 'paragraph', props: { textColor: 'purple', backgroundColor: 'gray', textAlignment: 'center' }, content: [t('Centred coloured paragraph')] },
  { type: 'paragraph', content: [] },
  { type: 'paragraph', props: { backgroundColor: 'yellow' }, content: [] },
  { type: 'paragraph', content: [t('Parent paragraph')], children: [{ type: 'paragraph', content: [t('nested child')] }] },
  { type: 'heading', props: { level: 2, textColor: 'blue' }, content: [t('Coloured H2')] },
  { type: 'heading', props: { level: 3, isToggleable: true }, content: [t('Toggle heading')], children: [{ type: 'paragraph', content: [t('hidden under heading')] }] },
  { type: 'heading', props: { level: 4 }, content: [t('H4')] },
  { type: 'heading', props: { level: 2 }, content: [t('Heading with child')], children: [{ type: 'paragraph', content: [t('child of heading')] }] },
  { type: 'bulletListItem', content: [t('Bullet one')], children: [{ type: 'bulletListItem', content: [t('nested bullet')], children: [{ type: 'checkListItem', props: { checked: true }, content: [t('deep done task')] }] }] },
  { type: 'bulletListItem', props: { textColor: 'red' }, content: [t('Red bullet')] },
  { type: 'bulletListItem', content: [t('- looks like a bullet')] },
  { type: 'numberedListItem', content: [t('First')] },
  { type: 'numberedListItem', content: [t('Second')], children: [{ type: 'numberedListItem', content: [t('Second.a')] }] },
  { type: 'numberedListItem', props: { backgroundColor: 'green' }, content: [t('Green third')] },
  { type: 'numberedListItem', content: [t('Fourth')] },
  { type: 'paragraph', content: [t('break')] },
  { type: 'numberedListItem', props: { start: 7 }, content: [t('Seven')] },
  { type: 'numberedListItem', content: [t('Eight')] },
  { type: 'checkListItem', props: { checked: false }, content: [t('Open task')] },
  { type: 'checkListItem', props: { checked: true }, content: [t('Done task')] },
  { type: 'checkListItem', props: { checked: true, textColor: 'gray' }, content: [t('Grey done task')] },
  { type: 'toggleListItem', content: [t('Toggle title')], children: [{ type: 'paragraph', content: [t('toggle body')] }, { type: 'toggleListItem', content: [t('inner toggle')], children: [{ type: 'bulletListItem', content: [t('deep')] }] }] },
  { type: 'toggleListItem', props: { backgroundColor: 'pink' }, content: [], children: [{ type: 'paragraph', content: [t('untitled toggle child')] }] },
  { type: 'quote', content: [t('Simple quote')] },
  { type: 'quote', props: { textColor: 'brown' }, content: [t('Quote line 1\nline 2')], children: [{ type: 'paragraph', content: [t('quote child')] }] },
  { type: 'callout', props: { emoji: '⚠️', backgroundColor: 'red' }, content: [t('Careful: '), t('bold inside', { bold: true }), t(' '), { type: 'mention', props: { kind: 'page', id: P2, label: 'Runbook' } }], children: [{ type: 'bulletListItem', content: [t('callout child')] }] },
  { type: 'callout', props: { emoji: '💡' }, content: [t('Default grey callout')] },
  { type: 'callout', props: { emoji: '🚀', backgroundColor: 'default', textColor: 'blue' }, content: [t('No background, blue text')] },
  { type: 'divider' },
  { type: 'codeBlock', props: { language: 'typescript' }, content: [t('const a = `x`;\n```\nnot a fence\n  indented\n')] },
  { type: 'codeBlock', content: [t('plain text code')] },
  {
    type: 'table',
    props: { textColor: 'default' },
    content: {
      type: 'tableContent',
      columnWidths: [180, null, 90],
      headerRows: 1,
      headerCols: 1,
      rows: [
        { cells: [{ type: 'tableCell', content: [t('Name', { bold: true })], props: {} }, { type: 'tableCell', content: [t('Notes')], props: {} }, { type: 'tableCell', content: [t('Qty')], props: { textAlignment: 'right' } }] },
        { cells: [{ type: 'tableCell', content: [t('Row | pipe')], props: { backgroundColor: 'yellow' } }, { type: 'tableCell', content: [t('two\nlines')], props: { textColor: 'red' } }, { type: 'tableCell', content: [t('3')], props: {} }] },
        { cells: [{ type: 'tableCell', content: [t('merged')], props: { colspan: 2 } }, { type: 'tableCell', content: [], props: {} }] },
      ],
    },
  },
  { type: 'image', props: { url: 'https://img.example.com/a.png', caption: 'A caption' } },
  { type: 'image', props: { url: 'https://img.example.com/b c.png', caption: '', name: 'b c.png', previewWidth: 320, textAlignment: 'center' } },
  { type: 'video', props: { url: 'https://cdn.example.com/v.mp4', caption: 'Demo', name: 'v.mp4' } },
  { type: 'audio', props: { url: 'https://cdn.example.com/a.mp3', name: 'a.mp3' } },
  { type: 'file', props: { url: '/api/v1/files/abc', name: 'Spec "v2".pdf', caption: 'the spec' } },
  { type: 'bookmark', props: { url: 'https://github.com/org/repo', title: 'org/repo', description: 'A <repo> & more', image: 'https://img/x.png', favicon: 'https://gh/f.ico' } },
  { type: 'embed', props: { url: 'https://www.youtube-nocookie.com/embed/abc', height: 315 } },
  { type: 'embed', props: { url: 'https://figma.com/file/x' } },
  { type: 'equation', props: { latex: '\\int_0^1 x^2\\,dx = \\tfrac{1}{3}' } },
  {
    type: 'columnList',
    children: [
      { type: 'column', props: { width: 1.5 }, children: [{ type: 'paragraph', content: [t('left')] }, { type: 'bulletListItem', content: [t('left list')] }] },
      { type: 'column', props: { width: 0.5 }, children: [{ type: 'callout', props: { emoji: '📌' }, content: [t('right callout')] }] },
    ],
  },
  { type: 'syncedBlock', props: { sourceId: SYNC } },
  { type: 'subpage', props: { pageId: P1, title: 'Roadmap' } },
  { type: 'database', props: { databaseId: DB, linked: false } },
  { type: 'database', id: 'linked-block-1', props: { databaseId: DB, linked: true } },
  { type: 'toc' },
  { type: 'breadcrumb' },
  { type: 'button', props: { label: 'Add task', actions: JSON.stringify([{ type: 'insert', markdown: '- [ ] "new"' }]) } },
  { type: 'paragraph', content: [t('The end.')] },
];

test('kitchen sink round-trips losslessly (blocks → rich → blocks)', () => {
  assertRoundTrip(KITCHEN_SINK, 'kitchen sink');
});

test('each kitchen-sink block round-trips on its own', () => {
  for (const [i, b] of KITCHEN_SINK.entries()) assertRoundTrip([b], `block ${i} (${b.type})`);
});

test('rich output is stable: emit(parse(emit(x))) === emit(x)', () => {
  const once = blocksToRich(KITCHEN_SINK, { baseUrl: BASE });
  const twice = blocksToRich(richToBlocks(once, { baseUrl: BASE }).blocks, { baseUrl: BASE });
  assert.equal(twice, once);
});

test('linked database block keeps its block id (views are scoped to it)', () => {
  const { back } = roundTrip([{ type: 'database', id: 'linked-block-1', props: { databaseId: DB, linked: true } }]);
  assert.equal(back[0].id, 'linked-block-1');
});

// ---------------- Notion-flavored Markdown input (synthetic fixtures) ----------------

const NOTION_PAGE = 'https://app.notion.com/p/0123456789abcdef0123456789abcdef';
const NOTION_USER = 'user://9f2c1e44-0000-4000-8000-00000000abcd';

function parse(src: string, opts: any = {}) {
  return richToBlocks(src, { baseUrl: BASE, ...opts });
}
const plain = (content: any[]) => content.map((c: any) => c.text ?? c.content?.map((x: any) => x.text).join('') ?? `[${c.type}]`).join('');

test('notion: callout whose first child is a heading, with a sub-page outside the workspace', () => {
  const { blocks, warnings } = parse(`<callout icon="🪧" color="green_bg">\n## <b>Start here</b>\n\n<page url="${NOTION_PAGE}">\nTeam handbook\n</page>\n</callout>`);
  assert.equal(blocks.length, 1);
  const c = blocks[0];
  assert.equal(c.type, 'callout');
  assert.equal(c.props.emoji, '🪧');
  assert.equal(c.props.backgroundColor, 'green');
  assert.deepEqual(c.content, []);
  assert.equal(c.children[0].type, 'heading');
  assert.deepEqual(c.children[0].content, [t('Start here', { bold: true })]);
  assert.equal(c.children[1].type, 'paragraph');
  assert.equal(c.children[1].content[0].type, 'link');
  assert.equal(c.children[1].content[0].href, NOTION_PAGE);
  assert.ok(warnings.some((w) => w.includes('outside this workspace')));
});

test('notion: toggles, <ol><li>, tab-indented children, checklists, empty paragraph', () => {
  const src = [
    '<toggle>', '<b>03 Nov</b>', '', '- item one', '- item two', '</toggle>', '',
    '<ol>', '<li>', 'First thing', '</li>', '<li>', 'Second thing', '</li>', '</ol>', '',
    '- parent bullet', '\t<p>', '\tchild paragraph', '\t</p>', '',
    '- [x] done', '- [ ] open', '', '<p />', '',
    '<details><summary>Old toggle</summary>', 'Body text', '</details>',
  ].join('\n');
  const { blocks } = parse(src);
  assert.deepEqual(blocks.map((b) => b.type), ['toggleListItem', 'numberedListItem', 'numberedListItem', 'bulletListItem', 'checkListItem', 'checkListItem', 'paragraph', 'toggleListItem']);
  assert.deepEqual(blocks[0].content, [t('03 Nov', { bold: true })]);
  assert.deepEqual(blocks[0].children.map((c: any) => plain(c.content)), ['item one', 'item two']);
  assert.equal(blocks[1].props.start, undefined);
  assert.equal(plain(blocks[2].content), 'Second thing');
  assert.equal(blocks[3].children[0].type, 'paragraph');
  assert.equal(plain(blocks[3].children[0].content), 'child paragraph');
  assert.equal(blocks[4].props.checked, true);
  assert.equal(blocks[5].props.checked, false);
  assert.deepEqual(blocks[6].content, []);
  assert.equal(plain(blocks[7].content), 'Old toggle');
  assert.equal(plain(blocks[7].children[0].content), 'Body text');
});

test('notion: inline styles, colours, mentions and dates', () => {
  const src = `**Bold** *it* ~~gone~~ <u>under</u> <span color="red">red</span> <span color="blue_bg">bg</span> [site](https://example.com) <mention url="${NOTION_USER}" /> <mention url="${NOTION_PAGE}">Spec</mention> <date start="2026-10-23" /> <date start="2026-10-24" start-time="09:30" time-zone="Africa/Johannesburg" end="2026-10-25" />`;
  const { blocks, warnings } = parse(src);
  const c = blocks[0].content;
  assert.deepEqual(c.slice(0, 2), [t('Bold', { bold: true }), t(' ')]);
  assert.ok(c.some((x: any) => x.type === 'text' && x.text === 'it' && x.styles.italic));
  assert.ok(c.some((x: any) => x.type === 'text' && x.text === 'gone' && x.styles.strike));
  assert.ok(c.some((x: any) => x.type === 'text' && x.text === 'under' && x.styles.underline));
  assert.ok(c.some((x: any) => x.type === 'text' && x.text === 'red' && x.styles.textColor === 'red'));
  assert.ok(c.some((x: any) => x.type === 'text' && x.text === 'bg' && x.styles.backgroundColor === 'blue'));
  assert.ok(c.some((x: any) => x.type === 'link' && x.href === 'https://example.com'));
  // unknown-workspace users parse as user mentions (the tool layer verifies ids); Notion pages become links
  assert.ok(c.some((x: any) => x.type === 'mention' && x.props.kind === 'user'));
  assert.ok(c.some((x: any) => x.type === 'link' && x.href === NOTION_PAGE && plain(x.content) === 'Spec'));
  const dates = c.filter((x: any) => x.type === 'mention' && x.props.kind === 'date').map((x: any) => x.props.date);
  assert.deepEqual(dates, ['2026-10-23', '2026-10-24T09:30']);
  assert.ok(warnings.some((w) => w.includes('range end')));
  assert.ok(warnings.some((w) => w.includes('time zone')));
});

test('notion: resolveUrl maps Notion pages and users to Atrium ids (importer hook)', () => {
  const resolveUrl = (url: string) =>
    url === NOTION_PAGE ? { kind: 'page' as const, id: P1, title: 'Spec' } : url === NOTION_USER ? { kind: 'user' as const, id: U1, title: 'Priya' } : null;
  const { blocks, warnings } = parse(`<mention url="${NOTION_PAGE}" /> and <mention url="${NOTION_USER}" />\n\n<page url="${NOTION_PAGE}">Spec</page>`, { resolveUrl });
  assert.deepEqual(blocks[0].content[0].props, { kind: 'page', id: P1, label: 'Spec', date: '', reminder: '' });
  assert.deepEqual(blocks[0].content[2].props, { kind: 'user', id: U1, label: 'Priya', date: '', reminder: '' });
  assert.deepEqual(blocks[1].props, { pageId: P1, title: 'Spec' });
  assert.deepEqual(warnings, []);
});

test('notion: styled HTML table with colgroup, header row and coloured cells', () => {
  const src = ['<table header-row="true">', '<colgroup>', '<col width="276" />', '<col width="289" color="gray_bg" />', '</colgroup>', '<tr>', '<td>Area</td>', '<td>Owner</td>', '</tr>', '<tr color="yellow_bg">', '<td>', 'Payments <b>core</b>', '</td>', '<td color="red">Ops<br />team</td>', '</tr>', '</table>'].join('\n');
  const { blocks } = parse(src);
  const tc = blocks[0].content;
  assert.equal(blocks[0].type, 'table');
  assert.deepEqual(tc.columnWidths, [276, 289]);
  assert.equal(tc.headerRows, 1);
  assert.deepEqual(tc.rows[1].cells[0].content, [t('Payments '), t('core', { bold: true })]);
  assert.equal(tc.rows[1].cells[0].props.backgroundColor, 'yellow');
  assert.equal(tc.rows[1].cells[1].props.textColor, 'red');
  assert.equal(tc.rows[0].cells[1].props.backgroundColor, 'gray', 'column colour applies');
  assert.deepEqual(tc.rows[1].cells[1].content, [t('Ops\nteam')]);
});

test('notion: pipe table, columns with ratio, equations, toc, media and unsupported blocks', () => {
  const src = [
    '| A | B |', '|---|---|', '| 1 | **2** |', '',
    '<columns>', '<column ratio="60">', 'Left side', '</column>', '<column ratio="40">', '- right', '</column>', '</columns>', '',
    '$$', 'a^2 + b^2 = c^2', '$$', '',
    '<table-of-contents />', '',
    '![Diagram](https://files.example.com/d.png)', '',
    '<image source="notion-file-block://abc123">Uploaded shot</image>', '',
    '<video source="https://cdn.example.com/x.mp4">Walkthrough</video>', '',
    '<unknown url="https://app.notion.com/p/abc#def" alt="external_object_instance" />', '',
    '<synced-block url="https://app.notion.com/p/abc#sync">', 'Shared paragraph', '</synced-block>',
  ].join('\n');
  const { blocks, warnings } = parse(src);
  assert.deepEqual(blocks.map((b) => b.type), ['table', 'columnList', 'equation', 'toc', 'image', 'image', 'video', 'paragraph', 'paragraph']);
  assert.equal(blocks[0].content.headerRows, 1);
  assert.deepEqual(blocks[0].content.rows[1].cells[1].content, [t('2', { bold: true })]);
  assert.deepEqual(blocks[1].children.map((c: any) => c.props.width), [60, 40]);
  assert.equal(blocks[1].children[1].children[0].type, 'bulletListItem');
  assert.equal(blocks[2].props.latex, 'a^2 + b^2 = c^2');
  assert.equal(blocks[4].props.caption, 'Diagram');
  assert.equal(blocks[6].props.caption, 'Walkthrough');
  assert.equal(blocks[7].content[0].type, 'link');
  assert.equal(plain(blocks[8].content), 'Shared paragraph');
  assert.ok(warnings.some((w) => w.includes('re-uploaded')));
  assert.ok(warnings.some((w) => w.includes('Unsupported block')));
  assert.ok(warnings.some((w) => w.includes('Synced block from outside')));
});

test('also accepts the explicit mention-page / mention-user / mention-date tags', () => {
  const { blocks } = parse(`<mention-page url="${BASE}/p/${P1}">Roadmap</mention-page> <mention-user url="${U1}">Priya</mention-user> <mention-date start="2026-12-01" end="2026-12-02" />`);
  const kinds = blocks[0].content.filter((x: any) => x.type === 'mention').map((x: any) => [x.props.kind, x.props.id || x.props.date]);
  assert.deepEqual(kinds, [['page', P1], ['user', U1], ['date', '2026-12-01']]);
});

test('plain CommonMark still works (headings, nested lists, code, quotes, links)', () => {
  const md = '# Title\n\nSome *emphasis* and `code`.\n\n- a\n  - b\n\n1. one\n2. two\n\n```js\nlet x = 1;\n```\n\n> quoted\n';
  const { blocks, warnings } = parse(md);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'bulletListItem', 'numberedListItem', 'numberedListItem', 'codeBlock', 'quote']);
  assert.equal(blocks[2].children[0].type, 'bulletListItem');
  assert.equal(blocks[5].props.language, 'js');
  assert.deepEqual(warnings, []);
});


// Regressions found in the Notion trial import (synthetic content).
test('nested tables: Notion emits <tr>/<td> lines unindented under an indented <table>', () => {
  const md = ['- Item', '\t<table header-row="true">', '\t<colgroup>', '\t<col width="93.3">', '\t<col>', '\t</colgroup>', '<tr>', '<td>A</td>', '<td>B</td>', '</tr>', '<tr>', '<td>c<br><span color="red">d</span></td>', '<td>e</td>', '</tr>', '</table>', 'After'].join('\n');
  const r = richToBlocks(md);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.blocks.length, 2);
  assert.equal(r.blocks[0].type, 'bulletListItem');
  assert.equal(r.blocks[0].children[0].type, 'table');
  assert.equal(r.blocks[0].children[0].content.rows.length, 2);
  assert.equal(r.blocks[1].content[0].text, 'After');
  blocksToDoc(r.blocks);
});

test('columns: indented <column> siblings stay columns (top level and inside a toggle heading)', () => {
  const cols = ['<columns>', '\t<column ratio="30">', '\t\t![](https://example.com/a.png)', '\t</column>', '\t<column ratio="70">', '\t\tText', '\t\t- item', '\t</column>', '</columns>'];
  const top = richToBlocks(cols.join('\n'));
  assert.equal(top.blocks[0].type, 'columnList');
  assert.equal(top.blocks[0].children.length, 2);
  assert.equal(top.blocks[0].children[1].children[1].type, 'bulletListItem');
  const nested = richToBlocks(['## Heading {toggle="true"}', ...cols.map((l) => '\t' + l), 'After'].join('\n'));
  assert.equal(nested.blocks[0].type, 'heading');
  assert.equal(nested.blocks[0].children[0].type, 'columnList');
  assert.equal(nested.blocks[0].children[0].children.length, 2);
  blocksToDoc(nested.blocks);
});

test('a mention whose label contains a line break is rejoined (Notion emits the rest unindented)', () => {
  const md = ['Parent', '\t<details>', '\t<summary>S</summary>', '\t\tLine one', '\t\t<mention-database url="https://www.notion.so/abc">Board', 'name</mention-database> and more', '\t\tLine two', '\t</details>', 'After'].join('\n');
  const r = richToBlocks(md, { lineBlocks: true, resolveUrl: () => null });
  assert.deepEqual(r.warnings.filter((w) => !/outside this workspace/.test(w)), []);
  assert.equal(r.blocks.length, 2);
  assert.equal(r.blocks[0].children[0].type, 'toggleListItem');
  assert.deepEqual(r.blocks[0].children[0].children.map((b: any) => b.type), ['paragraph', 'paragraph', 'paragraph']);
  assert.ok(JSON.stringify(r.blocks[0].children[0].children[1]).includes('Board'));
});

test('synced blocks spelled with underscores (Notion API) are recognised', () => {
  const r = richToBlocks(['<synced_block_reference url="https://www.notion.so/abc#def">', '\tShared text', '</synced_block_reference>'].join('\n'));
  assert.ok(!r.warnings.some((w) => /Stray|Unclosed/.test(w)), JSON.stringify(r.warnings));
  assert.equal(r.blocks[0].content[0].text, 'Shared text');
});

test('lineBlocks: each line inside a container is its own block; a trailing backslash still continues', () => {
  const md = ['<details>', '<summary>T</summary>', '\tOne', '\tTwo\\', '\tTwo b', '\tThree', '</details>', 'P1', 'P2'].join('\n');
  const r = richToBlocks(md, { lineBlocks: true });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.blocks.map((b: any) => b.type), ['toggleListItem', 'paragraph', 'paragraph']);
  assert.equal(r.blocks[0].children.length, 3);
  const plainMode = richToBlocks(['P1', 'P2'].join('\n'));
  assert.equal(plainMode.blocks.length, 1);
});
