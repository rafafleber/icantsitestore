import { withVercelContext } from './_lib/context.js';
import { ok, fail, now, id, sanitize, safeString, saveRecord, readJSON, rateLimit, ipOf } from './_lib/core.js';
async function handler(req,context){
 try{if(req.method!=='POST')return fail('Método inválido.',405);if(!(await rateLimit('support',ipOf(req,context),20,600)))return fail('Muitas mensagens.',429);const d=sanitize(await req.json());if(!d.name||!d.message)return fail('Preencha nome e mensagem.');const ticket={id:id('ticket'),number:`AT${Date.now().toString().slice(-7)}`,name:safeString(d.name,180),email:safeString(d.email,200),phone:String(d.phone||'').replace(/\D/g,''),subject:safeString(d.subject||'Atendimento pelo site',200),message:safeString(d.message,4000),status:'open',priority:'normal',createdAt:now(),updatedAt:now()};await saveRecord('tickets',ticket,null);const s=await readJSON('config/settings');const phone=String(s?.contact?.whatsapp||'5531972354299').replace(/\D/g,'');const msg=`*ATENDIMENTO ICANT — ${ticket.number}*\nNome: ${ticket.name}\nAssunto: ${ticket.subject}\nMensagem: ${ticket.message}`;return ok({ticket,whatsappUrl:`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`});}catch(e){return fail('Falha no atendimento.',500,e.message);}
};

export default { fetch: (request) => withVercelContext(request, handler) };
