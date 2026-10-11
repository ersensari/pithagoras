import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Lazy tool sets in Settings → Tools: a set marked lazy is off in every conversation until one
 * switches it on. The marking is the server's (it puts the set's tools in the default as off);
 * the page shows the mark and what the answer changed.
 */
const tools = [
  { name: 'heavy_open', source: 'pi-heavy' },
  { name: 'heavy_read', source: 'pi-heavy' },
  { name: 'web_search', source: 'pi-web-access' },
];

async function portal(page: Page, { lazy = [] as string[], off = [] as string[] } = {}) {
  const puts: string[][] = [];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/tools' && method === 'GET') return { tools: tools.map((tool) => ({ ...tool, defaultOn: !off.includes(tool.name) })), off, names: {}, lazy };
    if (p === '/api/tools/lazy' && method === 'PUT') {
      const { lazy: wanted } = json();
      puts.push(wanted);
      // What the server does with a set that becomes lazy: its tools go into the default as off.
      const names = wanted.includes('pi-heavy') ? ['heavy_open', 'heavy_read'] : off;
      return { lazy: wanted, off: names, applied: 0 };
    }
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto('/settings/tools');
  return { puts };
}

test('a set is marked lazy from its header, and its tools show as off', async ({ page }) => {
  const { puts } = await portal(page);
  const heavy = page.getByRole('button', { name: /^pi-heavy/ });
  await expect(heavy).toContainText('2 on');
  const mark = page.getByRole('button', { name: 'Lazy pi-heavy' });
  await expect(mark).toHaveAttribute('aria-pressed', 'false');
  await mark.click();
  await expect.poll(() => puts).toEqual([['pi-heavy']]);
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  await expect(heavy).toContainText('2 off');
  // The other set is not touched.
  await expect(page.getByRole('button', { name: /^pi-web-access/ })).toContainText('1 on');
  await expect(page.getByRole('button', { name: 'Lazy pi-web-access' })).toHaveAttribute('aria-pressed', 'false');
});

test('a lazy set is shown as lazy and can be made ordinary again', async ({ page }) => {
  const { puts } = await portal(page, { lazy: ['pi-heavy'], off: ['heavy_open', 'heavy_read'] });
  const mark = page.getByRole('button', { name: 'Lazy pi-heavy' });
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^pi-heavy/ })).toContainText('2 off');
  await mark.click();
  await expect.poll(() => puts).toEqual([[]]);
  await expect(mark).toHaveAttribute('aria-pressed', 'false');
  // Ending it leaves the switches as they were.
  await expect(page.getByRole('button', { name: /^pi-heavy/ })).toContainText('2 off');
});
