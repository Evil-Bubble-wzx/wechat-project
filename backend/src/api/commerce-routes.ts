import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './errors.ts';
import type { SessionServicePort } from './session-routes.ts';
import type { CommerceService } from '../commerce/service.ts';
export function registerCommerceRoutes(app: FastifyInstance, service: CommerceService, sessions: SessionServicePort) {
  async function user(request: FastifyRequest) {
    const header=request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new ApiError('UNAUTHENTICATED',401,false,'Login required');
    return (await sessions.authenticateAccessToken(header.slice(7))).userId;
  }
  app.get('/api/v1/bundles',async request=>{await user(request);return {requestId:request.id,items:await service.bundles()};});
  app.get('/api/v1/me/orders',async request=>({requestId:request.id,items:await service.orders(await user(request))}));
  app.get('/api/v1/me/orders/:orderId',async request=>{
    const userId=await user(request), id=(request.params as {orderId:string}).orderId;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new ApiError('INVALID_REQUEST',400,false,'Invalid order ID');
    return {requestId:request.id,order:await service.order(userId,id)};
  });
  app.post('/api/v1/me/orders',async request=>{
    const userId=await user(request), body=request.body as Record<string,unknown>, key=request.headers['idempotency-key'];
    if (!body || Array.isArray(body) || Object.keys(body).some(k=>!['bundleId','bundleVersion'].includes(k)) || typeof body.bundleId!=='string' || !body.bundleId.trim() || body.bundleId.length>128 || !Number.isInteger(body.bundleVersion) || Number(body.bundleVersion)<1 || typeof key!=='string' || key.length<8 || key.length>128) throw new ApiError('INVALID_REQUEST',400,false,'Invalid order request');
    return {requestId:request.id,order:await service.createOrder(userId,body.bundleId,Number(body.bundleVersion),key)};
  });
}
