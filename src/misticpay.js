export class MisticPayError extends Error {
  constructor(message, { status, response } = {}) {
    super(message);
    this.name = "MisticPayError";
    this.status = status;
    this.response = response;
  }
}

export class MisticPayClient {
  constructor({ clientId, clientSecret, baseUrl, timeoutMs = 20000 }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async createTransaction(payload) {
    return this.request("/transactions/create", {
      method: "POST",
      body: payload,
    });
  }

  async withdraw(payload) {
    return this.request("/transactions/withdraw", {
      method: "POST",
      body: payload,
    });
  }

  async cryptoWithdraw(payload) {
    return this.request("/crypto/withdraw-api", {
      method: "POST",
      body: payload,
    });
  }

  async getCryptoFees() {
    return this.request("/crypto/fees");
  }

  async getBalance() {
    return this.request("/users/balance");
  }

  async getUserInfo() {
    return this.request("/users/info");
  }

  async checkTransaction(transactionId) {
    return this.request("/transactions/check", {
      method: "POST",
      body: { transactionId },
    });
  }

  async listTransactions({ page = 1, status } = {}) {
    const query = status ? { status } : undefined;
    return this.request(`/users/transactions/list/${page}`, { query });
  }

  async request(path, { method = "GET", body, query } = {}) {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          ci: this.clientId,
          cs: this.clientSecret,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const raw = await response.text();
      const parsed = parseJson(raw);

      if (!response.ok) {
        throw new MisticPayError(resolveErrorMessage(parsed, raw, response.status), {
          status: response.status,
          response: parsed ?? raw,
        });
      }

      return parsed;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new MisticPayError("Tempo limite atingido ao chamar a MisticPay.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveErrorMessage(parsed, raw, status) {
  if (parsed?.message) return parsed.message;
  if (parsed?.error) return parsed.error;
  if (raw) return raw;
  return `Erro HTTP ${status} na MisticPay.`;
}
