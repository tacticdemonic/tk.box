import { delimiter, isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';

const optionalText = (value: z.ZodString) => z.preprocess(input => typeof input === 'string' && !input.trim() ? undefined : input, value.optional());
const schema = z.object({
  APP_HOST: z.string().default('127.0.0.1').refine(v => isIP(v) !== 0 || v === 'localhost', 'Use an IP address or localhost'),
  APP_PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  APP_ORIGIN: optionalText(z.string().url()),
  DEPLOYMENT_MODE: z.enum(['local', 'remote']).default('local'),
  PUBLIC_BASE_URL: optionalText(z.string().url()),
  CSRF_DIAGNOSTICS: z.string().default('false').transform(value => value === 'true' || value === '1'),
  DATA_DIR: z.string().default('./data'),
  CACHE_DIR: z.string().default('./data/cache'),
  SECRET_KEY_FILE: optionalText(z.string()),
  INITIAL_ADMIN_TOKEN: optionalText(z.string().min(16).max(256)),
  PLEX_URL: z.string().url().default('http://127.0.0.1:32400'),
  PLEX_MACHINE_ID: optionalText(z.string().min(1)),
  PLEX_OWNER_ACCOUNT_ID: optionalText(z.string().regex(/^\d+$/)),
  PLEX_REQUIRED_LIBRARY_IDS: z.string().default(''),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  FFMPEG_PATH: z.string().default('ffmpeg'), FFPROBE_PATH: z.string().default('ffprobe'),
  SEGMENT_CACHE_MAX_BYTES: z.coerce.number().int().min(1048576).default(2147483648),
  // Same-host mode: absolute local directories media parts may be read from, separated like PATH.
  MEDIA_ROOTS: z.string().default(''),
  // Optional Plex path prefix → local path prefix pairs for Docker, e.g. /movies=/srv/media/movies.
  PLEX_PATH_MAP: z.string().default(''),
  // Sports events. Comma-separated ESPN sport/league paths and TheSportsDB league IDs; empty uses the defaults.
  SPORTS_ESPN_LEAGUES: z.string().default(''),
  SPORTS_TSDB_LEAGUES: z.string().default(''),
  THESPORTSDB_API_KEY: z.string().regex(/^[\w-]+$/).default('123'),
  // Zone assumed for times written in channel names without one ("8PM").
  SPORTS_NAME_TIMEZONE: z.string().default('America/New_York').refine(zone => { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; } }, 'Use an IANA time zone')
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  const publicUrl = c.PUBLIC_BASE_URL ? parseOrigin(c.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL', true) : undefined;
  const appUrl = c.APP_ORIGIN ? parseOrigin(c.APP_ORIGIN, 'APP_ORIGIN', false) : undefined;
  if (publicUrl && appUrl && publicUrl.origin !== appUrl.origin) throw new Error('APP_ORIGIN and PUBLIC_BASE_URL must match when both are set');
  if (c.DEPLOYMENT_MODE === 'remote' && !publicUrl) throw new Error('Remote deployment requires PUBLIC_BASE_URL');
  const p = new URL(c.PLEX_URL);
  if (!['http:', 'https:'].includes(p.protocol) || p.username || p.password || p.pathname !== '/' || p.search || p.hash) throw new Error('PLEX_URL must be an HTTP(S) origin without credentials');
  const trustedProxies = c.TRUSTED_PROXY_CIDRS.split(',').map(s => s.trim()).filter(Boolean);
  for (const cidr of trustedProxies) {
    const [ip, mask] = cidr.split('/');
    const family = isIP(ip ?? '');
    if (!family || (mask !== undefined && (!/^\d+$/.test(mask) || Number(mask) > (family === 4 ? 32 : 128)))) throw new Error('Invalid trusted proxy IP/CIDR');
  }
  const list = (value: string) => value.split(delimiter).map(s => s.trim()).filter(Boolean);
  const mediaRoots = list(c.MEDIA_ROOTS), pathMap = list(c.PLEX_PATH_MAP).map(entry => {
    const at = entry.indexOf('='), from = entry.slice(0, at).trim(), to = entry.slice(at + 1).trim();
    if (at < 1 || !from || !isAbsolute(to)) throw new Error('PLEX_PATH_MAP entries must be plexPrefix=absoluteLocalPrefix');
    return { from, to: resolve(to) };
  });
  if (mediaRoots.some(root => !isAbsolute(root))) throw new Error('MEDIA_ROOTS must list absolute directories');
  if (pathMap.length && !mediaRoots.length) throw new Error('PLEX_PATH_MAP requires MEDIA_ROOTS');
  const plexConfigured = !!(c.PLEX_MACHINE_ID && c.PLEX_OWNER_ACCOUNT_ID && c.PLEX_REQUIRED_LIBRARY_IDS.trim());
  // A listener on a LAN address is reachable from other devices whatever DEPLOYMENT_MODE says,
  // so that, not the label, decides whether the first administrator needs an owner token.
  const listenOrigin = new URL(`http://${c.APP_HOST.includes(':') ? `[${c.APP_HOST}]` : c.APP_HOST}:${c.APP_PORT}`).origin;
  const browserOrigin = publicUrl?.origin ?? appUrl?.origin ?? listenOrigin;
  const wildcardBind = isWildcardHost(c.APP_HOST);
  const unconfiguredWildcardOrigin = wildcardBind && !publicUrl && !appUrl;
  const loopbackOnly = isLoopbackHost(c.APP_HOST) && (!appUrl || isLoopbackHost(appUrl.hostname)) && !publicUrl;
  const exposed = c.DEPLOYMENT_MODE === 'remote' || !!publicUrl || !loopbackOnly;
  if (!plexConfigured && exposed && !c.INITIAL_ADMIN_TOKEN) throw new Error('Public, remote or non-loopback deployment without Plex requires INITIAL_ADMIN_TOKEN');
  return { ...c,
    PUBLIC_BASE_URL: publicUrl?.origin,
    APP_ORIGIN: appUrl?.origin,
    DATA_DIR: resolve(c.DATA_DIR), CACHE_DIR: resolve(c.CACHE_DIR), trustedProxies,
    requiredLibraries: c.PLEX_REQUIRED_LIBRARY_IDS.split(',').map(v => v.trim()).filter(Boolean),
    secureCookies: !!publicUrl || !!appUrl?.https,
    localMedia: mediaRoots.length ? { roots: mediaRoots.map(root => resolve(root)), pathMap } : undefined,
    plexConfigured,
    loopbackOnly,
    wildcardBind,
    unconfiguredWildcardOrigin,
    listenHost: c.APP_HOST,
    listenPort: c.APP_PORT,
    publicOrigin: publicUrl?.origin,
    appOrigin: appUrl?.origin,
    browserOrigin
  };
}
export type Config = ReturnType<typeof loadConfig>;

/** True only for addresses that cannot be reached from another device. */
export function isLoopbackHost(host: string) {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(name);
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped?.[1] ?? name);
}

/** True for 0.0.0.0 / :: wildcard bind addresses, which are never valid browser Origins. */
export function isWildcardHost(host: string) {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return name === '0.0.0.0' || name === '::' || name === '::ffff:0.0.0.0' || /^0(?::0){7}$/.test(name);
}

function parseOrigin(raw: string, label: string, httpsOnly: boolean) {
  const u = new URL(raw);
  const allowed = httpsOnly ? ['https:'] : ['http:', 'https:'];
  if (!allowed.includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash || isWildcardHost(u.hostname)) {
    throw new Error(`${label} must be ${httpsOnly ? 'an HTTPS' : 'a specific HTTP(S)'} origin`);
  }
  return { origin: u.origin, hostname: u.hostname.replace(/^\[|\]$/g, ''), https: u.protocol === 'https:' };
}
