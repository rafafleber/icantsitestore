import { withVercelContext } from './_lib/context.js';
import { ok, fail, readJSON, writeJSON, listRecords, defaultSettings, defaultProducts } from './_lib/core.js';

async function ensureSeed(){
  let settings=await readJSON('config/settings');
  if(!settings){ settings=defaultSettings(); await writeJSON('config/settings',settings,{onlyIfNew:true}).catch(()=>{}); }
  const products=await listRecords('products');
  if(products.length===0){ for(const p of defaultProducts()) await writeJSON(`records/products/${p.id}`,p,{onlyIfNew:true}).catch(()=>{}); }
  const pages=await listRecords('pages');
  if(pages.length===0){
    const now=new Date().toISOString();
    const defaults=[
      {id:'sobre',title:'Sobre a ICANT',slug:'sobre',status:'published',content:'A ICANT é uma loja de streetwear criada para transformar atitude em movimento. CANT? MAKE IT CAN.',seoTitle:'Sobre a ICANT',seoDescription:'Conheça a ICANT.',order:1,createdAt:now,updatedAt:now},
      {id:'faq',title:'Perguntas frequentes',slug:'faq',status:'published',content:'Fale com nosso atendimento para tirar dúvidas sobre produtos, pedidos, frete e trocas.',order:2,createdAt:now,updatedAt:now},
      {id:'trocas',title:'Política de trocas',slug:'trocas',status:'published',content:'Trocas disponíveis. O prazo e as condições podem ser atualizados pelo painel administrativo.',order:3,createdAt:now,updatedAt:now}
    ];
    for(const p of defaults) await writeJSON(`records/pages/${p.id}`,p,{onlyIfNew:true}).catch(()=>{});
  }
  return settings;
}

async function handler() {
  try{
    const settings=await ensureSeed();
    const [products,categories,pages,drops,outfits,testimonials,coupons,reviews]=await Promise.all([
      listRecords('products'),listRecords('categories'),listRecords('pages'),listRecords('drops'),listRecords('outfits'),listRecords('testimonials'),listRecords('coupons'),listRecords('reviews')
    ]);
    const live=(x)=>{
      if(x.archived||x.active===false||x.status==='draft'||x.status==='hidden')return false;
      const at=x.publishAt||x.scheduledAt;
      if((x.status==='scheduled'||at)&&at&&new Date(at)>new Date())return false;
      const end=x.endsAt||x.availableUntil;
      if(end&&new Date(end)<new Date())return false;
      return true;
    };
    return ok({settings,products:products.filter(live),categories:categories.filter(live),pages:pages.filter(x=>live(x)&&(x.status==='published'||x.status==='scheduled')),drops:drops.filter(x=>live(x)&&(x.status==='published'||x.active)),outfits:outfits.filter(x=>live(x)&&(x.status==='published'||x.active)),testimonials:testimonials.filter(x=>live(x)&&(x.status==='published'||x.active)),coupons:coupons.filter(live),reviews:reviews.filter(x=>live(x)&&x.status==='published')});
  }catch(error){return fail('Falha ao carregar a loja',500,error.message);}
};

export default { fetch: (request) => withVercelContext(request, handler) };
