# DePix Pay — integração Eulen

Aplicação Node/Express focada exclusivamente no fluxo Pix → DePix da Eulen.

## O que está pronto

- Client Credentials: login e renovação segura de token curto.
- Criação de depósito Pix (`POST /deposit`) e exibição do Pix copia-e-cola.
- Consulta de depósito (`GET /deposit-status`).
- Webhook de depósito (`POST /webhooks/eulen/deposit`).
- Registro de `id`, `X-Nonce` e `X-Request-ID` da Eulen.
- Modo `sandbox` sem chamadas externas para testar a interface.

## Configuração

```bash
npm install
cp .env.example .env
npm start
```

Para teste real, configure no servidor (nunca no GitHub):

```env
PROVIDER_MODE=live
EULEN_CLIENT_ID=...
EULEN_CLIENT_SECRET=...
EULEN_WEBHOOK_SECRET=...
ADMIN_TOKEN=...
```

Crie as credenciais no bot da Eulen com escopo mínimo `deposit`. A Eulen recomenda Client Credentials para integrações novas. Configure no painel Eulen o webhook HTTPS:

`https://SEU-DOMINIO/webhooks/eulen/deposit`

## Endpoints

- `GET /health`
- `POST /api/payments` — recebe `amountInCents` e `depixAddress` opcional.
- `GET /api/payments/:id`
- `POST /webhooks/eulen/deposit`
- `GET /api/admin/payments` — requer `x-admin-token`.
- `POST /api/admin/eulen/ping` — requer `x-admin-token`.

## Segurança operacional

Eulen não possui idempotência em `POST /deposit`: após timeout ou erro de rede, não reenvie automaticamente. Guarde a operação, consulte o status e use webhooks como fonte principal. Esta base armazena pagamentos em memória; antes de produção, substitua por banco de dados e armazenamento seguro de refresh tokens.
