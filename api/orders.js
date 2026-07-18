import { withVercelContext } from './_lib/context.js';
import { ok, fail, now, id, sanitize, safeString, listRecords, readJSON, saveRecord, rateLimit, ipOf } from './_lib/core.js';
const money=n=>Math.round((Number(n)||0)*100)/100;
function digits(s){return String(s||'').replace(/\D/g,'');}
async function handler(req,context){
  try{
    if(req.method!=='POST')return fail('Método inválido.',405);const ip=ipOf(req,context);if(!(await rateLimit('order',ip,12,600)))return fail('Muitos pedidos em pouco tempo.',429);
    const d=sanitize(await req.json());const settings=await readJSON('config/settings');const products=await listRecords('products');
    if(!d.customer?.name||safeString(d.customer.name,200).length<3)return fail('Informe o nome completo.');if(digits(d.customer?.phone).length<10)return fail('Informe um telefone válido.');if(digits(d.customer?.cpf).length!==11)return fail('Informe um CPF com 11 números.');if(digits(d.shipping?.cep).length!==8)return fail('Informe um CEP válido.');
    const items=[];let subtotal=0;
    for(const line of (d.items||[]).slice(0,80)){
      const p=products.find(x=>x.id===line.productId&&x.active!==false&&!x.archived);if(!p)continue;const qty=Math.max(1,Math.min(20,Number(line.qty)||1));const variant=(p.variants||[]).find(v=>v.id===line.variantId);const price=money(variant?.price??p.price);const available=Number(variant?.stock??p.stock??0);if(settings?.commerce?.blockOutOfStock&&available<qty)return fail(`${p.name} sem estoque suficiente.`);
      subtotal+=price*qty;items.push({productId:p.id,name:p.name,variantId:variant?.id||null,attributes:variant?.attributes||line.attributes||{},qty,price,total:money(price*qty),image:variant?.image||p.images?.[0]||''});
    }
    if(!items.length)return fail('Carrinho vazio.');
    let discount=0,coupon=null;const code=safeString(d.coupon,80).trim().toUpperCase();if(code){const coupons=await listRecords('coupons');coupon=coupons.find(c=>c.active&&String(c.code).toUpperCase()===code&&(!c.expiresAt||new Date(c.expiresAt)>new Date())&&subtotal>=Number(c.minimum||0));if(coupon){discount=coupon.type==='percent'?subtotal*(Number(c.value||0)/100):Number(coupon.value||0);discount=Math.min(subtotal,money(discount));}}
    const shipping=subtotal-discount>=Number(settings?.commerce?.freeShippingAt||299.99)?0:Number(settings?.commerce?.defaultShipping||30);const total=money(subtotal-discount+shipping);
    const order={id:id('order'),number:`IC${Date.now().toString().slice(-8)}`,status:'pending_payment',paymentStatus:'pending',paymentMethod:'pix_whatsapp',customer:{name:safeString(d.customer.name,200),cpf:digits(d.customer.cpf),phone:digits(d.customer.phone),email:safeString(d.customer.email,200)},shipping:{cep:digits(d.shipping.cep),street:safeString(d.shipping.street,200),number:safeString(d.shipping.number,40),complement:safeString(d.shipping.complement,160),district:safeString(d.shipping.district,120),city:safeString(d.shipping.city,120),state:safeString(d.shipping.state,4),reference:safeString(d.shipping.reference,250)},items,subtotal:money(subtotal),discount:money(discount),shippingCost:money(shipping),total,coupon:coupon?.code||null,notes:safeString(d.notes,1000),source:'site',createdAt:now(),updatedAt:now()};
    await saveRecord('orders',order,null);const customerId=`customer_${digits(order.customer.cpf)}`;const existing=await readJSON(`records/customers/${customerId}`,{});await saveRecord('customers',{...existing,id:customerId,name:order.customer.name,cpf:order.customer.cpf,phone:order.customer.phone,email:order.customer.email,lastOrderAt:now(),ordersCount:Number(existing.ordersCount||0)+1,totalSpent:money(Number(existing.totalSpent||0)+total),updatedAt:now()},null);
    const lines=items.map(i=>`• ${i.qty}x ${i.name}${Object.keys(i.attributes||{}).length?` (${Object.entries(i.attributes).map(([k,v])=>`${k}: ${v}`).join(', ')})`:''} — R$ ${i.total.toFixed(2).replace('.',',')}`);const address=`${order.shipping.street}, ${order.shipping.number}${order.shipping.complement?` — ${order.shipping.complement}`:''}, ${order.shipping.district}, ${order.shipping.city}/${order.shipping.state}, CEP ${order.shipping.cep}`;
    const msg=[`*NOVO PEDIDO ICANT — ${order.number}*`,``,...lines,``,`Subtotal: R$ ${order.subtotal.toFixed(2).replace('.',',')}`,`Desconto: R$ ${order.discount.toFixed(2).replace('.',',')}`,`Frete: R$ ${order.shippingCost.toFixed(2).replace('.',',')}`,`*TOTAL: R$ ${order.total.toFixed(2).replace('.',',')}*`,``,`Cliente: ${order.customer.name}`,`CPF: ${order.customer.cpf}`,`Telefone: ${order.customer.phone}`,`Endereço: ${address}`,``,`Pagamento: PIX enviado pelo atendimento.`,`Observação: ${order.notes||'Nenhuma'}`].join('\n');
    const whatsapp=digits(settings?.contact?.whatsapp||'5531972354299');return ok({order,whatsappUrl:`https://wa.me/${whatsapp}?text=${encodeURIComponent(msg)}`});
  }catch(error){console.error(error);return fail('Não foi possível criar o pedido.',500,error.message);}
};

export default { fetch: (request) => withVercelContext(request, handler) };
