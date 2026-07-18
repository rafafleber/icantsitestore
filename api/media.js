import { withVercelContext } from './_lib/context.js';
import { ok, fail, id, now, safeString, auth, requirePermission, writeJSON, readJSON, store, audit } from './_lib/core.js';

async function handler(req,context){
  try{
    const url=new URL(req.url);const mediaId=safeString(url.searchParams.get('id'),160);
    if(req.method==='GET'){
      if(!mediaId)return fail('Arquivo não informado.',400);const meta=await readJSON(`records/media/${mediaId}`);if(!meta||meta.deleted)return fail('Arquivo não encontrado.',404);
      const data=await store().get(`media/files/${mediaId}`,{type:'arrayBuffer'});if(!data)return fail('Arquivo não encontrado.',404);
      return new Response(data,{headers:{'content-type':meta.mime||'application/octet-stream','cache-control':'public,max-age=31536000,immutable','content-disposition':`inline; filename="${encodeURIComponent(meta.name||mediaId)}"`}});
    }
    const admin=await auth(context);if(!admin)return fail('Sessão inválida.',401);requirePermission(admin,'media','write');
    if(req.method==='POST'){
      const d=await req.json();const name=safeString(d.name||'arquivo',180),mime=safeString(d.mime||'application/octet-stream',120);const b64=String(d.dataBase64||'').replace(/^data:[^;]+;base64,/,'');
      const buf=Buffer.from(b64,'base64');if(!buf.length)return fail('Arquivo vazio.');if(buf.length>2*1024*1024)return fail('Arquivo acima de 2 MB. Comprima a imagem antes do envio.',413);
      const allowed=/^(image\/(jpeg|png|webp|gif|svg\+xml)|video\/mp4|application\/pdf)$/i;if(!allowed.test(mime))return fail('Tipo de arquivo não permitido.',415);
      const mid=id('media');await store().set(`media/files/${mid}`,buf,{metadata:{name,mime}});const meta={id:mid,name,mime,size:buf.length,alt:safeString(d.alt,300),tags:Array.isArray(d.tags)?d.tags:[],url:`/api/media?id=${mid}`,createdAt:now(),updatedAt:now()};await writeJSON(`records/media/${mid}`,meta);await audit(admin,'upload','media',mid,{name,size:buf.length});return ok({item:meta});
    }
    if(req.method==='DELETE'){
      const mid=mediaId;const meta=await readJSON(`records/media/${mid}`);if(!meta)return fail('Arquivo não encontrado.',404);meta.deleted=true;meta.updatedAt=now();await writeJSON(`records/media/${mid}`,meta);await store().delete(`media/files/${mid}`);await audit(admin,'delete','media',mid,{name:meta.name});return ok();
    }
    return fail('Método inválido.',405);
  }catch(error){console.error(error);return fail('Falha na mídia',500,error.message);}
};

export default { fetch: (request) => withVercelContext(request, handler) };
