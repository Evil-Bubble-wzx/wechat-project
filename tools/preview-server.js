const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname,'..')
const previewMode = process.argv.includes('--demo') ? 'demo' : 'production'
const miniArg=process.argv.find(value=>value.startsWith('--mini-root='))
const miniRoot=miniArg?path.resolve(root,miniArg.slice('--mini-root='.length)):path.join(root,'miniprogram')
const moduleCandidates = ['config/product-mode','modules/catalog/catalog-data','modules/catalog/books','modules/content-notices','modules/account/session','modules/physical-loan/rules','modules/promotion/demo','modules/listen-read/player','modules/listen-read/cues-data','modules/listen-read/peter-quiz-data','modules/listen-read/peter-vocab-data','modules/listen-read/legacy-cues-data','modules/listen-read/legacy-vocab-data','modules/listen-read/legacy-quiz-data','modules/listen-read/subtitles','modules/quiz/attempts','modules/report/aggregate','modules/ranking/state','services/host','ui/controller']
const modules=moduleCandidates.filter(id=>fs.existsSync(path.join(miniRoot,id+'.js')))
const server = http.createServer((req,res) => {
  const url = new URL(req.url,'http://localhost')
  let file
  if(url.pathname==='/bundle.js') {
    const catalog=fs.readFileSync(path.join(miniRoot,'modules/catalog/catalog.json'),'utf8')
    const body = '(function(){wx.__tingyueMode='+JSON.stringify(previewMode)+';const registry={};\nregistry["modules/catalog/catalog.json"]=function(require,module){module.exports='+catalog+'};\n' + modules.map(id => 'registry['+JSON.stringify(id)+']=function(require,module,exports){\n'+fs.readFileSync(path.join(miniRoot,id+'.js'),'utf8')+'\n};').join('\n') + '\nconst cache={}; function load(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;if(!registry[id])throw new Error("Missing preview module "+id);registry[id](p=>{const parts=(id.slice(0,id.lastIndexOf("/"))+"/"+p).split("/");const out=[];for(const s of parts){if(s==="..")out.pop();else if(s!==".")out.push(s)}return load(out.join("/"))},m,m.exports);return m.exports}window.Tingyue=load("ui/controller");})();'
    res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(body);return
  }
  if(url.pathname==='/native.css') { res.writeHead(200,{'Content-Type':'text/css'});res.end(fs.readFileSync(path.join(miniRoot,'app.wxss'),'utf8').replace(/(-?[\d.]+)rpx/g,(_,n)=>Number(n)/2+'px').replace(/\bpage\s*\{/g,'.device {').replace(/(?<![-\w])(view|text|image)(?![-\w])/g,tag=>({view:'div',text:'span',image:'img'})[tag]));return }
  if(url.pathname==='/')file=path.join(root,'preview/index.html')
  else if(url.pathname==='/screen.wxml'){
    const ui=path.join(miniRoot,'ui')
    const screen=fs.readFileSync(path.join(ui,'screen.wxml'),'utf8')
      .replace('<include src="./player.wxml" />',fs.readFileSync(path.join(ui,'player.wxml'),'utf8'))
      .replace('<include src="./quiz.wxml" />',fs.readFileSync(path.join(ui,'quiz.wxml'),'utf8'))
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(screen);return
  }
  else if(url.pathname.startsWith('/assets/')||url.pathname.startsWith('/quiz/assets/'))file=path.join(miniRoot,decodeURIComponent(url.pathname))
  else file=path.join(root,'preview',decodeURIComponent(url.pathname))
  const allowed=[path.join(root,'preview')+path.sep,miniRoot+path.sep]
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
server.listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log('Tingyue '+previewMode+' preview ('+path.relative(root,miniRoot)+'): http://127.0.0.1:'+(process.env.PORT||4173)))
