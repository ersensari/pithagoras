import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** The agent's ask_question dialog: every kind of question in one dialog, answered by id. */
const at = new Date().toISOString();
const chat = { id: 'a', title: 'Chat A', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };

async function portal(page: Page) {
  const answered: any[] = [];
  await mockPortal(page, ({ path, json }) => {
    if (path === '/api/sessions') return { sessions: [chat], executor: 'host' };
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

  await dialog.getByRole('radio', { name: /SQLite/ }).check();
  await expect(submit).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Export' }).check();
  await expect(submit).toBeEnabled();
  await dialog.getByRole('checkbox', { name: 'Search' }).check();
  await dialog.getByRole('checkbox', { name: 'Search' }).uncheck();
  await dialog.getByRole('textbox', { name: 'Anything else?' }).fill('  soon  ');
  await dialog.getByRole('button', { name: 'Move Safety up' }).click();
  await dialog.getByRole('button', { name: 'Move Speed down' }).click();
  await expect(dialog.getByRole('button', { name: 'Move Speed up' })).toBeEnabled();

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
  await dialog.getByRole('button', { name: 'Submit' }).click();
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
