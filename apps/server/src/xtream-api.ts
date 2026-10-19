import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';
import { xtreamAccess, xtreamAccountCreate, xtreamAccountUpdate, type XtreamStore } from './persistence/xtream-store.js';
import type { XtreamService } from './services/xtream-service.js';
import { cataloguePage } from './providers/xtream.js';

type Access = (req: FastifyRequest) => Promise<{grant: {accountId: string}}>;

// Administrator-only configuration surface. Viewer-facing catalogue and playback routes are a
// later milestone: they must authorise through xtream_access before reading a provider account.
export function registerXtream(app: FastifyInstance, store: XtreamStore, service: XtreamService, admin: Access) {
  const id = z.string().uuid(), revision = z.number().int().nonnegative();
  const params = (value: unknown) => z.object({id}).parse(value).id;
  const create = xtreamAccountCreate.extend({validate: z.boolean().default(true)}).strict();
  const page = z.object({
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    categoryId: z.string().max(64).optional(),
    q: z.string().trim().max(120).default('')
  }).strict();

  app.get('/api/v1/admin/xtream/accounts', async req => { await admin(req); return {accounts: store.list()}; });
  app.get('/api/v1/admin/xtream/accounts/:id', async req => { await admin(req); return store.status(params(req.params)); });
  app.post('/api/v1/admin/xtream/accounts', async (req, reply) => {
    const {grant} = await admin(req), input = create.parse(req.body);
    const account = store.create(grant.accountId, {name: input.name, credentials: input.credentials});
    reply.code(201);
    // A rejected provider login leaves the account saved so its address can be corrected and retried.
    if (!input.validate) return {account, validation: {ok: false, skipped: true}};
    try {
      const validated = await service.validate(grant.accountId, account.id);
      return {account: store.status(account.id), validation: {ok: true, account: validated}};
    } catch (error) {
      return {account: store.status(account.id), validation: {ok: false, code: error instanceof AppError ? error.code : 'XTREAM_UNREACHABLE'}};
    }
  });
  app.patch('/api/v1/admin/xtream/accounts/:id', async req => {
    const {grant} = await admin(req);
    return store.update(grant.accountId, params(req.params), xtreamAccountUpdate.parse(req.body));
  });
  app.delete('/api/v1/admin/xtream/accounts/:id', async req => {
    const {grant} = await admin(req), input = z.object({expectedRevision: revision}).strict().parse(req.body);
    return store.remove(grant.accountId, params(req.params), input.expectedRevision);
  });
  app.post('/api/v1/admin/xtream/accounts/:id/validate', async req => {
    const {grant} = await admin(req);
    z.object({}).strict().parse(req.body ?? {});
    return {validation: {ok: true, account: await service.validate(grant.accountId, params(req.params))}, account: store.status(params(req.params))};
  });
  app.post('/api/v1/admin/xtream/accounts/:id/refresh', async req => {
    const {grant} = await admin(req), accountId = params(req.params);
    const input = z.object({includeEpg: z.boolean().default(false)}).strict().parse(req.body ?? {});
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
}
