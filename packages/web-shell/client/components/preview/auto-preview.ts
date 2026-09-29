import { parseWebPreviewUrl } from './web-preview';

/**
 * Same-origin location a host can point the Web preview tab at when a session
 * opens, so the user does not have to type the development address. The host
 * answers with either a full `url`, or a bare `host` whose scheme and port are
 * taken from the page asking — correct when a proxy hop between the browser and
 * the shell rewrites the forwarded protocol. Absent, unreachable or malformed
 * responses are ignored.
 */
export const WEB_PREVIEW_CONFIG_PATH = '/__qwen-preview.json';

/** Override for a single shell load, e.g. `?preview=http://localhost:3000`. */
export const WEB_PREVIEW_SEARCH_PARAM = 'preview';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function daemonOrigin(shellUrl: string, daemonUrl: string): string {
  return daemonUrl || shellUrl;
}

// A bare hostname gets the asking page's scheme and port: the shell and its
// preview are served by the same front door, so whatever the browser reached
// the shell over reaches the preview too.
function followShellLocation(host: string, shell: URL): string | undefined {
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(host)) return undefined;
  const port = shell.port ? `:${shell.port}` : '';
  return `${shell.protocol}//${host}${port}`;
}

function autoPreviewUrlFromConfig(
  value: unknown,
  shellUrl: string,
  daemonUrl: string,
): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { url, host } = value as { url?: unknown; host?: unknown };
  const candidate =
    typeof url === 'string'
      ? url
      : typeof host === 'string'
        ? followShellLocation(host, new URL(shellUrl))
        : undefined;
  if (!candidate) return undefined;
  return parseWebPreviewUrl(
    candidate,
    shellUrl,
    daemonOrigin(shellUrl, daemonUrl),
  )?.href;
}

export function autoPreviewUrlFromSearch(
  search: string,
  shellUrl: string,
  daemonUrl: string,
): string | undefined {
  const raw = new URL(search, shellUrl).searchParams.get(
    WEB_PREVIEW_SEARCH_PARAM,
  );
  if (!raw) return undefined;
  return parseWebPreviewUrl(raw, shellUrl, daemonOrigin(shellUrl, daemonUrl))
    ?.href;
}

export async function discoverAutoPreviewUrl(
  shellUrl: string,
  daemonUrl: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(
      new URL(WEB_PREVIEW_CONFIG_PATH, shellUrl).href,
      { credentials: 'same-origin', cache: 'no-store', signal },
    );
    if (!response.ok) return undefined;
    return autoPreviewUrlFromConfig(await response.json(), shellUrl, daemonUrl);
  } catch {
    return undefined;
  }
}
