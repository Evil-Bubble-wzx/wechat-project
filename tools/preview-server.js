const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname,'..')
const modules = ['modules/catalog/catalog-data','modules/catalog/books','modules/account/session','modules/physical-loan/rules','modules/listen-read/player','modules/listen-read/cues-data','modules/listen-read/legacy-cues-data','modules/listen-read/legacy-vocab-data','services/host','ui/controller']
const server = http.createServer((req,res) => {
  const url = new URL(req.url,'http://localhost')
  let file
  if(url.pathname==='/bundle.js') {
    const catalog=fs.readFileSync(path.join(root,'miniprogram/modules/catalog/catalog.json'),'utf8')
    const body = '(function(){const registry={};\nregistry["modules/catalog/catalog.json"]=function(require,module){module.exports='+catalog+'};\n' + modules.map(id => 'registry['+JSON.stringify(id)+']=function(require,module,exports){\n'+fs.readFileSync(path.join(root,'miniprogram',id+'.js'),'utf8')+'\n};').join('\n') + '\nconst cache={}; function load(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;registry[id](p=>{const parts=(id.slice(0,id.lastIndexOf("/"))+"/"+p).split("/");const out=[];for(const s of parts){if(s==="..")out.pop();else if(s!==".")out.push(s)}return load(out.join("/"))},m,m.exports);return m.exports}window.Tingyue=load("ui/controller");})();'
    res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(body);return
  }
  if(url.pathname==='/native.css') { res.writeHead(200,{'Content-Type':'text/css'});res.end(fs.readFileSync(path.join(root,'miniprogram/app.wxss'),'utf8').replace(/(-?[\d.]+)rpx/g,(_,n)=>Number(n)/2+'px').replace(/\bpage\s*\{/g,'.device {').replace(/(?<![-\w])(view|text|image)(?![-\w])/g,tag=>({view:'div',text:'span',image:'img'})[tag]));return }
  if(url.pathname==='/')file=path.join(root,'preview/index.html')
  else if(url.pathname==='/screen.wxml')file=path.join(root,'miniprogram/ui/screen.wxml')
  else if(url.pathname.startsWith('/assets/'))file=path.join(root,'miniprogram',decodeURIComponent(url.pathname))
  else file=path.join(root,'preview',decodeURIComponent(url.pathname))
  const allowed=[path.join(root,'preview')+path.sep,path.join(root,'miniprogram')+path.sep]
  if(!allowed.some(p=>file.startsWith(p))){res.writeHead(403);res.end();return}
  if(path.extname(file)==='.mp3') {
    fs.stat(file,(err,stat)=>{
      if(err){res.writeHead(404);res.end('Audio not found');return}
      const headers={'Content-Type':'audio/mpeg','Accept-Ranges':'bytes','Cache-Control':'no-cache'}
      if(req.headers.range){
        const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
        const start=range?Number(range[1]):NaN,end=range&&range[2]?Math.min(Number(range[2]),stat.size-1):stat.size-1
        if(!Number.isFinite(start)||start> end||start>=stat.size){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});res.end();return}
        res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${stat.size}`})
        if(req.method==='HEAD')res.end();else fs.createReadStream(file,{start,end}).pipe(res)
      }else{res.writeHead(200,{...headers,'Content-Length':stat.size});if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res)}
    });return
  }
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end('Not found');return}const type={'.html':'text/html','.js':'text/javascript','.wxml':'text/plain','.css':'text/css','.png':'image/png'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(data)})
})
server.listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log('Tingyue preview: http://127.0.0.1:'+(process.env.PORT||4173)))
