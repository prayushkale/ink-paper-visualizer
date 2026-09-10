import { createFalClient, type FalClient, type RequestMiddleware } from '@fal-ai/client';

/**
 * The fal client, pointed at our own proxy. FAL_KEY never reaches the browser:
 * the proxy injects it and the client only ever names the upstream URL.
 */
export const FAL_PROXY_URL = '/api/fal/proxy';

let proxyToken: string | null = null;

/**
 * When the server sets PROXY_AUTH_TOKEN the browser must echo it. Kept out of
 * settings so it can never be persisted into a shared link.
 */
export function setProxyToken(token: string | null): void {
  proxyToken = token && token.trim() !== '' ? token.trim() : null;
}

export function getProxyToken(): string | null {
  return proxyToken;
}

const injectToken: RequestMiddleware = async (request) => {
  if (!proxyToken) return request;
  return {
    ...request,
    headers: { ...(request.headers ?? {}), 'x-ink-token': proxyToken },
  };
};

export const fal: FalClient = createFalClient({
  proxyUrl: FAL_PROXY_URL,
  requestMiddleware: injectToken,
  // The browser has no credentials of its own, and must never look for one:
  // an explicit resolver that always returns nothing keeps the client's
  // process.env lookup path out of the bundle entirely. The proxy attaches
  // FAL_KEY on the server side.
  credentials: () => undefined,
  suppressLocalCredentialsWarning: true,
});

/** Hosts a blot or a rendered frame with fal so the model can fetch it. */
export async function uploadFile(file: Blob, filename?: string): Promise<string> {
  const named = filename && !(file instanceof File)
    ? new File([file], filename, { type: file.type || 'image/png' })
    : file;
  return fal.storage.upload(named);
}
