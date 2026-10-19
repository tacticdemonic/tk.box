import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, requireThat } from './errors.js';
import { xtreamAccess, xtreamAccountCreate, xtreamAccountUpdate, type XtreamStore } from './persistence/xtream-store.js';
import type { XtreamService } from './services/xtream-service.js';
import { cataloguePage } from './providers/xtream.js';

type Access = (req: FastifyRequest) => Promise<{grant: {accountId: string; role?: string}}>;

const id = z.string().uuid();
const create = xtreamAccountCreate.extend({validate: z.boolean().default(true)}).strict();
const page = z.object({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  categoryId: z.string().max(64).optional(),
  q: z.string().trim().max(120).default('')
}).strict();

// Xtream surface. Provider accounts are a resource, so every viewer route authorises through
// `xtream_access`, while account management is limited to an administrator or the account's
// owner. No route returns a username, password or stream address.
export function registerXtream(app: FastifyInstance, store: XtreamStore, service: XtreamService, admin: Access, viewer: Access) {
  const params = (value: unknown) => z.object({id}).parse(value).id;
  // Administrators reach every provider; everyone else only what was granted to them. A
  // provider account the caller cannot see is reported as missing, not forbidden.
  const readable = async (req: FastifyRequest) => {
    const {grant} = await viewer(req), accountId = params(req.params);
    requireThat(grant.role === 'admin' || store.canUse(grant.accountId, accountId), 'XTREAM_ACCOUNT_NOT_FOUND', 'Xtream account not found.', 404);
    return {accountId, caller: grant.accountId, isAdmin: grant.role === 'admin'};
  };
  // Owner or administrator: renaming, disabling and deleting a provider affects everyone using it.
  const manageable = async (req: FastifyRequest) => {
    const access = await readable(req);
    requireThat(access.isAdmin || store.isOwner(access.caller, access.accountId), 'FORBIDDEN', 'Only the account owner or an administrator can change this provider.', 403);
    return access;
  };

  app.get('/api/v1/xtream/accounts', async req => {
    const {grant} = await viewer(req);
    return {accounts: grant.role === 'admin' ? store.list() : store.granted(grant.accountId), usage: service.usage()};
  });
  app.get('/api/v1/xtream/accounts/:id', async req => { const {accountId} = await readable(req); return store.status(accountId); });
  app.post('/api/v1/xtream/accounts', async (req, reply) => {
    const {grant} = await viewer(req), input = create.parse(req.body);
    const account = store.create(grant.accountId, {name: input.name, credentials: input.credentials});
    reply.code(201);
    if (!input.validate) return {account, validation: {ok: false, skipped: true}};
    return validation(account.id, grant.accountId);
  });
  app.patch('/api/v1/xtream/accounts/:id', async req => {
    const {accountId, caller} = await manageable(req);
    return store.update(caller, accountId, xtreamAccountUpdate.parse(req.body));
  });
  app.delete('/api/v1/xtream/accounts/:id', async req => {
    const {accountId, caller} = await manageable(req);
    const input = z.object({expectedRevision: z.number().int().nonnegative()}).strict().parse(req.body);
    return store.remove(caller, accountId, input.expectedRevision);
  });
  app.post('/api/v1/xtream/accounts/:id/validate', async req => {
    const {accountId, caller} = await readable(req);
    z.object({}).strict().parse(req.body ?? {});
    return validation(accountId, caller);
  });
  app.post('/api/v1/xtream/accounts/:id/refresh', async req => {
    const {accountId, caller} = await readable(req);
    const input = z.object({includeEpg: z.boolean().default(true)}).strict().parse(req.body ?? {});
    const result = await service.refresh(caller, accountId, {includeEpg: input.includeEpg});
    return {...result, account: store.status(accountId), usage: service.usage()};
  });
  app.get('/api/v1/xtream/accounts/:id/catalogue', async req => {
    const {accountId} = await readable(req), catalogue = store.catalogue(accountId);
    if (!catalogue) throw new AppError('XTREAM_CATALOGUE_NOT_FOUND', 'Refresh this account before reading its catalogue.', 404);
    return cataloguePage(catalogue, page.parse(req.query));
  });

  // Administrator-only configuration surface, kept for existing deployments and CI.
  app.get('/api/v1/admin/xtream/accounts', async req => { await admin(req); return {accounts: store.list()}; });
  app.get('/api/v1/admin/xtream/accounts/:id', async req => { await admin(req); return store.status(params(req.params)); });
  app.post('/api/v1/admin/xtream/accounts', async (req, reply) => {
    const {grant} = await admin(req), input = create.parse(req.body);
    const account = store.create(grant.accountId, {name: input.name, credentials: input.credentials});
    reply.code(201);
    if (!input.validate) return {account, validation: {ok: false, skipped: true}};
    return validation(account.id, grant.accountId);
  });
  app.patch('/api/v1/admin/xtream/accounts/:id', async req => {
    const {grant} = await admin(req);
    return store.update(grant.accountId, params(req.params), xtreamAccountUpdate.parse(req.body));
  });
  app.delete('/api/v1/admin/xtream/accounts/:id', async req => {
    const {grant} = await admin(req), input = z.object({expectedRevision: z.number().int().nonnegative()}).strict().parse(req.body);
    return store.remove(grant.accountId, params(req.params), input.expectedRevision);
  });
  app.post('/api/v1/admin/xtream/accounts/:id/validate', async req => {
    const {grant} = await admin(req);
    z.object({}).strict().parse(req.body ?? {});
    return validation(params(req.params), grant.accountId);
  });
  app.post('/api/v1/admin/xtream/accounts/:id/refresh', async req => {
    const {grant} = await admin(req), accountId = params(req.params);
    const input = z.object({includeEpg: z.boolean().default(true)}).strict().parse(req.body ?? {});
    const result = await service.refresh(grant.accountId, accountId, {includeEpg: input.includeEpg});
    return {...result, account: store.status(accountId)};
  });
  app.get('/api/v1/admin/xtream/accounts/:id/catalogue', async req => {
    await admin(req);
    const accountId = params(req.params), catalogue = store.catalogue(accountId);
    if (!catalogue) throw new AppError('XTREAM_CATALOGUE_NOT_FOUND', 'Refresh this account before reading its catalogue.', 404);
    return cataloguePage(catalogue, page.parse(req.query));
  });
  app.get('/api/v1/admin/xtream/accounts/:id/access', async req => {
    await admin(req);
    return {xtreamId: params(req.params), accountIds: store.access(params(req.params))};
  });
  app.put('/api/v1/admin/xtream/accounts/:id/access', async req => {
    const {grant} = await admin(req), accountId = params(req.params);
    const input = xtreamAccess.parse(req.body);
    return store.setAccess(grant.accountId, accountId, input.accountIds);
  });

  async function validation(accountId: string, actor: string) {
    try {
      const account = await service.validate(actor, accountId);
      return {account: store.status(accountId), validation: {ok: true, account}};
    } catch (error) {
      // A rejected provider login leaves the account saved so its address can be corrected.
      return {account: store.status(accountId), validation: {ok: false, code: error instanceof AppError ? error.code : 'XTREAM_UNREACHABLE'}};
    }
  }
}
