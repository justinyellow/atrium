import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimGroups, roleFor, safeNext, syncedGroupNames } from './sso.js';
import { planSync, type CognitoUser, type LinkedUser } from './jobs/cognitoSync.js';
import { pool } from './db.js';

test.after(() => pool.end());

const roleMap = { 'atrium-admins': 'admin', 'atrium-members': 'member', 'atrium-guests': 'guest' };

test('roleFor: highest mapped role wins, else default', () => {
  assert.equal(roleFor(['atrium-guests', 'atrium-admins'], roleMap, 'member'), 'admin');
  assert.equal(roleFor(['atrium-guests', 'atrium-members'], roleMap, 'member'), 'member');
  assert.equal(roleFor(['atrium-guests'], roleMap, 'member'), 'guest');
  assert.equal(roleFor(['unrelated'], roleMap, 'member'), 'member');
  assert.equal(roleFor([], roleMap, 'guest'), 'guest');
});

test('syncedGroupNames: prefix filter strips prefix', () => {
  assert.deepEqual([...syncedGroupNames(['team-eng', 'team-fin', 'other'], 'team-')], [['team-eng', 'eng'], ['team-fin', 'fin']]);
  assert.deepEqual([...syncedGroupNames(['a', 'b'], '')], [['a', 'a'], ['b', 'b']]);
});

test('claimGroups handles arrays and strings', () => {
  assert.deepEqual(claimGroups({ 'cognito:groups': ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(claimGroups({ 'cognito:groups': 'a b' }), ['a', 'b']);
  assert.deepEqual(claimGroups({}), []);
});

test('safeNext only allows same-site paths', () => {
  assert.equal(safeNext('/p/123'), '/p/123');
  assert.equal(safeNext('//evil.com'), '/');
  assert.equal(safeNext('https://evil.com'), '/');
  assert.equal(safeNext('/\\evil.com'), '/');
  assert.equal(safeNext(undefined), '/');
});

const lu = (id: string, o: Partial<LinkedUser> = {}): LinkedUser => ({ userId: id, subject: `sub-${id}`, username: `user-${id}`, role: 'member', active: true, deactivatedBy: null, ...o });
const cu = (id: string, o: Partial<CognitoUser> = {}): CognitoUser => ({ username: `user-${id}`, sub: `sub-${id}`, enabled: true, ...o });

test('planSync: deactivates disabled and deleted users, keeps enabled ones', () => {
  const linked = [lu('1'), lu('2'), lu('3'), lu('4'), lu('5'), lu('6'), lu('7'), lu('8'), lu('9'), lu('10')];
  const users = linked.filter((l) => l.userId !== '2').map((l) => cu(l.userId, { enabled: l.userId !== '3' }));
  const plan = planSync(linked, users, new Map([['user-1', ['atrium-admins']]]), 20);
  assert.deepEqual(plan.deactivate, [{ userId: '2', reason: 'deleted' }, { userId: '3', reason: 'disabled' }]);
  assert.equal(plan.aborted, undefined);
  assert.deepEqual(plan.groups.get('1'), ['atrium-admins']);
  assert.deepEqual(plan.groups.get('4'), []);
  assert.equal(plan.groups.has('3'), false);
});

test('planSync: never touches owners', () => {
  const plan = planSync([lu('o', { role: 'owner' })], [], new Map(), 20);
  assert.equal(plan.deactivate.length, 0);
  assert.equal(plan.groups.size, 0);
});

test('planSync: reactivates only users the sync deactivated', () => {
  const plan = planSync(
    [lu('a', { active: false, deactivatedBy: 'sso' }), lu('b', { active: false, deactivatedBy: 'admin' })],
    [cu('a'), cu('b')], new Map(), 20,
  );
  assert.deepEqual(plan.reactivate, ['a']);
  assert.equal(plan.groups.has('b'), false);
});

test('planSync: matches by username when sub differs', () => {
  const plan = planSync([lu('x', { subject: 'other' })], [cu('x', { sub: 'different' })], new Map(), 20);
  assert.equal(plan.deactivate.length, 0);
});

test('planSync: aborts when too many would be deactivated (wrong pool safety)', () => {
  const linked = Array.from({ length: 20 }, (_, i) => lu(String(i)));
  const plan = planSync(linked, [], new Map(), 20); // empty pool → 20 deletions, limit 4
  assert.match(plan.aborted ?? '', /Would deactivate 20 of 20/);
});

test('planSync: small workspaces may still deactivate up to 3', () => {
  const linked = [lu('1'), lu('2'), lu('3')];
  const plan = planSync(linked, [cu('1')], new Map(), 20);
  assert.equal(plan.deactivate.length, 2);
  assert.equal(plan.aborted, undefined);
});

test('planSync: users who lost every required access group are deactivated', async () => {
  const { planSync } = await import('./jobs/cognitoSync.js');
  const linked = [
    { userId: 'u1', subject: 's1', username: 'n1', role: 'member', active: true, deactivatedBy: null },
    { userId: 'u2', subject: 's2', username: 'n2', role: 'member', active: true, deactivatedBy: null },
    { userId: 'u3', subject: 's3', username: 'n3', role: 'member', active: false, deactivatedBy: 'sso' },
  ];
  const users = [
    { sub: 's1', username: 'n1', enabled: true },
    { sub: 's2', username: 'n2', enabled: true },
    { sub: 's3', username: 'n3', enabled: true },
  ] as any;
  const membership = new Map([['n1', ['atrium@user']], ['n2', ['customer@user']], ['n3', ['atrium@admin']]]);
  const plan = planSync(linked as any, users, membership, 100, ['atrium@user', 'atrium@admin']);
  assert.deepEqual(plan.deactivate.map((d) => [d.userId, d.reason]), [['u2', 'no_access_group']]);
  assert.deepEqual(plan.reactivate, ['u3']);
});
