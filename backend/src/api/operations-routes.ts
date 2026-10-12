import {readFile} from "node:fs/promises";
import type {FastifyInstance} from "fastify";

// Explicit allowlist: never turn this into arbitrary workspace file serving.
export function registerOperationsRoutes(app:FastifyInstance):void{
  const assets:{name:string;mime:string}[]=[{name:"index.html",mime:"text/html; charset=utf-8"},{name:"styles.css",mime:"text/css; charset=utf-8"},{name:"app.mjs",mime:"text/javascript; charset=utf-8"},{name:"upload-core.mjs",mime:"text/javascript; charset=utf-8"},{name:"upload-flow.mjs",mime:"text/javascript; charset=utf-8"},{name:"bulk-core.mjs",mime:"text/javascript; charset=utf-8"},{name:"bulk-store.mjs",mime:"text/javascript; charset=utf-8"},{name:"bulk-ui.mjs",mime:"text/javascript; charset=utf-8"}];
  app.get("/operations",async(_request,reply)=>reply.redirect("/operations/"));
  for(const asset of assets)app.get(asset.name==="index.html"?"/operations/":"/operations/"+asset.name,async(_request,reply)=>{
    reply.header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff").header("Referrer-Policy","no-referrer").header("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https: http://127.0.0.1:9000 http://localhost:9000; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    return reply.type(asset.mime).send(await readFile(new URL("../../../operations-web/"+asset.name,import.meta.url)));
  });
}
