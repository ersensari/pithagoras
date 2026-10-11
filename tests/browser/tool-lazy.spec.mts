import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Lazy tools in Settings → Tools: a set or a single tool marked lazy is not in the model's list one by
 * one, and the model reaches it through the `tools` tool. Opt-in, and no switch: the mark changes
 * nothing about whether a tool is on. The marking is the server's; the page shows the mark and sends it.
 */
const tools: { name: string; source: string; noLazy?: true }[] = [
  { name: 'heavy_open', source: 'pi-heavy' },
  { name: 'heavy_read', source: 'pi-heavy' },
  { name: 'web_search', source: 'pi-web-access' },
];
/** What cannot be lazy: an MCP server's tool and one of pi's own, which the portal marks so. */
const fixed: typeof tools = [
  { name: 'notes_read', source: 'notes', noLazy: true },
  { name: 'bash', source: 'built in', noLazy: true },
];

async function portal(page: Page, { lazy = [] as string[], off = [] as string[], more = [] as typeof tools } = {}) {
  const puts: string[][] = [];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/tools' && method === 'GET') {
      const marked = (name: string, source: string) => lazy.includes(source) || lazy.includes(`<tool>${name}`);
      return { tools: [...tools, ...more].map((tool) => ({ ...tool, defaultOn: !off.includes(tool.name), ...(marked(tool.name, tool.source) ? { lazy: true } : {}) })), off, names: {}, lazy };
    }
    if (p === '/api/tools/lazy' && method === 'PUT') {
      const { lazy: wanted } = json();
      puts.push(wanted);
      return { lazy: wanted, applied: 0 };
    }
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto('/settings/tools');
  return { puts };
}

test('nothing is lazy until it is marked: no mark, every tool on', async ({ page }) => {
  await portal(page);
  await expect(page.getByRole('button', { name: /^pi-heavy/ })).toContainText('2 on');
  await expect(page.getByRole('button', { name: 'Lazy pi-heavy' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Lazy pi-web-access' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: /^pi-heavy/ }).click();
  await expect(page.getByRole('button', { name: 'Lazy heavy_open' })).toHaveAttribute('aria-pressed', 'false');
});

test('a set is marked lazy from its header and its tools stay on', async ({ page }) => {
  const { puts } = await portal(page);
  const heavy = page.getByRole('button', { name: /^pi-heavy/ });
  const mark = page.getByRole('button', { name: 'Lazy pi-heavy' });
  await mark.click();
  await expect.poll(() => puts).toEqual([['pi-heavy']]);
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  // The mark is no switch: the tools are on as they were.
  await expect(heavy).toContainText('2 on');
  await expect(mark).toHaveAttribute('title', /through the `tools` tool/);
  // The other set is not touched.
  await expect(page.getByRole('button', { name: 'Lazy pi-web-access' })).toHaveAttribute('aria-pressed', 'false');
  await heavy.click();
  for (const name of ['heavy_open', 'heavy_read']) {
    await expect(page.getByRole('button', { name: `Lazy ${name}` })).toHaveAttribute('aria-pressed', 'true');
    // A tool is lazy through its set: its own mark cannot take that back.
    await expect(page.getByRole('button', { name: `Lazy ${name}` })).toBeDisabled();
  }
});

test('a single tool is marked lazy on its own, and the mark can be taken back', async ({ page }) => {
  const { puts } = await portal(page);
  await page.getByRole('button', { name: /^pi-web-access/ }).click();
  const mark = page.getByRole('button', { name: 'Lazy web_search' });
  await mark.click();
  await expect.poll(() => puts).toEqual([['<tool>web_search']]);
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  // Its switch is as it was, and the set's mark is not set.
  await expect(page.getByRole('checkbox', { name: /web_search/ })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Lazy pi-web-access' })).toHaveAttribute('aria-pressed', 'false');
  await mark.click();
  await expect.poll(() => puts).toEqual([['<tool>web_search'], []]);
  await expect(mark).toHaveAttribute('aria-pressed', 'false');
});

test('a lazy set is shown as lazy and can be made ordinary again', async ({ page }) => {
  const { puts } = await portal(page, { lazy: ['pi-heavy'] });
  const mark = page.getByRole('button', { name: 'Lazy pi-heavy' });
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^pi-heavy/ })).toContainText('2 on');
  await mark.click();
  await expect.poll(() => puts).toEqual([[]]);
  await expect(mark).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /^pi-heavy/ })).toContainText('2 on');
});

test('an MCP server\'s tools and pi\'s own have no lazy mark to set', async ({ page }) => {
  await portal(page, { more: fixed });
  // The headers of the groups that can be lazy have it, those of the groups that cannot do not.
  await expect(page.getByRole('button', { name: 'Lazy pi-heavy' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lazy notes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lazy built in' })).toHaveCount(0);
  await page.getByRole('button', { name: /^notes/ }).click();
  await page.getByRole('button', { name: /^built in/ }).click();
  await expect(page.getByRole('checkbox', { name: /notes_read/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lazy notes_read' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lazy bash' })).toHaveCount(0);
});

test('a lazy tool carries its label in a project\'s switches, and keeps it as the switch is flipped off and on', async ({ page }) => {
  // The label is what the server says of the tool, whether the project has it on or off: a switch does not change it.
  let off: string[] = [];
  const puts: string[][] = [];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/sessions') return { sessions: [], executor: 'host' };
    if (p === '/api/projects') {
      return { root: '/w', home: '/h', projects: [{ name: 'demo', path: '/w/demo', isGit: false, hasInstructions: false, hasTools: false, sessions: 0, lastActive: null }] };
    }
    if (p === '/api/projects/demo/tools' && method === 'PUT') {
      off = json().off;
      puts.push(off);
      return { off, applied: 0 };
    }
    if (p === '/api/projects/demo/tools') {
      return {
        live: false,
        off,
        names: {},
        tools: [
          { name: 'heavy_open', source: 'pi-heavy', enabled: !off.includes('heavy_open'), defaultOn: true, lazy: true },
          { name: 'web_search', source: 'pi-web-access', enabled: !off.includes('web_search'), defaultOn: true },
        ],
      };
    }
    if (p === '/api/projects/demo/instructions') return { text: '' };
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /pi-heavy/ }).click();
  await dialog.getByRole('button', { name: /pi-web-access/ }).click();
  const label = dialog.getByText('lazy', { exact: true });
  const open = dialog.getByRole('checkbox', { name: 'heavy_open' });
  // On and lazy: the label is there, and only beside the tool that is lazy.
  await expect(open).toBeChecked();
  await expect(label).toHaveCount(1);
  await expect(open.locator('xpath=ancestor::label').getByText('lazy', { exact: true })).toBeVisible();

  await open.uncheck();
  await expect.poll(() => puts).toEqual([['heavy_open']]);
  await expect(open).not.toBeChecked();
  await expect(open.locator('xpath=ancestor::label').getByText('lazy', { exact: true })).toBeVisible();

  await open.check();
  await expect.poll(() => puts).toEqual([['heavy_open'], []]);
  await expect(open).toBeChecked();
  await expect(label).toHaveCount(1);
  // The other tool is no lazy one, whatever is flipped beside it.
  const search = dialog.getByRole('checkbox', { name: 'web_search' });
  await search.uncheck();
  await expect.poll(() => puts).toEqual([['heavy_open'], [], ['web_search']]);
  await expect(label).toHaveCount(1);
  await expect(search.locator('xpath=ancestor::label').getByText('lazy', { exact: true })).toHaveCount(0);
});
