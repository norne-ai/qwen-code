import { describe, expect, it, vi } from 'vitest';
import {
  autoPreviewUrlFromSearch,
  discoverAutoPreviewUrl,
  WEB_PREVIEW_CONFIG_PATH,
} from './auto-preview';

const SHELL = 'https://task.example/';
const DAEMON = 'http://127.0.0.1:4170';

function json(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('web preview auto URLs', () => {
  it('reads the preview parameter', () => {
    expect(
      autoPreviewUrlFromSearch(
        '?preview=http://127.0.0.1:3000/app?a=1',
        SHELL,
        DAEMON,
      ),
    ).toBe('http://127.0.0.1:3000/app?a=1');
  });

  it.each([
    '',
    '?preview=',
    '?other=1',
    '?preview=task.example',
    '?preview=javascript:alert(1)',
    '?preview=/relative',
    `?preview=${encodeURIComponent(`${SHELL}app`)}`,
    `?preview=${encodeURIComponent(DAEMON)}`,
  ])('ignores the unusable search %s', (search) => {
    expect(autoPreviewUrlFromSearch(search, SHELL, DAEMON)).toBeUndefined();
  });

  it('uses a host-served preview URL', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      expect(input).toBe(new URL(WEB_PREVIEW_CONFIG_PATH, SHELL).href);
      return json('{"url":"http://preview.task.example/"}');
    });
    await expect(
      discoverAutoPreviewUrl(SHELL, DAEMON, fetchImpl),
    ).resolves.toBe('http://preview.task.example/');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('takes the scheme of a bare preview host from the page itself', async () => {
    const fetchImpl = vi.fn(async () =>
      json('{"host":"preview.task.example"}'),
    );
    await expect(
      discoverAutoPreviewUrl(SHELL, DAEMON, fetchImpl),
    ).resolves.toBe('https://preview.task.example/');
  });

  it.each([
    [
      'http://task.example:5174/',
      'preview-task.example',
      'http://preview-task.example:5174/',
    ],
    [
      'https://task.example:8443/',
      'preview-task.example',
      'https://preview-task.example:8443/',
    ],
  ])(
    'keeps the port of %s for the preview host',
    async (shell, host, expected) => {
      const fetchImpl = vi.fn(async () =>
        json(`{"host":${JSON.stringify(host)}}`),
      );
      await expect(
        discoverAutoPreviewUrl(shell, DAEMON, fetchImpl),
      ).resolves.toBe(expected);
    },
  );

  it.each([
    '{"host":"task.example"}',
    '{"host":"preview task.example"}',
    '{"host":"preview-task.example."}',
    '{"host":"-bad.task.example"}',
    '{"host":42}',
    '{"other":"http://preview.task.example"}',
    '[]',
    'null',
  ])('ignores the config body %s', async (body) => {
    const fetchImpl = vi.fn(async () => json(body));
    await expect(
      discoverAutoPreviewUrl(SHELL, DAEMON, fetchImpl),
    ).resolves.toBeUndefined();
  });

  const unusable: Array<[string, () => Promise<Response>]> = [
    [
      'a missing config',
      async () => new Response('not found', { status: 404 }),
    ],
    ['a server error', async () => new Response('', { status: 500 })],
    [
      'the shell document itself',
      async () =>
        new Response('<!doctype html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    ],
    ['an empty object', async () => json('{}')],
    ['a non-string url', async () => json('{"url":42}')],
    ['the shell origin', async () => json(`{"url":"${SHELL}app"}`)],
    ['the daemon origin', async () => json(`{"url":"${DAEMON}"}`)],
    ['an unsafe scheme', async () => json('{"url":"javascript:alert(1)"}')],
    [
      'a transport failure',
      async () => {
        throw new TypeError('failed to fetch');
      },
    ],
  ];

  it.each(unusable)('ignores %s', async (_label, fetchImpl) => {
    await expect(
      discoverAutoPreviewUrl(SHELL, DAEMON, fetchImpl),
    ).resolves.toBeUndefined();
  });

  it('forwards the abort signal', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return json('{"url":"http://preview.task.example/"}');
    });
    await discoverAutoPreviewUrl(SHELL, DAEMON, fetchImpl, controller.signal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
