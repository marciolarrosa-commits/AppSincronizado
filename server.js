const path = require('path');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const sessions = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode(){ let s=''; for(let i=0;i<6;i++) s+=CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; return s; }
function token(){ return crypto.randomBytes(24).toString('hex'); }
function getSession(code){ return sessions.get(String(code||'').toUpperCase()); }
function createSession(){ let code; do code=genCode(); while(sessions.has(code)); const s={code,masterToken:token(),createdAt:Date.now(),clients:new Set(),state:{version:0,color:'#000000',effect:'solid',intensity:1,executeAt:0,active:false,label:'Esperando al show'}}; sessions.set(code,s); return s; }
function sendJson(res,status,obj){ const data=JSON.stringify(obj); res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}); res.end(data); }
function body(req){ return new Promise((resolve,reject)=>{ let raw=''; req.on('data',c=>{raw+=c;if(raw.length>32768) req.destroy();}); req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{});}catch(e){reject(e);}}); req.on('error',reject); }); }
function broadcast(s,event,data){ const payload=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for(const res of s.clients){ try{res.write(payload);}catch(e){s.clients.delete(res);} } }
function sessionSnapshot(s){ return {type:'state',session:s.code,state:s.state,serverTime:Date.now(),connected:s.clients.size}; }
function safePath(p){ const normalized=path.normalize(p); return normalized.startsWith(PUBLIC) ? normalized : null; }
function serveStatic(req,res){ let pathname=new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname; if(pathname==='/') pathname='/index.html'; if(pathname==='/master') pathname='/master.html'; const file=safePath(path.join(PUBLIC,decodeURIComponent(pathname))); if(!file){res.writeHead(403);return res.end('Forbidden');} fs.stat(file,(err,st)=>{if(err||!st.isFile()){res.writeHead(404);return res.end('Not found');} const ext=path.extname(file); const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'}; res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':'no-cache'}); fs.createReadStream(file).pipe(res);}); }

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try{
    if(req.method==='GET'&&u.pathname==='/healthz'){
      return sendJson(res,200,{ok:true,service:'destello-sync-v2',time:new Date().toISOString(),sessions:sessions.size});
    }
    if(req.method==='POST'&&u.pathname==='/api/sessions'){
      const s=createSession(); const base=PUBLIC_BASE_URL||`${req.headers['x-forwarded-proto']||'http'}://${req.headers.host}`; const joinUrl=`${base}/?s=${s.code}&mode=remote`; return sendJson(res,200,{code:s.code,masterToken:s.masterToken,joinUrl});
    }
    const match=u.pathname.match(/^\/api\/sessions\/([A-Z0-9]+)\/(command|stop|events|status)$/i);
    if(match){
      const s=getSession(match[1]); if(!s) return sendJson(res,404,{error:'SESSION_NOT_FOUND'});
      const action=match[2];
      if(action==='status') return sendJson(res,200,{code:s.code,state:s.state,connected:s.clients.size});
      if(action==='events'){
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','access-control-allow-origin':'*'});
        res.write(`event: hello\ndata: ${JSON.stringify({session:s.code,serverTime:Date.now(),connected:s.clients.size})}\n\n`);
        res.write(`event: state\ndata: ${JSON.stringify(sessionSnapshot(s))}\n\n`);
        s.clients.add(res); broadcast(s,'presence',{connected:s.clients.size});
        const keep=setInterval(()=>{try{res.write(': keepalive\n\n')}catch(e){}},15000);
        req.on('close',()=>{clearInterval(keep);s.clients.delete(res);broadcast(s,'presence',{connected:s.clients.size});});
        return;
      }
      if(req.headers['x-master-token']!==s.masterToken) return sendJson(res,401,{error:'UNAUTHORIZED'});
      const data=await body(req);
      if(action==='stop'){
        s.state={...s.state,version:s.state.version+1,active:false,executeAt:Date.now(),label:'Show detenido'};
      } else {
        const color=typeof data.color==='string'&&/^#[0-9a-fA-F]{6}$/.test(data.color)?data.color:s.state.color;
        const effects=['solid','pulse','strobe']; const effect=effects.includes(data.effect)?data.effect:'solid';
        const intensity=Number.isFinite(data.intensity)?Math.min(1,Math.max(0,Number(data.intensity))):1;
        const delayMs=Number.isFinite(data.delayMs)?Math.min(10000,Math.max(0,Number(data.delayMs))):350;
        s.state={version:s.state.version+1,color,effect,intensity,executeAt:Date.now()+delayMs,active:data.active!==false,label:typeof data.label==='string'?data.label.slice(0,80):`Master · ${effect}`};
      }
      broadcast(s,'state',sessionSnapshot(s)); return sendJson(res,200,{ok:true,state:s.state});
    }
    serveStatic(req,res);
  }catch(e){ console.error(e); if(!res.headersSent) sendJson(res,500,{error:'SERVER_ERROR'}); }
});

setInterval(()=>{const now=Date.now(); for(const [code,s] of sessions){if(s.clients.size===0&&now-s.createdAt>6*60*60*1000)sessions.delete(code);}},60000);
server.listen(PORT, HOST, ()=>console.log(`Destello·Sync V2 listo en ${HOST}:${PORT}`));
