import { withVercelContext } from './_lib/context.js';
import {
  ok, fail, json, now, id, sha256, safeString, sanitize, readJSON, writeJSON, listRecords, saveRecord, deleteRecord,
  listAudit, audit, hashPassword, verifyPassword, createTotpSecret, verifyTotp, otpauth, encryptText, decryptText,
  issueSession, auth, can, requirePermission, rateLimit, ipOf, findAdminByEmail, defaultSettings, defaultProducts,
  ACTIVATION_EMAIL, ACTIVATION_HASH, RESOURCE_TYPES, store
} from './_lib/core.js';

async function body(req){try{return sanitize(await req.json());}catch{return {};}}
function publicAdmin(a){return a?{id:a.id,name:a.name,email:a.email,role:a.role,permissions:a.permissions||[],disabled:!!a.disabled,createdAt:a.createdAt,lastLoginAt:a.lastLoginAt}:null;}
async function ensureSeed(){
  let settings=await readJSON('config/settings');
  if(!settings){settings=defaultSettings();await writeJSON('config/settings',settings,{onlyIfNew:true}).catch(()=>{});}
  if((await listRecords('products')).length===0){for(const p of defaultProducts())await writeJSON(`records/products/${p.id}`,p,{onlyIfNew:true}).catch(()=>{});}
}
async function backupAll(){
  const prefixes=['config/','records/','admins/','audit/'];const out={version:1,exportedAt:now(),data:{}};
  for(const prefix of prefixes){const {blobs}=await store().list({prefix});for(const b of blobs){if(b.key.includes('password')||b.key.startsWith('admins/')){const a=await readJSON(b.key);if(a)out.data[b.key]={...a,passwordHash:undefined,totpSecret:undefined};}else out.data[b.key]=await readJSON(b.key);}}
  return out;
}

async function handler(req,context){
  const action=new URL(req.url).searchParams.get('action')||'';
  try{
    if(req.method==='OPTIONS')return new Response('',{status:204});
    if(action==='status'){
      const admins=await store().list({prefix:'admins/'});return ok({activated:admins.blobs.length>0});
    }
    if(action==='activate-start'&&req.method==='POST'){
      const ip=ipOf(req,context);if(!(await rateLimit('activate',ip,8,900)))return fail('Muitas tentativas. Aguarde.',429);
      const existing=await store().list({prefix:'admins/'});if(existing.blobs.length)return fail('A loja já foi ativada.',409);
      const d=await body(req);
      if(sha256(safeString(d.code,100))!==ACTIVATION_HASH||safeString(d.email,200).toLowerCase()!==ACTIVATION_EMAIL)return fail('Código ou e-mail inválido.',401);
      if(safeString(d.password,200).length<10)return fail('Use uma senha com pelo menos 10 caracteres.');
      const passwordHash=await hashPassword(d.password);const secret=createTotpSecret();
      const temp={id:id('activation'),name:safeString(d.name||'Brian Gabriel Freitas Soares',120),email:ACTIVATION_EMAIL,passwordHash,totpSecret:await encryptText(secret),expiresAt:Date.now()+15*60*1000};
      await writeJSON('system/activation-temp',temp);
      return ok({activationId:temp.id,secret,otpauthUri:otpauth(ACTIVATION_EMAIL,secret),message:'Adicione a chave no aplicativo autenticador e confirme o código de 6 dígitos.'});
    }
    if(action==='activate-finish'&&req.method==='POST'){
      const d=await body(req);const temp=await readJSON('system/activation-temp');
      if(!temp||temp.id!==d.activationId||temp.expiresAt<Date.now())return fail('Ativação expirada.',410);
      const secret=await decryptText(temp.totpSecret);if(!verifyTotp(secret,d.totp))return fail('Código 2FA inválido.',401);
      const admin={id:id('admin'),name:temp.name,email:temp.email,role:'master',permissions:['*'],passwordHash:temp.passwordHash,totpSecret:temp.totpSecret,disabled:false,createdAt:now(),lastLoginAt:null};
      await writeJSON(`admins/${admin.id}`,admin,{onlyIfNew:true});await store().delete('system/activation-temp');await ensureSeed();
      await audit(admin,'activate','security',admin.id,{});const session=await issueSession(admin,context);return ok({admin:publicAdmin(admin),session});
    }
    if(action==='login'&&req.method==='POST'){
      const ip=ipOf(req,context);if(!(await rateLimit('login',ip,10,600)))return fail('Muitas tentativas. Aguarde.',429);
      const d=await body(req);const admin=await findAdminByEmail(d.email);
      if(!admin||admin.disabled||!(await verifyPassword(d.password,admin.passwordHash)))return fail('Acesso inválido.',401);
      const secret=await decryptText(admin.totpSecret);if(!verifyTotp(secret,d.totp))return fail('Código 2FA inválido.',401);
      admin.lastLoginAt=now();await writeJSON(`admins/${admin.id}`,admin);await audit(admin,'login','security',admin.id,{ip});const session=await issueSession(admin,context);
      return ok({admin:publicAdmin(admin),session});
    }
    if(action==='logout'){
      const a=await auth(context);if(a)await audit(a,'logout','security',a.id,{});context.cookies.delete({name:'icant_admin',path:'/'});return ok();
    }

    const admin=await auth(context);if(!admin)return fail('Sessão inválida ou expirada.',401);
    if(action==='me')return ok({admin});
    if(action==='dashboard'){
      requirePermission(admin,'dashboard','read');
      const [products,orders,customers,tickets]=await Promise.all([listRecords('products'),listRecords('orders'),listRecords('customers'),listRecords('tickets')]);
      const paid=orders.filter(o=>['paid','processing','shipped','delivered'].includes(o.status));const revenue=paid.reduce((s,o)=>s+Number(o.total||0),0);
      return ok({metrics:{products:products.length,activeProducts:products.filter(p=>p.active!==false&&!p.archived).length,orders:orders.length,revenue,customers:customers.length,openTickets:tickets.filter(t=>!['closed','resolved'].includes(t.status)).length,lowStock:products.filter(p=>Number(p.stock||0)<=Number((p.lowStockThreshold??3))).length},recentOrders:orders.slice(0,10)});
    }
    if(action==='settings-get'){requirePermission(admin,'settings','read');return ok({settings:await readJSON('config/settings',defaultSettings())});}
    if(action==='settings-save'&&req.method==='POST'){
      requirePermission(admin,'settings','write');const d=await body(req);const current=await readJSON('config/settings',defaultSettings());
      await writeJSON(`versions/settings/config/${String(Date.now()).padStart(16,'0')}`,{...current,versionedAt:now()}).catch(()=>{});const settings={...current,...d.settings,updatedAt:now()};await writeJSON('config/settings',settings);await audit(admin,'update','settings','config/settings',{});return ok({settings});
    }
    if(action==='list'){
      const type=safeString(new URL(req.url).searchParams.get('type'),40);if(!RESOURCE_TYPES.has(type))return fail('Recurso inválido.');requirePermission(admin,type,'read');return ok({items:await listRecords(type)});
    }
    if(action==='save'&&req.method==='POST'){
      const d=await body(req),type=safeString(d.type,40);if(!RESOURCE_TYPES.has(type))return fail('Recurso inválido.');requirePermission(admin,type,'write');
      const saved=await saveRecord(type,d.item,admin);return ok({item:saved});
    }
    if(action==='duplicate'&&req.method==='POST'){
      const d=await body(req),type=safeString(d.type,40);requirePermission(admin,type,'write');const original=await readJSON(`records/${type}/${safeString(d.id,150)}`);if(!original)return fail('Item não encontrado.',404);
      const copy={...original,id:undefined,name:`${original.name||original.title||'Item'} — cópia`,slug:`${original.slug||'item'}-copia-${Date.now().toString(36)}`,status:'draft',active:false,createdAt:undefined,updatedAt:undefined};return ok({item:await saveRecord(type,copy,admin)});
    }
    if(action==='delete'&&req.method==='POST'){
      const d=await body(req),type=safeString(d.type,40);requirePermission(admin,type,'delete');if(d.confirm!=='EXCLUIR')return fail('Confirmação obrigatória.');await deleteRecord(type,d.id,admin);return ok();
    }
    if(action==='reorder'&&req.method==='POST'){
      const d=await body(req),type=safeString(d.type,40);requirePermission(admin,type,'write');for(let i=0;i<(d.ids||[]).length;i++){const rec=await readJSON(`records/${type}/${d.ids[i]}`);if(rec){rec.order=i+1;rec.updatedAt=now();await writeJSON(`records/${type}/${rec.id}`,rec);}}await audit(admin,'reorder',type,'multiple',{});return ok();
    }

    if(action==='history'){
      const type=safeString(new URL(req.url).searchParams.get('type'),40),rid=safeString(new URL(req.url).searchParams.get('id'),150);requirePermission(admin,type,'read');
      const {blobs}=await store().list({prefix:`versions/${type}/${rid}/`});const items=[];for(const b of blobs.sort((a,b)=>b.key.localeCompare(a.key)).slice(0,100)){const v=await readJSON(b.key);if(v)items.push(v);}return ok({items});
    }
    if(action==='history-restore'&&req.method==='POST'){
      const d=await body(req),type=safeString(d.type,40);requirePermission(admin,type,'write');if(d.confirm!=='RESTAURAR')return fail('Confirmação obrigatória.');const version=await readJSON(`versions/${type}/${safeString(d.id,150)}/${safeString(d.versionKey,100)}`);if(!version)return fail('Versão não encontrada.',404);delete version.versionedAt;const saved=await saveRecord(type,version,admin);return ok({item:saved});
    }
    if(action==='import-link'&&req.method==='POST'){
      requirePermission(admin,'products','write');const d=await body(req);let u;try{u=new URL(d.url)}catch{return fail('Link inválido.');}
      if(!['http:','https:'].includes(u.protocol))return fail('Protocolo não permitido.');const host=u.hostname.toLowerCase();if(host==='localhost'||host.endsWith('.local')||/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(host))return fail('Endereço privado não permitido.');
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);let html='';try{const r=await fetch(u,{signal:controller.signal,headers:{'user-agent':'Mozilla/5.0 ICANT Importer/1.0','accept':'text/html,application/xhtml+xml'}});if(!r.ok)return fail(`O anúncio respondeu com status ${r.status}.`);html=(await r.text()).slice(0,2_000_000);}catch(e){return fail('Não foi possível acessar o anúncio. O site pode bloquear importações automáticas.',422,e.message);}finally{clearTimeout(timer);}
      const decode=x=>String(x||'').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      const meta=(name,prop=false)=>{const re=new RegExp(`<meta[^>]+${prop?'property':'name'}=["']${name}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+${prop?'property':'name'}=["']${name}["']`,'i');const m=html.match(re);return decode(m?.[1]||m?.[2]||'');};
      let product={name:meta('og:title',true)||meta('twitter:title')||'',description:meta('og:description',true)||meta('description')||'',images:[meta('og:image',true)].filter(Boolean),sourceUrl:u.href,brand:'',price:0,oldPrice:null,active:false,status:'draft',tags:['importado']};
      const scripts=[...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];for(const m of scripts){try{let data=JSON.parse(m[1].trim());const arr=Array.isArray(data)?data:[data];const flat=arr.flatMap(x=>x?.['@graph']||[x]);const pr=flat.find(x=>String(x?.['@type']||'').toLowerCase().includes('product'));if(pr){product.name=pr.name||product.name;product.description=pr.description||product.description;product.brand=typeof pr.brand==='string'?pr.brand:pr.brand?.name||'';product.images=(Array.isArray(pr.image)?pr.image:[pr.image]).filter(Boolean);const offer=Array.isArray(pr.offers)?pr.offers[0]:pr.offers;product.price=Number(offer?.price||offer?.lowPrice||0);break;}}catch{}}
      if(!product.name)return fail('A página foi acessada, mas não expôs dados de produto. Cadastre manualmente ou use outro link.',422,{diagnostic:'Sem OpenGraph/JSON-LD de produto'});
      product.slug=String(product.name).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');return ok({item:product,diagnostic:'Dados públicos encontrados. Revise antes de publicar.'});
    }
    if(action==='audit'){requirePermission(admin,'audit','read');return ok({items:await listAudit(Number(new URL(req.url).searchParams.get('limit')||300))});}
    if(action==='admins-list'){requirePermission(admin,'admins','read');const {blobs}=await store().list({prefix:'admins/'});const items=[];for(const b of blobs)items.push(publicAdmin(await readJSON(b.key)));return ok({items});}
    if(action==='admins-create'&&req.method==='POST'){
      requirePermission(admin,'admins','write');if(admin.role!=='master')return fail('Apenas o administrador master pode criar administradores.',403);const d=await body(req);
      if(await findAdminByEmail(d.email))return fail('E-mail já cadastrado.',409);if(safeString(d.password,200).length<10)return fail('Senha muito curta.');
      const secret=createTotpSecret();const record={id:id('admin'),name:safeString(d.name,120),email:safeString(d.email,200).toLowerCase(),role:d.role==='master'?'manager':safeString(d.role||'manager',30),permissions:Array.isArray(d.permissions)?d.permissions:['dashboard:read','products:*','orders:*'],passwordHash:await hashPassword(d.password),totpSecret:await encryptText(secret),disabled:false,createdAt:now()};
      await writeJSON(`admins/${record.id}`,record);await audit(admin,'create','admins',record.id,{email:record.email});return ok({admin:publicAdmin(record),secret,otpauthUri:otpauth(record.email,secret)});
    }
    if(action==='admins-toggle'&&req.method==='POST'){
      requirePermission(admin,'admins','write');if(admin.role!=='master')return fail('Apenas o master pode alterar administradores.',403);const d=await body(req);if(d.id===admin.id)return fail('Você não pode desativar sua própria conta.');const rec=await readJSON(`admins/${d.id}`);if(!rec)return fail('Administrador não encontrado.',404);rec.disabled=!!d.disabled;await writeJSON(`admins/${rec.id}`,rec);await audit(admin,'update','admins',rec.id,{disabled:rec.disabled});return ok({admin:publicAdmin(rec)});
    }
    if(action==='backup'){requirePermission(admin,'settings','read');return ok({backup:await backupAll()});}
    if(action==='restore'&&req.method==='POST'){
      requirePermission(admin,'settings','write');if(admin.role!=='master')return fail('Apenas o master pode restaurar backup.',403);const d=await body(req);if(d.confirm!=='RESTAURAR')return fail('Confirmação obrigatória.');
      const data=d.backup?.data||{};let count=0;for(const [key,value] of Object.entries(data)){if(!key.startsWith('records/')&&!key.startsWith('config/'))continue;await writeJSON(key,value);count++;}await audit(admin,'restore','settings','backup',{count});return ok({count});
    }
    if(action==='change-password'&&req.method==='POST'){
      const d=await body(req);const rec=await readJSON(`admins/${admin.id}`);if(!(await verifyPassword(d.currentPassword,rec.passwordHash)))return fail('Senha atual inválida.',401);if(safeString(d.newPassword,200).length<10)return fail('Nova senha muito curta.');rec.passwordHash=await hashPassword(d.newPassword);await writeJSON(`admins/${rec.id}`,rec);context.cookies.delete({name:'icant_admin',path:'/'});await audit(admin,'password-change','security',rec.id,{});return ok();
    }
    return fail('Ação não encontrada.',404);
  }catch(error){console.error(error);return fail(error.message||'Erro interno',error.status||500);}
};

export default { fetch: (request) => withVercelContext(request, handler) };
