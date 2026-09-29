import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

let fixture: ViteDevServer;
let fixtureDir: string;
let fixtureUrl: string;

test.beforeAll(async () => {
  fixtureDir = await realpath(
    await mkdtemp(join(tmpdir(), 'qwen-auto-preview-e2e-')),
  );
  await writeFile(
    join(fixtureDir, 'index.html'),
    '<!doctype html><p id="message"></p><script type="module" src="/app.js"></script>',
  );
  await writeFile(
    join(fixtureDir, 'app.js'),
    `import { message } from './message.js';
document.querySelector('#message').textContent = message;
if (import.meta.hot) import.meta.hot.accept('./message.js', (module) => {
  document.querySelector('#message').textContent = module.message;
});`,
  );
  await writeFile(
    join(fixtureDir, 'message.js'),
    "export const message = 'Before update';",
  );
  fixture = await createServer({
    configFile: false,
    root: fixtureDir,
    logLevel: 'error',
    // This fixture is a second dev server beside the one Playwright serves the
    // shell from, and a container runs out of inotify instances quickly. Polling
    // a three-file directory keeps HMR working without the watches.
    server: { host: '127.0.0.1', port: 0, watch: { usePolling: true } },
  });
  await fixture.listen();
  const address = fixture.httpServer!.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture port');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await fixture?.close();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

// The shell asks its own origin for a preview address on load, so this is the
// host under test: its answer decides whether a session opens with a panel.
async function startSession(
  page: Page,
  testInfo: TestInfo,
  config: { url: string } | undefined,
) {
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: ['session_events', 'session_artifacts'] },
    events: [
      userTextEvent('Start the dev server.', { id: 1 }),
      assistantTextEvent('The app is running.', { id: 2 }),
      turnCompleteEvent('run-app', { id: 3 }),
    ],
  });
  // Fulfilled document responses lose their loopback address-space metadata.
  await page.context().grantPermissions(['local-network-access']);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  // Registered after the mock daemon's catch-all so this path stays ours.
  await page.route('**/__qwen-preview.json', async (route) => {
    if (!config) {
      await route.fulfill({ status: 404, body: 'no preview hostname\n' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(config),
    });
  });
  // The contract is a request the shell makes itself; asserting it here keeps a
  // missing panel from being mistaken for a routing bug. Registered before the
  // navigation because only responses that have not happened yet can be awaited.
  const asked = page.waitForResponse(
    (response) => response.url().endsWith('/__qwen-preview.json'),
    { timeout: 15_000 },
  );
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  expect((await asked.catch(() => undefined))?.status()).toBe(
    config ? 200 : 404,
  );
  return scenario;
}

function appFrame(page: Page) {
  return page
    .frameLocator('iframe[title="Web preview frame"]')
    .frameLocator('iframe[title="Application preview"]');
}

const previewPanel = (page: Page) =>
  page.locator('[data-web-shell-web-preview]:visible');

test('opens the preview panel on load at the address the host supplied', async ({
  page,
}, testInfo) => {
  await startSession(page, testInfo, { url: fixtureUrl });

  await expect(previewPanel(page)).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Development URL' }),
  ).toHaveValue(`${fixtureUrl}/`);

  // Hot reload is the reason the panel points at a dev server instead of a
  // saved page, so prove it redraws without touching the panel again.
  const app = appFrame(page);
  await expect(app.locator('#message')).toHaveText('Before update');
  await writeFile(
    join(fixtureDir, 'message.js'),
    "export const message = 'After update';",
  );
  await expect(app.locator('#message')).toHaveText('After update');
});

test('opens no panel when the host has nothing to preview', async ({
  page,
}, testInfo) => {
  await startSession(page, testInfo, undefined);
  await expect(previewPanel(page)).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Development URL' }),
  ).toHaveCount(0);
});

test('keeps a closed preview panel closed', async ({ page }, testInfo) => {
  await startSession(page, testInfo, { url: fixtureUrl });
  await expect(previewPanel(page)).toBeVisible();
  // The seeded tab is titled by its address, which is what the close button's
  // accessible name is built from.
  await page
    .getByRole('button', { name: `Close ${fixtureUrl}/`, exact: true })
    .click();
  await expect(previewPanel(page)).toHaveCount(0);

  // Later renders must not resurrect it: the seed is one attempt per session.
  const toggle = page.getByRole('button', {
    name: 'Toggle right panel',
    exact: true,
  });
  await toggle.click();
  await toggle.click();
  await expect(previewPanel(page)).toHaveCount(0);
});
