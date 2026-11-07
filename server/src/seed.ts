// Populates a fresh install with demo users and content through the public API.
// Usage: pnpm --filter server seed   (server must be running; set ATRIUM_URL to override)
const BASE = (process.env.ATRIUM_URL ?? 'http://localhost:3100') + '/api/v1';
let cookie = '';

async function call(method: string, path: string, body?: any) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const status = await call('GET', '/auth/status');
const owner = { name: 'Demo Owner', email: 'owner@demo.local', password: 'demo12345' };
if (status.setupRequired) await call('POST', '/auth/setup', { ...owner, workspaceName: 'Demo Co' });
else await call('POST', '/auth/login', { email: process.env.SEED_EMAIL ?? owner.email, password: process.env.SEED_PASSWORD ?? owner.password });

const tree = await call('GET', '/tree');
const general = tree.teamspaces[0].id;

for (const [name, email] of [['Priya Shah', 'priya@demo.local'], ['Marco Rossi', 'marco@demo.local'], ['Lee Chen', 'lee@demo.local']]) {
  const inv = await call('POST', '/invites', { role: 'member', email });
  const saved = cookie;
  cookie = '';
  await call('POST', '/auth/signup', { token: inv.token, name, email, password: 'demo12345' }).catch(() => {});
  cookie = saved;
}
const users = await call('GET', '/users');

const eng = await call('POST', '/teamspaces', { name: 'Engineering', icon: '🛠️', description: 'Specs, roadmaps and runbooks' });
// Add everyone else as members (the creator is already the teamspace owner — re-adding would demote them).
const me = await call('GET', '/me');
for (const u of users) if (u.id !== me.id) await call('PUT', `/teamspaces/${eng.id}/members/${u.id}`, {});

await call('POST', '/pages', {
  teamspaceId: general, title: 'Company Handbook', icon: '📘',
  markdown: `## Mission\n\nBuild tools people love.\n\n## How we work\n\n- Write things down\n- Default to transparency\n- Ship small, ship often\n\n## Time off\n\nTake the time you need. Tell your team in **#time-off**.\n`,
});

const db = await call('POST', '/pages', { teamspaceId: eng.id, title: 'Roadmap', icon: '🗺️', kind: 'database' });
const status_ = await call('POST', `/databases/${db.id}/properties`, { name: 'Status', type: 'status' });
const owner_ = await call('POST', `/databases/${db.id}/properties`, { name: 'Owner', type: 'person' });
const due = await call('POST', `/databases/${db.id}/properties`, { name: 'Due', type: 'date' });
const pts = await call('POST', `/databases/${db.id}/properties`, { name: 'Points', type: 'number' });
const pri = await call('POST', `/databases/${db.id}/properties`, {
  name: 'Priority', type: 'select',
  options: [{ id: 'p0', name: 'P0', color: 'red' }, { id: 'p1', name: 'P1', color: 'orange' }, { id: 'p2', name: 'P2', color: 'gray' }],
});
await call('POST', `/databases/${db.id}/properties`, { name: 'Effort (days)', type: 'formula', formula: { expression: 'prop("Points") * 0.5' } });
const today = new Date();
const day = (n: number) => new Date(today.getTime() + n * 864e5).toISOString().slice(0, 10);
const items = [
  ['SSO with OIDC', 1, 8, 'p0', 3, 10], ['Inline databases', 0, 13, 'p1', 7, 21], ['Mobile layout', 0, 5, 'p2', 14, 20],
  ['Webhooks', 2, 3, 'p1', -10, -2], ['Page analytics', 0, 2, 'p2', 20, 25], ['Notion import', 1, 8, 'p0', 2, 12],
];
for (const [title, s, p, prio, start, end] of items as any[]) {
  await call('POST', `/databases/${db.id}/rows`, {
    title,
    props: {
      [status_.id]: status_.options[s].id,
      [owner_.id]: [users[Math.floor(Math.random() * users.length)].id],
      [due.id]: { start: day(start), end: day(end) },
      [pts.id]: p,
      [pri.id]: prio,
    },
  });
}
await call('POST', `/databases/${db.id}/views`, { name: 'Board', type: 'board', config: { groupBy: status_.id } });
await call('POST', `/databases/${db.id}/views`, { name: 'Timeline', type: 'timeline', config: { timelineBy: due.id } });
await call('POST', `/databases/${db.id}/views`, { name: 'Calendar', type: 'calendar', config: { calendarBy: due.id } });

await call('POST', '/pages', {
  teamspaceId: eng.id, title: 'On-call runbook', icon: '🚨',
  markdown: `## When paged\n\n1. Acknowledge within 5 minutes\n2. Check the dashboards\n3. Post in the incident channel\n\n\`\`\`bash\nkubectl get pods -n prod\n\`\`\`\n`,
});
console.log(`Seeded. Log in as ${owner.email} / ${owner.password} (other users: priya@, marco@, lee@demo.local / demo12345)`);
