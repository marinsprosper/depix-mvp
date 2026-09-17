import crypto from 'node:crypto';
import express from 'express';

const app = express();
const port = Number(process.env.PORT || 3000);
const mode = process.env.PROVIDER_MODE || 'sandbox';
const payments = new Map();
const cfg = {
  platformName: process.env.PLATFORM_NAME || 'DePix Pay',
  adminToken: process.env.ADMIN_TOKEN || '',
  eulen: {
    baseUrl: process.env.EULEN_BASE_URL || 'https://depix.eulen.app/api',
    clientId: process.env.EULEN_CLIENT_ID || '',
    clientSecret: process.env.EULEN_CLIENT_SECRET || '',
    webhookSecret: process.env.EULEN_WEBHOOK_SECRET || ''
  }
};
let session = null;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(new URL('../public', import.meta.url).pathname));
const now = () => new Date().toISOString();
const ready = () => Boolean(cfg.eulen.clientId && cfg.eulen.clientSecret);
const publicPayment = ({ internal, ...payment }) => payment;
const update = (payment, status, detail = '') => { payment.status = status; payment.updatedAt = now(); payment.history.push({ at: payment.updatedAt, status, detail }); };

async function accessToken() {
  if (!ready()) throw new Error('Credenciais Eulen não configuradas.');
  if (session?.accessToken && Date.now() < session.expiresAt - 60_000) return session.accessToken;
  const refresh = Boolean(session?.refreshToken);
  const endpoint = refresh ? '/v2/auth/refresh' : '/v2/auth/login';
  const body = refresh ? { refresh_token: session.refreshToken } : { client_id: cfg.eulen.clientId, client_secret: cfg.eulen.clientSecret, grant_type: 'client_credentials' };
  const response = await fetch(`${cfg.eulen.baseUrl}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) { session = null; throw new Error(payload.errorMessage || payload.error || `Eulen respondeu ${response.status}`); }
  session = { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: Date.now() + Number(payload.expires_in || 0) * 1000 };
  return session.accessToken;
}
async function eulen(path, { method = 'GET', body } = {}) {
  const token = await accessToken();
  const response = await fetch(`${cfg.eulen.baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  const payload = await response.json().catch(() => ({}));
  const error = payload.errorMessage || payload.response?.errorMessage;
  if (!response.ok || error) throw new Error(error || `Eulen respondeu ${response.status}`);
  return { data: payload.response, nonce: response.headers.get('x-nonce'), requestId: response.headers.get('x-request-id') };
}
function admin(req, res, next) { if (!cfg.adminToken || req.header('x-admin-token') !== cfg.adminToken) return res.status(401).json({ error: 'Não autorizado.' }); next(); }

app.get('/health', (_, res) => res.json({ ok: true, provider: 'eulen', mode, credentialsConfigured: ready(), tokenCached: Boolean(session), at: now() }));
app.get('/api/config', (_, res) => res.json({ platformName: cfg.platformName, provider: 'eulen', mode, credentialsConfigured: ready() }));
app.post('/api/payments', async (req, res) => {
  const amountInCents = Number(req.body.amountInCents);
  const depixAddress = String(req.body.depixAddress || '').trim();
  if (!Number.isInteger(amountInCents) || amountInCents <= 0) return res.status(400).json({ error: 'amountInCents deve ser um inteiro maior que zero.' });
  if (depixAddress && !/^(lq1|ark1|spark1)/.test(depixAddress)) return res.status(400).json({ error: 'Endereço DePix deve começar com lq1, ark1 ou spark1.' });
  const payment = { id: crypto.randomUUID(), createdAt: now(), updatedAt: now(), status: 'creating', amountInCents, depixAddress: depixAddress || null, provider: mode === 'live' ? 'eulen' : 'sandbox', qrCopyPaste: null, qrImageUrl: null, eulenDepositId: null, history: [], internal: {} };
  try {
    if (mode === 'live') {
      // Eulen não oferece idempotência para depósito: nunca repetir automaticamente esta chamada.
      const result = await eulen('/deposit', { method: 'POST', body: { amountInCents, ...(depixAddress ? { depixAddress } : {}) } });
      payment.eulenDepositId = result.data.id; payment.qrCopyPaste = result.data.qrCopyPaste; payment.qrImageUrl = result.data.qrImageUrl || null; payment.internal = { nonce: result.nonce, requestId: result.requestId };
      update(payment, 'pending', 'QR Pix criado pela Eulen.');
    } else { payment.eulenDepositId = `sandbox-${payment.id}`; payment.qrCopyPaste = 'SANDBOX: nenhum Pix real será criado'; update(payment, 'sandbox_pending', 'Pagamento simulado criado.'); }
    payments.set(payment.id, payment); res.status(201).json({ payment: publicPayment(payment) });
  } catch (error) { update(payment, 'create_unknown', 'A criação falhou ou ficou incerta; não reenvie automaticamente.'); payments.set(payment.id, payment); res.status(502).json({ error: error.message, payment: publicPayment(payment) }); }
});
app.get('/api/payments/:id', async (req, res) => {
  const payment = payments.get(req.params.id); if (!payment) return res.status(404).json({ error: 'Pagamento não encontrado.' });
  if (mode === 'live' && payment.eulenDepositId && !['approved', 'depix_sent', 'expired', 'refunded', 'canceled', 'error'].includes(payment.status)) try { const result = await eulen(`/deposit-status?id=${encodeURIComponent(payment.eulenDepositId)}`); if (result.data.status && result.data.status !== payment.status) update(payment, result.data.status, 'Status consultado na Eulen.'); } catch { /* preserve last known status */ }
  res.json({ payment: publicPayment(payment) });
});
app.get('/api/admin/payments', admin, (_, res) => res.json({ payments: [...payments.values()].map(publicPayment) }));
app.post('/webhooks/eulen/deposit', (req, res) => {
  if (!cfg.eulen.webhookSecret || req.header('x-webhook-secret') !== cfg.eulen.webhookSecret) return res.sendStatus(401);
  const body = req.body || {}; const payment = [...payments.values()].find(item => item.eulenDepositId === body.id);
  if (payment && body.status && body.status !== payment.status) update(payment, body.status, 'Webhook de depósito recebido.');
  res.sendStatus(204);
});
app.post('/api/admin/eulen/ping', admin, async (_, res) => { try { const result = await eulen('/ping'); res.json({ ok: true, provider: result.data }); } catch (error) { res.status(502).json({ error: error.message }); } });
app.listen(port, () => console.log(`${cfg.platformName} em http://localhost:${port} | ${mode}`));
