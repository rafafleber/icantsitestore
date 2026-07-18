import crypto from 'node:crypto';
import { createStore, storageConfigured } from './storage.js';

export const DB_NAME = 'icant-master-v1';
export const store = () => createStore();
export { storageConfigured };
export const ACTIVATION_EMAIL = 'briangabrielfsoares@gmail.com';
export const ACTIVATION_HASH = '6dd5c27e447ac619b337520739464039789162f9d1468a175690113a0cd0a795';
export const RESOURCE_TYPES = new Set(['products','categories','pages','coupons','drops','outfits','testimonials','customers','orders','tickets','suppliers','warehouses','media','campaigns','shipping','payments','integrations','notifications','reviews']);

export function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
}
export function fail(message, status=400, details=null){ return json({ok:false,error:message,details},status); }
export function ok(data={}){ return json({ok:true,...data}); }
export function id(prefix='id'){ return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`; }
export const now = () => new Date().toISOString();
export const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
export function safeString(v,max=5000){ return String(v??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').slice(0,max); }
export function sanitize(value, depth=0){
  if(depth>8) return null;
  if(value===null || typeof value==='boolean' || typeof value==='number') return value;
  if(typeof value==='string') return safeString(value,20000);
  if(Array.isArray(value)) return value.slice(0,5000).map(v=>sanitize(v,depth+1));
  if(typeof value==='object'){
    const out={};
    for(const [k,v] of Object.entries(value)){
      if(['__proto__','prototype','constructor'].includes(k)) continue;
      out[safeString(k,120)] = sanitize(v,depth+1);
    }
    return out;
  }
  return null;
}
export async function readJSON(key, fallback=null){
  const value = await store().get(key,{type:'json',consistency:'strong'});
  return value ?? fallback;
}
export async function writeJSON(key,value,options={}){ return store().setJSON(key,sanitize(value),options); }
export async function listRecords(type){
  if(!RESOURCE_TYPES.has(type)) throw new Error('Recurso inválido');
  const {blobs}=await store().list({prefix:`records/${type}/`});
  const values=await Promise.all(blobs.map(b=>readJSON(b.key)));
  return values.filter(Boolean).sort((a,b)=>(a.order??9999)-(b.order??9999) || String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
}
export async function saveRecord(type,record,actor=null){
  if(!RESOURCE_TYPES.has(type)) throw new Error('Recurso inválido');
  const clean=sanitize(record);
  clean.id=clean.id||id(type.slice(0,-1)||'item');
  const existing=await readJSON(`records/${type}/${clean.id}`);
  if(existing){
    const versionKey=`versions/${type}/${clean.id}/${String(Date.now()).padStart(16,'0')}`;
    await writeJSON(versionKey,{...existing,versionedAt:now()}).catch(()=>{});
  }
  clean.createdAt=existing?.createdAt||clean.createdAt||now();
  clean.updatedAt=now();
  await writeJSON(`records/${type}/${clean.id}`,clean);
  if(actor) await audit(actor, existing?'update':'create', type, clean.id, {title:clean.name||clean.title||clean.number||''});
  return clean;
}
export async function deleteRecord(type,recordId,actor=null){
  if(!RESOURCE_TYPES.has(type)) throw new Error('Recurso inválido');
  await store().delete(`records/${type}/${safeString(recordId,150)}`);
  if(actor) await audit(actor,'delete',type,recordId,{});
}
export async function audit(actor,action,module,target,details={}){
  const entry={id:id('log'),at:now(),actorId:actor.id,actorEmail:actor.email,action,module,target,details:sanitize(details)};
  await writeJSON(`audit/${entry.at.replace(/[:.]/g,'-')}-${entry.id}`,entry);
  return entry;
}
export async function listAudit(limit=300){
  const {blobs}=await store().list({prefix:'audit/'});
  const chosen=blobs.sort((a,b)=>b.key.localeCompare(a.key)).slice(0,Math.min(limit,1000));
  return (await Promise.all(chosen.map(b=>readJSON(b.key)))).filter(Boolean);
}

function b64url(input){ return Buffer.from(input).toString('base64url'); }
function fromB64url(input){ return Buffer.from(input,'base64url'); }
async function secretKey(){
  let s=await readJSON('system/session-secret');
  if(!s){s={value:crypto.randomBytes(48).toString('hex'),createdAt:now()};await writeJSON('system/session-secret',s,{onlyIfNew:true}).catch(()=>{});s=await readJSON('system/session-secret',s);}
  return s.value;
}
async function encryptionKey(){
  let s=await readJSON('system/encryption-key');
  if(!s){s={value:crypto.randomBytes(32).toString('base64'),createdAt:now()};await writeJSON('system/encryption-key',s,{onlyIfNew:true}).catch(()=>{});s=await readJSON('system/encryption-key',s);}
  return Buffer.from(s.value,'base64');
}
export async function encryptText(text){
  const key=await encryptionKey(), iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const enc=Buffer.concat([cipher.update(String(text),'utf8'),cipher.final()]);
  return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:enc.toString('base64')};
}
export async function decryptText(box){
  const key=await encryptionKey(), d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(box.iv,'base64'));
  d.setAuthTag(Buffer.from(box.tag,'base64'));
  return Buffer.concat([d.update(Buffer.from(box.data,'base64')),d.final()]).toString('utf8');
}
export async function hashPassword(password){
  const salt=crypto.randomBytes(18).toString('base64');
  const hash=await new Promise((res,rej)=>crypto.pbkdf2(String(password),salt,240000,32,'sha256',(e,d)=>e?rej(e):res(d.toString('base64'))));
  return {salt,hash,iterations:240000};
}
export async function verifyPassword(password,record){
  if(!record?.salt||!record?.hash) return false;
  const test=await new Promise((res,rej)=>crypto.pbkdf2(String(password),record.salt,record.iterations||240000,32,'sha256',(e,d)=>e?rej(e):res(d)));
  return crypto.timingSafeEqual(test,Buffer.from(record.hash,'base64'));
}
const BASE32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf){let bits=0,value=0,out='';for(const byte of buf){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=BASE32[(value>>>(bits-5))&31];bits-=5;}}if(bits>0)out+=BASE32[(value<<(5-bits))&31];return out;}
export function base32Decode(s){s=String(s).toUpperCase().replace(/[^A-Z2-7]/g,'');let bits=0,value=0,out=[];for(const c of s){value=(value<<5)|BASE32.indexOf(c);bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function createTotpSecret(){return base32Encode(crypto.randomBytes(20));}
function hotp(secret,counter){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(counter));const h=crypto.createHmac('sha1',base32Decode(secret)).update(b).digest();const o=h[h.length-1]&15;return String(((h.readUInt32BE(o)&0x7fffffff)%1000000)).padStart(6,'0');}
export function verifyTotp(secret,code){const c=Math.floor(Date.now()/30000);return [-1,0,1].some(w=>{const a=hotp(secret,c+w),b=String(code||'').replace(/\D/g,'').padStart(6,'0');return a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));});}
export function otpauth(email,secret){return `otpauth://totp/ICANT:${encodeURIComponent(email)}?secret=${secret}&issuer=ICANT&algorithm=SHA1&digits=6&period=30`;}
export async function issueSession(admin,context){
  const payload={sub:admin.id,email:admin.email,role:admin.role,permissions:admin.permissions||['*'],exp:Date.now()+1000*60*60*8,nonce:crypto.randomBytes(8).toString('hex')};
  const body=b64url(JSON.stringify(payload)), sig=crypto.createHmac('sha256',await secretKey()).update(body).digest('base64url');
  context.cookies.set({name:'icant_admin',value:`${body}.${sig}`,httpOnly:true,secure:true,sameSite:'Strict',path:'/',maxAge:60*60*8});
  return payload;
}
export async function auth(context){
  const token=context.cookies.get('icant_admin');if(!token) return null;
  const [body,sig]=String(token).split('.');if(!body||!sig) return null;
  const expected=crypto.createHmac('sha256',await secretKey()).update(body).digest('base64url');
  if(expected.length!==sig.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(sig)))return null;
  let p;try{p=JSON.parse(fromB64url(body).toString('utf8'));}catch{return null;}
  if(!p.exp||p.exp<Date.now())return null;
  const admin=await readJSON(`admins/${p.sub}`);if(!admin||admin.disabled)return null;
  return {id:admin.id,email:admin.email,name:admin.name,role:admin.role,permissions:admin.permissions||['*']};
}
export function can(admin,module,action='read'){
  if(!admin)return false;if(admin.role==='master'||admin.permissions?.includes('*'))return true;
  return admin.permissions?.includes(`${module}:${action}`)||admin.permissions?.includes(`${module}:*`);
}
export function requirePermission(admin,module,action='read'){if(!can(admin,module,action))throw Object.assign(new Error('Sem permissão'),{status:403});}
export function ipOf(req,context){return safeString(req.headers.get('x-nf-client-connection-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]||context.ip||'unknown',100);}
export async function rateLimit(scope,ip,max=20,windowSec=300){
  const bucket=Math.floor(Date.now()/(windowSec*1000)); const key=`rate/${scope}/${sha256(ip).slice(0,24)}/${bucket}`;
  const r=await readJSON(key,{count:0}); r.count=(r.count||0)+1;r.expires=(bucket+1)*windowSec*1000;await writeJSON(key,r);
  return r.count<=max;
}
export async function findAdminByEmail(email){
  const {blobs}=await store().list({prefix:'admins/'});
  for(const b of blobs){const a=await readJSON(b.key);if(a?.email?.toLowerCase()===String(email).toLowerCase())return a;}
  return null;
}
export function defaultSettings(){return {
  storeName:'ICANT',slogan:'CANT? MAKE IT CAN.',logoText:'ICANT',logoImage:'',favicon:'',
  colors:{background:'#000000',surface:'#ffffff',text:'#111111',inverse:'#ffffff',muted:'#777777',accent:'#000000',card:'#f3f3f3'},
  typography:{fontFamily:'Arial, Helvetica, sans-serif',baseSize:15},currency:'BRL',locale:'pt-BR',country:'BR',
  contact:{whatsapp:'5531972354299',email:'briangabrielfsoares@gmail.com',instagram:'icant.store_ofc',tiktok:'voidimperium',address:'Belo Horizonte - MG',hours:'Atendimento online'},
  hero:{enabled:true,title:'ICANT',subtitle:'CANT? MAKE IT CAN.',buttonText:'SHOP NOW',buttonLink:'/?view=shop',image:'/assets/img/hero.svg',overlay:25,heightDesktop:520,heightMobile:420},
  benefits:[{id:'b1',icon:'▱',text:'FRETE GRÁTIS ACIMA DE R$ 299,99'},{id:'b2',icon:'◷',text:'ATÉ 30 DIAS PARA ENVIO'},{id:'b3',icon:'↻',text:'TROCAS DISPONÍVEIS'}],
  navigation:[{id:'n1',label:'HOME',url:'/'},{id:'n2',label:'SHOP',url:'/?view=shop'},{id:'n3',label:'DROPS',url:'/?view=drops'},{id:'n4',label:'OUTFITS',url:'/?view=outfits'},{id:'n5',label:'SOBRE',url:'/?page=sobre'}],
  homeSections:[{id:'launches',type:'products',title:'LANÇAMENTOS',source:'new',limit:5,enabled:true,order:1},{id:'bestsellers',type:'products',title:'MAIS VENDIDOS',source:'bestseller',limit:5,enabled:true,order:2}],
  commerce:{freeShippingAt:299.99,defaultShipping:30,exchangeEnabled:true,exchangeDays:null,blockOutOfStock:true,lowStockThreshold:3,checkoutMode:'whatsapp',allowCoupons:true},
  popup:{enabled:false,title:'Bem-vindo à ICANT',text:'Confira os lançamentos.',buttonText:'Ver produtos',buttonLink:'/?view=shop'},
  promoBar:{enabled:false,text:'NOVO DROP EM BREVE'},
  seo:{title:'ICANT — Official Store',description:'Streetwear, drops e outfits ICANT.',keywords:'streetwear, roupas, ICANT'},
  legal:{exchange:'Trocas disponíveis. Consulte as condições pelo atendimento.',privacy:'Seus dados são usados apenas para processar pedidos e atendimento.',terms:'Ao comprar, você concorda com as condições apresentadas no checkout.'},
  maintenance:{enabled:false,message:'Loja em manutenção. Voltamos em breve.'},
  app:{minimumVersion:'1.0.0',maintenance:false,updateMessage:''},
  updatedAt:now()
};}
export function defaultProducts(){
 const base=[
 ['p1','CAMISETA BLOOM',159.90,'/assets/img/products/tee-bloom.svg','NEW','Camisetas',['P','M','G','GG'],['Preto','Branco'],true,false],
 ['p2','MOLETOM CLASSIC',259.90,'/assets/img/products/hoodie-classic.svg','NEW','Moletons',['P','M','G','GG'],['Preto'],true,true],
 ['p3','CALÇA CARGO ICANT',239.90,'/assets/img/products/cargo.svg','NEW','Calças',['38','40','42','44'],['Preto'],true,true],
 ['p4','BONÉ ÍCON',129.90,'/assets/img/products/cap.svg','NEW','Acessórios',['Único'],['Preto'],true,false],
 ['p5','TÊNIS VISION',399.90,'/assets/img/products/sneaker.svg','NEW','Calçados',['37','38','39','40','41','42'],['Preto/Branco'],true,true],
 ['p6','CAMISETA GRAPHIC',179.90,'/assets/img/products/tee-gray.svg','HOT','Camisetas',['P','M','G','GG'],['Cinza','Preto'],false,true],
 ['p7','BERMUDA CORE',189.90,'/assets/img/products/shorts.svg','', 'Bermudas',['P','M','G'],['Preto'],false,true],
 ['p8','BAG STREET',149.90,'/assets/img/products/bag.svg','', 'Acessórios',['Único'],['Preto'],false,false],
 ['p9','MEIA ESSENTIAL',49.90,'/assets/img/products/sock.svg','', 'Acessórios',['M','G'],['Preto','Branco'],false,true],
 ['p10','JAQUETA NIGHT',349.90,'/assets/img/products/jacket.svg','LIMITED','Jaquetas',['P','M','G'],['Preto'],true,true]
 ];
 return base.map((x,i)=>({id:x[0],name:x[1],slug:x[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),brand:'ICANT',description:`${x[1]} com visual urbano, modelagem confortável e acabamento ICANT.`,price:x[2],oldPrice:i%3===0?x[2]+40:null,cost:Math.round(x[2]*.48*100)/100,badge:x[4],category:x[5],subcategory:'',gender:'Unissex',collection:'Core',tags:['streetwear'],images:[x[3]],video:'',active:true,archived:false,new:x[9],bestseller:x[10],featured:i<5,order:i+1,stock:12,sold:25+i*7,rating:4.8,reviewCount:8+i,variants:[{id:`${x[0]}-v1`,attributes:{Tamanho:x[6][0],Cor:x[7][0]},price:x[2],stock:5,sku:`IC-${1000+i}-1`,image:x[3]}],attributes:{Tamanhos:x[6],Cores:x[7]},weight:0.4,dimensions:{width:25,height:8,length:30},seo:{title:x[1],description:`Comprar ${x[1]} na ICANT.`},createdAt:now(),updatedAt:now()}));
}
