# Bot Discord MisticPay

Bot em Node.js para operar MisticPay pelo Discord.

## Comandos

- `/pix`: abre formulario e gera uma cobranca Pix.
- `/sacar`: abre formulario para saque Pix ou crypto USDT BEP20.
- `/saldo`: consulta saldo disponivel na MisticPay.

## Como usar

### Pix

Use `/pix` e preencha:

- Valor
- Descricao opcional
- Se a resposta deve ser publica no canal

O bot nao pede CPF no Discord. Ele usa o documento cadastrado na conta MisticPay. Se precisar sobrescrever, configure `MISTICPAY_DEFAULT_PAYER_DOCUMENT` no `.env`.

### Saque

Use `/sacar` e preencha:

- Tipo: `pix` ou `crypto`
- Valor em reais
- Destino: chave Pix ou wallet `0x...`
- Detalhe: para Pix use `cpf`, `cnpj`, `email`, `telefone` ou `aleatoria`; para crypto pode deixar `usdt`
- Descricao opcional

Depois do formulario, o bot mostra uma confirmacao para o proprio usuario. Ao confirmar, o saque e enviado para a MisticPay.

## Rodar

```bash
npm install
npm run deploy-commands
npm start
```

## Endpoints usados

- `POST /api/transactions/create`
- `POST /api/transactions/withdraw`
- `POST /api/crypto/withdraw-api`
- `GET /api/crypto/fees`
- `GET /api/users/balance`
- `GET /api/users/info`
