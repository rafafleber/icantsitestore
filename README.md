# ICANT — GitHub + Vercel

Loja e painel administrativo Master preparados para deploy no Vercel.

## Publicar

1. Extraia o ZIP uma vez.
2. Envie todos os arquivos e pastas diretamente para a raiz de um repositório GitHub.
3. No Vercel, clique em **Add New → Project**, importe o repositório e clique em **Deploy**.
4. Após o primeiro deploy, no projeto abra **Storage → Create Database → Blob**.
5. Crie um Blob com acesso **Private**, conecte aos ambientes Production, Preview e Development.
6. Vá em **Deployments → Redeploy**.

O Vercel cria automaticamente a variável `BLOB_READ_WRITE_TOKEN` ao conectar o Blob. Não copie a chave para o código.

## Painel administrativo

Acesse `/admin`.

- E-mail autorizado: `briangabrielfsoares@gmail.com`
- Código único de ativação: `x8x7x7x5x`
- Na ativação, crie sua senha e configure o 2FA.

## Estrutura

- `index.html`, `assets/`, `admin/`: loja e painel
- `api/`: Vercel Functions
- `vercel.json`: rotas, segurança e funções
- `demo-data.json`: demonstração exibida antes do Blob ser conectado

## Armazenamento

Configurações, produtos, pedidos, clientes, mídia, administradores, auditoria, backups e demais registros são persistidos no **Vercel Blob privado**. O frontend continua abrindo em modo demonstração caso o Blob ainda não esteja conectado, mas o painel só salva depois da conexão.

## Segurança

- Senha com PBKDF2 e salt
- 2FA TOTP obrigatório
- Cookie HttpOnly, Secure e SameSite Strict
- Sessão com expiração
- Rate limiting
- Permissões administrativas
- Logs de auditoria
- Confirmação para ações críticas
- Dados e mídia privados no Blob

Não coloque tokens ou senhas no GitHub.
