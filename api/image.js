import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES=12*1024*1024;
const ALLOWED=/^image\/(?:avif|gif|jpeg|jpg|png|webp|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;|$)/i;

function privateIp(ip){
 if(net.isIPv4(ip)){const p=ip.split('.').map(Number);return p[0]===10||p[0]===127||p[0]===0||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]>=224;}
 const x=ip.toLowerCase();return x==='::1'||x==='::'||x.startsWith('fc')||x.startsWith('fd')||x.startsWith('fe8')||x.startsWith('fe9')||x.startsWith('fea')||x.startsWith('feb')||x.startsWith('::ffff:127.')||x.startsWith('::ffff:10.')||x.startsWith('::ffff:192.168.');
}

async function safeUrl(value){
 let url;try{url=new URL(value)}catch{throw new Error('URL inválida')}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('URL não permitida');
 if(['localhost','localhost.localdomain'].includes(url.hostname.toLowerCase()))throw new Error('Host não permitido');
 const addresses=await dns.lookup(url.hostname,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(x=>privateIp(x.address)))throw new Error('Host não permitido');
 return url;
}

export default async function handler(req,res){
 if(req.method!=='GET')return res.status(405).end();
 try{
  let current=await safeUrl(req.query.url);let response;
  for(let redirects=0;redirects<4;redirects++){
   response=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(10000),headers:{accept:'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=.8','user-agent':'Mozilla/5.0 ICANT-Image-Proxy/1.0'}});
   if(response.status>=300&&response.status<400&&response.headers.get('location')){current=await safeUrl(new URL(response.headers.get('location'),current).href);continue;}
   break;
  }
  if(!response?.ok)throw new Error('Imagem indisponível');
  const type=(response.headers.get('content-type')||'').toLowerCase();if(!ALLOWED.test(type))throw new Error('Formato não permitido');
  const declared=Number(response.headers.get('content-length')||0);if(declared>MAX_BYTES)throw new Error('Imagem muito grande');
  const data=Buffer.from(await response.arrayBuffer());if(!data.length||data.length>MAX_BYTES)throw new Error('Imagem muito grande');
  res.setHeader('Content-Type',type);res.setHeader('Cache-Control','public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000');res.setHeader('X-Content-Type-Options','nosniff');
  return res.status(200).send(data);
 }catch{return res.status(404).end();}
}
