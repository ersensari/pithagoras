import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** The agent's ask_question dialog: every kind of question in one dialog, answered by id. */
const at = new Date().toISOString();
const chat = { id: 'a', title: 'Chat A', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };

// A conversation started on the Agent page: not in the sidebar's tasks, fetched on its own.
const agentChat = { ...chat, id: 'g', title: 'Chat G', kind: 'agent', channel_slug: 'browser' };

async function portal(page: Page) {
  const answered: any[] = [];
  await mockPortal(page, ({ path, json }) => {
    if (path === '/api/sessions') return { sessions: [chat], executor: 'host' };
    if (path === '/api/sessions/g') return agentChat;
    if (/^\/api\/sessions\/\w+$/.test(path)) return chat;
    if (path.endsWith('/ui-response')) { answered.push(json()); return { ok: true }; }
    if (path.endsWith('/config')) return { live: false, state: null, stats: null, thinking: { levels: [] }, models: { models: [] }, named: { provider: null, model: null } };
    if (path.endsWith('/canvases')) return [];
  }, { streams: 'open', settings: true });
  return { answered };
}

const questions = [
  { id: 'db', question: 'Which database?', kind: 'single', options: [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }], other: true, optional: false },
  { id: 'features', question: 'Which features?', kind: 'multiple', options: [{ label: 'Search' }, { label: 'Export' }], other: false, optional: false },
  { id: 'why', question: 'Anything else?', kind: 'text', options: [], other: false, optional: true },
  { id: 'order', question: 'Rank them', kind: 'ranking', options: [{ label: 'Speed' }, { label: 'Cost' }, { label: 'Safety' }], other: false, optional: false },
];

async function open(page: Page) {
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await page.evaluate((qs) => {
    const stream = (window as any).streams.filter((s: any) => !s.closed).at(-1);
    stream.emit('caught-up', {});
    stream.emit('message', { seq: -1, type: 'extension_ui_request', payload: { id: 'q1', method: 'questions', title: 'A few questions', questions: qs } });
  }, questions);
  const dialog = page.getByRole('dialog', { name: 'A few questions' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the questions are answered together: one, several, typed, and a ranking put in order', async ({ page }) => {
  const { answered } = await portal(page);
  const dialog = await open(page);
  const submit = dialog.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeDisabled();
  await expect(dialog.locator('select')).toHaveCount(0);

  await dialog.getByRole('radio', { name: /SQLite/ }).check();
  await expect(submit).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Export' }).check();
  await expect(submit).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Search' }).check();
  await dialog.getByRole('checkbox', { name: 'Search' }).uncheck();
  await dialog.getByRole('textbox', { name: 'Anything else?' }).fill('  soon  ');
  await dialog.getByRole('button', { name: 'Move Safety up' }).click();
  await dialog.getByRole('button', { name: 'Move Speed down' }).click();
  await expect(dialog.getByRole('button', { name: 'Move Speed up' })).toBeEnabled();
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { db: 'SQLite', features: ['Export'], why: 'soon', order: ['Safety', 'Speed', 'Cost'] } }]);
});

test('a question may be answered in the person\'s own words, and an optional one may be left', async ({ page }) => {
  const { answered } = await portal(page);
  const dialog = await open(page);
  await dialog.getByRole('textbox', { name: 'Type your own answer' }).fill('MySQL');
  await expect(dialog.getByRole('radio', { name: 'Another answer' })).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Search' }).check();
  // A ranking nobody touched is not an answer: it is the order the model listed them in.
  const submit = dialog.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeDisabled();
  await dialog.getByRole('button', { name: 'Keep this order' }).click();
  await expect(dialog.getByRole('button', { name: 'Keep this order' })).toBeHidden();
  await submit.click();
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { db: 'MySQL', features: ['Search'], order: ['Speed', 'Cost', 'Safety'] } }]);
});

test('closing the dialog answers it as cancelled', async ({ page }) => {
  const { answered } = await portal(page);
  const dialog = await open(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', cancelled: true }]);
});

test('an optional ranking may be left alone, and is then not reported as chosen', async ({ page }) => {
  const { answered } = await portal(page);
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  const optional = [{ id: 'order', question: 'Rank them', kind: 'ranking', options: [{ label: 'Speed' }, { label: 'Cost' }], other: false, optional: true }];
  await page.evaluate((qs) => {
    const stream = (window as any).streams.filter((s: any) => !s.closed).at(-1);
    stream.emit('caught-up', {});
    stream.emit('message', { seq: -1, type: 'extension_ui_request', payload: { id: 'q1', method: 'questions', title: 'A few questions', questions: qs } });
  }, optional);
  const dialog = page.getByRole('dialog', { name: 'A few questions' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Submit' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: {} }]);
});

test('moving a ranking row with the keyboard keeps the focus on the same button', async ({ page }) => {
  await portal(page);
  const dialog = await open(page);
  const down = dialog.getByRole('button', { name: 'Move Speed down' });
  await down.focus();
  await page.keyboard.press('Enter');
  // Speed is second now: the same button is still where the focus is, and it works again.
  await expect(dialog.getByRole('button', { name: 'Move Speed down' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Move Speed down' })).toBeDisabled();
  // Last in the list: the focus goes to the other arrow rather than to the page.
  await expect(dialog.getByRole('button', { name: 'Move Speed up' })).toBeFocused();
});

test('a question still waiting is back after the page is reloaded or the person comes back to the chat', async ({ page }) => {
  const { answered } = await portal(page);
  const dialog = await open(page);
  await dialog.getByRole('radio', { name: /SQLite/ }).check();
  // The server sends what is waiting before it says the stream is caught up, on every new stream.
  const resend = () => page.evaluate((qs) => {
    const stream = (window as any).streams.filter((s: any) => !s.closed).at(-1);
    stream.emit('message', { seq: -1, type: 'extension_ui_request', payload: { id: 'q1', method: 'questions', title: 'A few questions', questions: qs } });
    stream.emit('caught-up', {});
  }, questions);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await resend();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: /Postgres/ }).check();
  await dialog.getByRole('checkbox', { name: 'Search' }).check();
  await dialog.getByRole('button', { name: 'Keep this order' }).click();
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { db: 'Postgres', features: ['Search'], order: ['Speed', 'Cost', 'Safety'] } }]);
});

test('a required question whose id is an inherited object key is not answered until something is picked', async ({ page }) => {
  const { answered } = await portal(page);
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const stream = (window as any).streams.filter((s: any) => !s.closed).at(-1);
    stream.emit('caught-up', {});
    const qs = [{ id: 'constructor', question: 'Pick one', kind: 'single', options: [{ label: 'A' }, { label: 'B' }], other: false, optional: false }];
    stream.emit('message', { seq: -1, type: 'extension_ui_request', payload: { id: 'q1', method: 'questions', title: 'One question', questions: qs } });
  });
  const dialog = page.getByRole('dialog', { name: 'One question' });
  const submit = dialog.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeDisabled();
  await dialog.getByRole('radio', { name: 'B' }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { constructor: 'B' } }]);
});

test('keeping a ranking\'s order with the keyboard leaves the focus inside the dialog', async ({ page }) => {
  await portal(page);
  const dialog = await open(page);
  const keep = dialog.getByRole('button', { name: 'Keep this order' });
  await keep.focus();
  await page.keyboard.press('Enter');
  await expect(keep).toBeHidden();
  // On the first row's arrow, not on the page behind the backdrop.
  await expect(dialog.getByRole('button', { name: 'Move Speed down' })).toBeFocused();
});

test('a conversation started on the Agent page is asked in the same dialog', async ({ page }) => {
  const { answered } = await portal(page);
  await page.goto('/s/g');
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await page.evaluate((qs) => {
    const stream = (window as any).streams.filter((s: any) => !s.closed).at(-1);
    stream.emit('caught-up', {});
    stream.emit('message', { seq: -1, type: 'extension_ui_request', payload: { id: 'q1', method: 'questions', title: 'A few questions', questions: qs } });
  }, questions.slice(0, 1));
  const dialog = page.getByRole('dialog', { name: 'A few questions' });
  await dialog.getByRole('radio', { name: /Postgres/ }).check();
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { db: 'Postgres' } }]);
});

test('a run that is stopped closes the dialog on the page, and the next one opens in its place', async ({ page }) => {
  const { answered } = await portal(page);
  const dialog = await open(page);
  await page.evaluate(() => {
    const stream = (window as any).streams.filter((s: any) => !s.closed).at(-1);
    stream.emit('message', { seq: -1, type: 'extension_ui_request', payload: { id: 'c1', method: 'confirm', title: 'Sure?', message: 'Really' } });
    stream.emit('message', { seq: -1, type: 'extension_ui_cancel', payload: { id: 'q1' } });
  });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Sure?' })).toBeVisible();
  expect(answered).toEqual([]);
});

test('Settings → Tools sets how long a question waits: until answered by default, and the choice is stored', async ({ page }) => {
  const puts: any[] = [];
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/tools' && method === 'GET') return { tools: [], off: [], names: {}, questionWaitMinutes: 15 };
    if (path === '/api/ask-question' && method === 'PUT') { puts.push(json()); return { waitMinutes: json().waitMinutes }; }
  }, { settings: true });
  await page.goto('/settings/tools');
  const wait = page.getByRole('combobox', { name: 'Wait for an answer' });
  await expect(wait).toContainText('15 minutes');
  await expect(page.locator('select')).toHaveCount(0);
  await wait.click();
  await expect(page.getByRole('option')).toHaveText(['Until answered', '5 minutes', '15 minutes', '30 minutes', '60 minutes']);
  await page.getByRole('option', { name: 'Until answered' }).click();
  await expect.poll(() => puts).toEqual([{ waitMinutes: 0 }]);
  await expect(wait).toContainText('Until answered');
});

test('the wait for a question is Until answered where the portal sends none', async ({ page }) => {
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/tools' && method === 'GET') return { tools: [], off: [], names: {} };
  }, { settings: true });
  await page.goto('/settings/tools');
  await expect(page.getByRole('combobox', { name: 'Wait for an answer' })).toContainText('Until answered');
  await expect(page.locator('select')).toHaveCount(0);
});
