export class ApiClientError extends Error {constructor(message:string,public code:string,public status:number){super(message);}}
export async function api<T>(path: string, method = 'GET', body?: unknown,signal?:AbortSignal): Promise<T> {
  const deadline=AbortSignal.timeout(30000);
  const tvShell = typeof (globalThis as {TkBoxNative?: {isTv?: () => unknown}}).TkBoxNative?.isTv === 'function';
  const headers: Record<string, string> = method === 'GET' ? {} : {'Content-Type': 'application/json', ...(tvShell ? {'X-Requested-With': 'com.tkbox.tv'} : {})};
  let r: Response;
  try {
    r = await fetch(`/api/v1${path}`, {method, signal:signal?AbortSignal.any([signal,deadline]):deadline,credentials: 'same-origin', headers, ...(method === 'GET' ? {} : {body: JSON.stringify(body ?? {})})});
  } catch (e) {
    // The app deadline, not the viewer, ended this request. A WebView reports that as the
    // unhelpful "The user aborted a request."; name the real cause instead.
    if (e instanceof Error && e.name === 'AbortError' && !signal?.aborted)
      throw new ApiClientError('The server did not answer in time. Try again.', 'REQUEST_TIMEOUT', 0);
    throw e;
  }
  // Empty (204) or non-JSON proxy errors must still surface as API errors.
  const data = r.status===204?{}:await r.json().catch(()=>({}));
  if (!r.ok) throw new ApiClientError(data.message ?? 'Request failed.',data.code??'REQUEST_FAILED',r.status);
  return data as T;
}
