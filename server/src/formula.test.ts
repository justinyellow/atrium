import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRowFormula, evalFormula, parseFormula, formatDateTokens, type FormulaContext, type FormulaProp, type FormulaRow } from './formula.js';

const NOW = new Date('2026-11-05T14:30:00Z');

const schema: FormulaProp[] = [
  { id: 'title', name: 'Name', type: 'title' },
  { id: 'pts', name: 'Points', type: 'number', notion_id: 'BtVS' },
  { id: 'qty', name: 'Qty', type: 'number' },
  { id: 'empty', name: 'Blank', type: 'number' },
  { id: 'note', name: 'Note', type: 'text' },
  { id: 'done', name: 'Done', type: 'checkbox' },
  { id: 'st', name: 'Status', type: 'status', options: [{ id: 's1', name: 'Not started' }, { id: 's2', name: 'Done' }] },
  { id: 'pri', name: 'Priority', type: 'select', options: [{ id: 'p0', name: 'P0' }, { id: 'p1', name: 'P1' }] },
  { id: 'tags', name: 'Tags', type: 'multi_select', options: [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }, { id: 'c', name: 'gamma' }] },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'span', name: 'Span', type: 'date' },
  { id: 'who', name: 'Owner', type: 'person' },
  { id: 'rel', name: 'Tasks', type: 'relation' },
  { id: 'cb', name: 'Created by', type: 'created_by' },
  { id: 'ct', name: 'Created', type: 'created_time' },
  { id: 'dbl', name: 'Double', type: 'formula', formula: { expression: 'prop("Points") * 2' } },
  { id: 'loop', name: 'Loop', type: 'formula', formula: { expression: 'prop("Loop") + 1' } },
  { id: 'roll', name: 'Total', type: 'rollup' },
];
const taskSchema: FormulaProp[] = [
  { id: 'title', name: 'Name', type: 'title' },
  { id: 'tp', name: 'Points', type: 'number' },
  { id: 'td', name: 'Done', type: 'checkbox' },
  { id: 'tf', name: 'Half', type: 'formula', formula: { expression: 'prop("Points") / 2' } },
];
const tasks: Record<string, FormulaRow> = {
  t1: { id: 't1', title: 'Write spec', props: { tp: 3, td: true } },
  t2: { id: 't2', title: 'Build', props: { tp: 8, td: false } },
  t3: { id: 't3', title: 'Ship', props: { tp: 5, td: true } },
};
const row: FormulaRow = {
  id: 'row-1',
  title: 'Launch',
  props: {
    pts: 8, qty: 3, note: 'Hello World', done: true, st: 's2', pri: 'p1', tags: ['a', 'c'],
    due: { start: '2026-11-20' }, span: { start: '2026-11-01', end: '2026-11-10' },
    who: ['u1', 'u2'], rel: ['t1', 't2', 't3'],
  },
  created_at: '2026-01-15T09:05:00Z',
  created_by: 'u1',
  computed: { roll: 16 },
};
const ctx: FormulaContext = {
  schema,
  users: new Map([['u1', { id: 'u1', name: 'Ada Lovelace', email: 'ada@x.io' }], ['u2', { id: 'u2', name: 'Alan Turing', email: 'alan@x.io' }]]),
  getRow: (id) => tasks[id],
  schemaForRow: (id) => (tasks[id] ? taskSchema : undefined),
  now: NOW,
};
const f = (expr: string) => evaluateRowFormula(expr, row, ctx);
const errOf = (expr: string) => {
  const r = f(expr);
  assert.ok(r && typeof r === 'object' && 'error' in r, `expected error for ${expr}, got ${JSON.stringify(r)}`);
  return r.error as string;
};
const cases: [string, any][] = [
  // literals & operators
  ['1 + 2 * 3', 7],
  ['(1 + 2) * 3', 9],
  ['2 ^ 3 ^ 2', 512],
  ['-2 ^ 2', -4],
  ['10 % 4', 2],
  ['7 / 2', 3.5],
  ['1 / 0', null],
  ['"a" + "b"', 'ab'],
  ['"n=" + 5', 'n=5'],
  ['\'single\' + "double"', 'singledouble'],
  ['"say \\"hi\\"\\n"', 'say "hi"\n'],
  ['true and false', false],
  ['true or false', true],
  ['not true', false],
  ['!false && true', true],
  ['1 == 1', true],
  ['1 != 2', true],
  ['"b" > "a"', true],
  ['3 >= 3', true],
  ['2 <= 1', false],
  ['1 < 2 ? "yes" : "no"', 'yes'],
  ['[1, 2, 3]', [1, 2, 3]],
  ['[]', []],
  ['/* comment */ 1 + /* inline */ 1', 2],
  ['1 +\n  2 // trailing\n', 3],
  ['[1, 2, 3][1]', 2],
  // props
  ['prop("Points") * 2', 16],
  ['prop("Points") * 0.5', 4],
  ['{{notion:block_property:BtVS:00000000-0000-0000-0000-000000000000:8994905a-074a-415f-9bcf-d1f8b4fa38e4}}/2', 4],
  ['{{notion:block_property:pts:abc}} + 1', 9],
  ['prop("points")', 8],
  ['prop("Name")', 'Launch'],
  ['prop("Note").length()', 11],
  ['prop("Done")', true],
  ['prop("Status")', 'Done'],
  ['prop("Priority") == "P1"', true],
  ['prop("Tags")', ['alpha', 'gamma']],
  ['prop("Tags").map(current + "!")', ['alpha!', 'gamma!']],
  ['prop("Tags").includes("gamma")', true],
  ['prop("Blank")', null],
  ['prop("Blank") + 1', 1],
  ['empty(prop("Blank"))', true],
  ['prop("Blank").empty()', true],
  ['prop("Double") + 1', 17],
  ['prop("Total") * 2', 32],
  // text
  ['length("hello")', 5],
  ['"hello".length()', 5],
  ['substring("hello", 1, 3)', 'el'],
  ['"hello".substring(2)', 'llo'],
  ['contains("hello", "ell")', true],
  ['test("abc123", "\\\\d+")', true],
  ['match("a1b22c333", "\\\\d+")', ['1', '22', '333']],
  ['replace("a-b-c", "-", "+")', 'a+b-c'],
  ['replaceAll("a-b-c", "-", "+")', 'a+b+c'],
  ['replaceAll("x.y.z", "\\\\.", "/")', 'x/y/z'],
  ['lower("ABC")', 'abc'],
  ['upper("abc")', 'ABC'],
  ['repeat("ab", 3)', 'ababab'],
  ['padStart("7", 3, "0")', '007'],
  ['padEnd("7", 3, "-")', '7--'],
  ['link("Docs", "https://x.io")', 'Docs'],
  ['style("Hi", "b", "red")', 'Hi'],
  ['unstyle("Hi")', 'Hi'],
  ['format(42)', '42'],
  ['format(true)', 'true'],
  ['toNumber("42.5")', 42.5],
  ['toNumber(true)', 1],
  ['"1,234".toNumber()', 1234],
  ['split("a,b,c", ",")', ['a', 'b', 'c']],
  ['trim("  x  ")', 'x'],
  ['concat("a", "b", "c")', 'abc'],
  ['concat([1], [2, 3])', [1, 2, 3]],
  ['join(["a", "b"], "-")', 'a-b'],
  // numbers
  ['add(2, 3)', 5],
  ['subtract(5, 3)', 2],
  ['multiply(4, 2.5)', 10],
  ['divide(9, 3)', 3],
  ['pow(2, 10)', 1024],
  ['mod(10, 3)', 1],
  ['abs(-4)', 4],
  ['round(2.5)', 3],
  ['round(3.14159, 2)', 3.14],
  ['ceil(1.2)', 2],
  ['floor(1.8)', 1],
  ['sqrt(16)', 4],
  ['cbrt(27)', 3],
  ['round(exp(1), 4)', 2.7183],
  ['ln(e())', 1],
  ['log10(1000)', 3],
  ['log2(8)', 3],
  ['sign(-3)', -1],
  ['round(pi(), 2)', 3.14],
  ['min(3, 1, 2)', 1],
  ['max([3, 9], 4)', 9],
  ['sum(1, 2, 3)', 6],
  ['[1, 2, 3, 4].sum()', 10],
  ['median([5, 1, 3])', 3],
  ['median([1, 2, 3, 4])', 2.5],
  ['mean([2, 4, 6])', 4],
  // dates
  ['formatDate(prop("Due"), "MMMM D, YYYY")', 'November 20, 2026'],
  ['formatDate(prop("Due"), "YYYY-MM-DD")', '2026-11-20'],
  ['formatDate(now(), "h:mm A")', '2:30 PM'],
  ['formatDate(now(), "dddd, MMM Do [at] HH:mm")', 'Thursday, Nov 5th at 14:30'],
  ['now()', '2026-11-05T14:30:00.000Z'],
  ['today()', '2026-11-05T00:00:00.000Z'],
  ['minute(now())', 30],
  ['hour(now())', 14],
  ['day(now())', 4],
  ['day(parseDate("2026-11-08"))', 7],
  ['date(prop("Due"))', 20],
  ['week(parseDate("2026-01-01"))', 1],
  ['month(prop("Due"))', 11],
  ['year(prop("Due"))', 2026],
  ['dateAdd(prop("Due"), 2, "days")', '2026-11-22T00:00:00.000Z'],
  ['dateAdd(parseDate("2026-01-31"), 1, "months")', '2026-02-28T00:00:00.000Z'],
  ['dateSubtract(prop("Due"), 1, "years")', '2025-11-20T00:00:00.000Z'],
  ['dateBetween(prop("Due"), now(), "days")', 14],
  ['dateBetween(parseDate("2026-03-01"), parseDate("2026-01-15"), "months")', 1],
  ['dateBetween(prop("Due"), today(), "weeks")', 2],
  ['prop("Span")', { start: '2026-11-01T00:00:00.000Z', end: '2026-11-10T00:00:00.000Z' }],
  ['dateEnd(prop("Span"))', '2026-11-10T00:00:00.000Z'],
  ['dateStart(prop("Span"))', '2026-11-01T00:00:00.000Z'],
  ['dateBetween(dateEnd(prop("Span")), dateStart(prop("Span")), "days")', 9],
  ['dateRange(parseDate("2026-01-01"), parseDate("2026-01-05"))', { start: '2026-01-01T00:00:00.000Z', end: '2026-01-05T00:00:00.000Z' }],
  ['timestamp(parseDate("2026-01-01"))', Date.UTC(2026, 0, 1)],
  ['fromTimestamp(0)', '1970-01-01T00:00:00.000Z'],
  ['prop("Due") > now()', true],
  ['prop("Due") == parseDate("2026-11-20")', true],
  ['prop("Created").formatDate("YYYY")', '2026'],
  ['format(prop("Due"))', 'November 20, 2026'],
  // lists & lambdas
  ['[3, 1, 2].sort()', [1, 2, 3]],
  ['sort(["b", "c", "a"])', ['a', 'b', 'c']],
  ['[1, 2, 3].reverse()', [3, 2, 1]],
  ['at([10, 20, 30], 1)', 20],
  ['[10, 20, 30].at(-1)', 30],
  ['first([4, 5])', 4],
  ['last([4, 5])', 5],
  ['[1, 2, 2, 3, 1].unique()', [1, 2, 3]],
  ['[[1, 2], [3, [4]]].flat()', [1, 2, 3, 4]],
  ['[1, 2, 3, 4].filter(current > 2)', [3, 4]],
  ['[1, 2, 3].map(current * index)', [0, 2, 6]],
  ['[1, 2, 3].find(current > 1)', 2],
  ['[1, 2, 3].findIndex(current == 3)', 2],
  ['[1, 2, 3].some(current > 2)', true],
  ['[1, 2, 3].every(current > 0)', true],
  ['[1, 2, 3, 4].count(current % 2 == 0)', 2],
  ['[1, "", 3].count()', 2],
  ['[1, 2, 3, 4].slice(1, 3)', [2, 3]],
  ['[1, 2, 3].map(current * 2).filter(current > 2).sum()', 10],
  ['["a", "b"].map(upper(current)).join("")', 'AB'],
  ['[[1, 2], [3]].map(current.sum())', [3, 3]],
  ['[3, 1, 2].sort(0 - current)', [3, 2, 1]],
  ['[1, 2] + [3]', [1, 2, 3]],
  // let/lets & logic
  ['let(x, 5, x * x)', 25],
  ['lets(a, 2, b, a + 3, a * b)', 10],
  ['let(total, prop("Points") + prop("Qty"), if(total > 10, "big", "small"))', 'big'],
  ['if(prop("Done"), "✅", "⏳")', '✅'],
  ['if(false, 1)', null],
  ['ifs(prop("Points") > 10, "high", prop("Points") > 5, "medium", "low")', 'medium'],
  ['ifs(false, 1, false, 2)', null],
  ['and(true, 1 > 0, "x")', true],
  ['or(false, 0, "")', false],
  ['not(empty("x"))', true],
  ['equal(1, 1)', true],
  ['false and (1 / 0 > 0)', false],
  // people, pages, id
  ['prop("Owner").map(current.name())', ['Ada Lovelace', 'Alan Turing']],
  ['prop("Owner").first().email()', 'ada@x.io'],
  ['name(prop("Created by"))', 'Ada Lovelace'],
  ['prop("Owner")', [{ id: 'u1', name: 'Ada Lovelace' }, { id: 'u2', name: 'Alan Turing' }]],
  ['id()', 'row-1'],
  ['prop("Tasks").length()', 3],
  ['prop("Tasks").map(current.prop("Points")).sum()', 16],
  ['prop("Tasks").filter(current.prop("Done")).map(current.prop("Name"))', ['Write spec', 'Ship']],
  ['prop("Tasks").map(current.prop("Half"))', [1.5, 4, 2.5]],
  ['prop("Tasks").first()', { id: 't1', title: 'Write spec' }],
  ['prop("Tasks").first().id()', 't1'],
  ['format(prop("Tasks"))', 'Write spec, Build, Ship'],
  ['prop("Tasks").prop("Points")', [3, 8, 5]],
  ['prop("Tasks").map(current.prop("Points")).max()', 8],
];

for (const [expr, expected] of cases) {
  test(`formula: ${expr.replace(/\n/g, '\\n')}`, () => {
    assert.deepEqual(f(expr), expected);
  });
}

test('errors: unknown property', () => assert.match(errOf('prop("Nope")'), /Unknown property "Nope"/));
test('errors: unknown function', () => assert.match(errOf('frobnicate(1)'), /Unknown function frobnicate/));
test('errors: syntax', () => assert.match(errOf('1 +'), /end/));
test('errors: unbalanced', () => assert.match(errOf('(1 + 2'), /Expected "\)"/));
test('errors: bad character', () => assert.match(errOf('1 # 2'), /Unexpected character/));
test('errors: type mismatch', () => assert.match(errOf('"abc" * 2'), /expects a number/));
test('errors: current outside lambda', () => assert.match(errOf('current + 1'), /inside a list function/));
test('errors: circular formula', () => assert.match(errOf('prop("Loop")'), /Circular reference/));
test('errors: unterminated string', () => assert.match(errOf('"abc'), /Unterminated string/));
test('errors: date expected', () => assert.match(errOf('year(5)'), /expects a date/));
test('errors: bad date unit', () => assert.match(errOf('dateAdd(now(), 1, "fortnights")'), /Unknown date unit/));
test('errors: unknown property on related page', () => assert.match(errOf('prop("Tasks").map(current.prop("Nope"))'), /Unknown property "Nope"/));
test('errors: let misuse', () => assert.match(errOf('let(1, 2, 3)'), /variable name/));
test('empty formula returns null', () => assert.equal(f(''), null));

test('back-compat evalFormula(name getter)', () => {
  const ast = parseFormula('prop("Points") * 2 + length(prop("Note"))');
  assert.equal(evalFormula(ast, (n) => (n === 'Points' ? 5 : 'abc')), 13);
});

test('formatDateTokens covers common tokens', () => {
  const d = new Date('2026-03-01T09:07:05Z');
  assert.equal(formatDateTokens(d, 'YY/M/D H:m:s a'), '26/3/1 9:7:5 am');
  assert.equal(formatDateTokens(d, 'ddd DD MMM, hh:mm:ss A'), 'Sun 01 Mar, 09:07:05 AM');
  assert.equal(formatDateTokens(new Date('2026-01-11T00:00:00Z'), 'Do'), '11th');
  assert.equal(formatDateTokens(new Date('2026-01-22T00:00:00Z'), 'Do'), '22nd');
});
