import express from 'express';
import crypto from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 3000);
const live = process.env.EULEN_LIVE_ENABLED === 'true';
const cfg = {
  platformFeePct: Number(process.env.PLATFORM_FEE_PERCENTAGE || 0.5),
  eulenFeeCents: Number(process.env.EULEN_FEE_CENTS || 99),
  firstLimitCents: Number(process.env.FIRST_PURCHASE_LIMIT_CENTS || 50000),
  dailyLimitCents: Number(process.env.DAILY_LIMIT_CENTS || 600000)
};
const orders = new Map();

app.use(express.json());
app.use(express.static(new URL('../public', import.meta.url).pathname));

const onlyDigits = value => String(value || '').replace(/\D/g, '');
function validCpf(cpf) {
  cpf = onlyDigits(cpf);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;
  for (let pos = 9; pos < 11; pos++) {
    let sum = 0;
    for (let i = 0; i < pos; i++) sum += Number(cpf[i]) * (pos + 1 - i);
    const digit = (sum * 10) % 11 % 10;
    if (digit !== Number(cpf[pos])) return false;
  }
  return true;
}
function quote(amountCents, asset) {
  const fee = Math.round(amountCents * cfg.platformFeePct / 100);
  const net = amountCents - fee - cfg.eulenFeeCents;
  const rate = asset === 'USDT' ? 5.55 : 5.57;
  return { feeCents: fee, providerFeeCents: cfg.eulenFeeCents, netCents: Math.max(0, net), rate, estimatedCrypto: Math.max(0, net) / 100 / rate };
}
function totalToday(cpf) {
  const start = new Date(); start.setHours(0,0,0,0);
  return [...orders.values()].filter(o => o.cpf === cpf && new Date(o.createdAt) >= start && !['FAILED','EXPIRED'].includes(o.status)).reduce((s,o) => s + o.amountCents, 0);
}
function firstOrder(cpf) {
  return [...orders.values()].filter(o => o.cpf === cpf).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}
function admin(req, res, next) {
  if (!process.env.ADMIN_TOKEN || req.header('x-admin-token') !== process.env.ADMIN_TOKEN) return res.status(401).json({error:'Não autorizado'});
  next();
}

app.get('/api/config', (_, res) => res.json({live, platformFeePct: cfg.platformFeePct, eulenFeeCents: cfg.eulenFeeCents}));
app.post('/api/quote', (req, res) => {
  const amountCents = Math.round(Number(req.body.amountBrl) * 100);
  const asset = req.body.asset;
  if (!Number.isInteger(amountCents) || amountCents <= 0 || !['USDT','USDC'].includes(asset)) return res.status(400).json({error:'Dados de cotação inválidos'});
  res.json(quote(amountCents, asset));
});
app.post('/api/orders', async (req, res) => {
  const {name, cpf: rawCpf, asset, network, wallet, amountBrl} = req.body;
  const cpf = onlyDigits(rawCpf);
  const amountCents = Math.round(Number(amountBrl) * 100);
  if (!name || !validCpf(cpf) || !['USDT','USDC'].includes(asset) || !network || !wallet || !Number.isInteger(amountCents)) return res.status(400).json({error:'Preencha os dados corretamente.'});
  const first = firstOrder(cpf);
  if (!first && amountCents > cfg.firstLimitCents) return res.status(400).json({error:'A primeira compra é limitada a R$ 500,00.'});
  if (first) {
    const unlockAt = new Date(new Date(first.createdAt).getTime() + 24 * 60 * 60 * 1000);
    if (new Date() < unlockAt) return res.status(400).json({error:`Cadastro em validação. Nova compra liberada após ${unlockAt.toLocaleString('pt-BR')}.`});
    const prior = totalToday(cpf);
    if (amountCents > cfg.dailyLimitCents - prior) return res.status(400).json({error:'Limite diário disponível insuficiente para este CPF.'});
  }
  const q = quote(amountCents, asset);
  if (q.netCents <= 0) return res.status(400).json({error:'Valor não cobre as taxas.'});
  const id = crypto.randomUUID();
  const order = {id, name, cpf, asset, network, wallet, amountCents, ...q, createdAt:new Date().toISOString(), status:'CREATED', history:[{at:new Date().toISOString(),status:'CREATED'}]};
  orders.set(id, order);
  if (live) return res.status(503).json({error:'Integração real ainda não implementada: não foi criado Pix.', orderId:id});
  order.status='PIX_PENDING'; order.history.push({at:new Date().toISOString(),status:'PIX_PENDING'});
  res.status(201).json({orderId:id, status:order.status, testMode:true, message:'Ordem criada em modo de teste. Nenhum Pix foi gerado.'});
});
app.get('/api/orders/:id', (req,res) => { const o=orders.get(req.params.id); if(!o) return res.status(404).json({error:'Ordem não encontrada'}); res.json(o); });
app.get('/api/admin/orders', admin, (_,res) => res.json([...orders.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))));
app.post('/api/admin/orders/:id/status', admin, (req,res) => { const o=orders.get(req.params.id); const allowed=['PIX_PENDING','PIX_PAID','DEPIX_RECEIVED','CONVERSION_PENDING','CONVERTED','CRYPTO_SENDING','COMPLETED','FAILED','EXPIRED','MANUAL_REVIEW']; if(!o || !allowed.includes(req.body.status)) return res.status(400).json({error:'Status inválido'}); o.status=req.body.status; o.txid=req.body.txid || o.txid; o.history.push({at:new Date().toISOString(),status:o.status}); res.json(o); });
app.post('/webhooks/eulen/deposit', (req,res) => {
  const expected = process.env.EULEN_WEBHOOK_SECRET;
  const got = req.header('authorization');
  if (!expected || got !== `Basic ${expected}`) return res.sendStatus(401);
  const {qrId,status,blockchainTxID} = req.body || {};
  const o = [...orders.values()].find(x => x.eulenDepositId === qrId);
  if (o && ['approved','depix_sent','under_review','delayed','refunded','expired','canceled','error'].includes(status)) { o.status = status === 'approved' ? 'PIX_PAID' : status === 'depix_sent' ? 'DEPIX_RECEIVED' : status.toUpperCase(); o.eulenBlockchainTxid = blockchainTxID; o.history.push({at:new Date().toISOString(),status:o.status}); }
  res.sendStatus(200);
});
app.listen(port, () => console.log(`DePix MVP disponível em http://localhost:${port} | modo real: ${live}`));
