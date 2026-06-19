# Bot Discord MisticPay

Bot profissional em Node.js para integração com o gateway de pagamentos MisticPay pelo Discord.

## ✨ Novidades e Melhorias

- **Interface Visual:** Agora com Embeds mais bonitos e organizados.
- **Fluxo de Saque:** Novo sistema de menu de seleção (Select Menu) para escolher o tipo de chave Pix.
- **Privacidade:** O bot não solicita mais informações pessoais ou CPF no Discord para gerar cobranças.
- **Facilidade:** Sistema de "Pix Copia e Cola" formatado para fácil cópia no celular.

## 🛠️ Comandos

- `/pix`: Gera uma cobrança Pix instantânea (sem pedir CPF).
- `/sacar`: Inicia o fluxo de saque via Pix ou Crypto (USDT BEP20).
- `/saldo`: Consulta o saldo atual da sua conta MisticPay.

## 🚀 Como Usar

### Geração de Pix
1. Digite `/pix`.
2. Informe o valor desejado.
3. O bot gerará o QR Code e o código Copia e Cola automaticamente.

### Realização de Saques
1. Digite `/sacar`.
2. Selecione o método (Pix ou Crypto).
3. Se escolher Pix, selecione o tipo de chave (CPF, E-mail, etc.).
4. Informe os dados no formulário que aparecerá.
5. Confirme os dados no resumo antes de enviar.

## ⚙️ Configuração

Certifique-se de configurar as variáveis no arquivo `.env`:

```env
DISCORD_TOKEN=seu_token
DISCORD_CLIENT_ID=seu_id
MISTICPAY_CLIENT_ID=seu_id
MISTICPAY_CLIENT_SECRET=seu_secret
MISTICPAY_DEFAULT_PAYER_DOCUMENT=cpf_para_gerar_pix
```

## 📦 Deploy na Discloud

O projeto já está configurado para a [Discloud](https://discloudbot.com/).

1. Compacte os arquivos (exceto `node_modules`).
2. Faça o upload do `.zip`.
3. Configure as variáveis de ambiente no painel.

---
Desenvolvido para MisticPay.
