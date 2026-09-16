# MVP DePix → USDT/USDC

Protótipo seguro: cria ordens em memória e **não** chama a Eulen enquanto `EULEN_LIVE_ENABLED=false`.

## Limites do MVP

- Primeira compra: até R$ 500,00.
- Janela de validação: após a primeira compra, novas compras ficam bloqueadas por 24 horas.
- Depois da validação: até R$ 6.000,00 por CPF a cada dia.

## Executar

```bash
npm install
cp .env.example .env
set -a; . ./.env; set +a
npm start
```

Abra `http://localhost:3000`.

## Onde inserir credenciais

No painel de variáveis de ambiente da Hostinger, crie `EULEN_CLIENT_ID` e `EULEN_CLIENT_SECRET`. Não envie segredos por chat e nunca ative `EULEN_LIVE_ENABLED=true` antes de implementar, revisar e registrar o webhook HTTPS.

## Limites conhecidos

Esta versão não movimenta dinheiro, não persiste dados após reinício e não converte DePix para USDT/USDC. A API Eulen entrega DePix; a rota de liquidez e o envio de stablecoin ainda exigem validação operacional e jurídica antes de automação.
