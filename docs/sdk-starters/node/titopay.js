"use strict";

/*
 * TitoPay POS starter client - Node.js 18+ (built-in fetch), zero deps.
 *
 * const titopay = new TitoPay({
 *   baseUrl: "https://api-sandbox.titopay.co.za",
 *   terminalId: "SBX-TERM-01",
 *   terminalSecret: process.env.TITOPAY_TERMINAL_SECRET,
 *   merchantId: "TPM-SBX-ABC123"
 * });
 * const payment = await titopay.createPayment({ amount: 149.5, merchantReference: "TILL-7" });
 * // show payment.qrPayload as a QR; poll or take the webhook:
 * const status = await titopay.getPayment(payment.paymentId);
 */

const crypto = require("crypto");

class TitoPay {
  constructor({ baseUrl, terminalId, terminalSecret, merchantId }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.terminalId = terminalId;
    this.terminalSecret = terminalSecret;
    this.merchantId = merchantId;
  }

  sign(method, path, body) {
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const bodyHash = crypto.createHash("sha256").update(body || "").digest("hex");
    const canonical = [timestamp, nonce, method.toUpperCase(), path, bodyHash].join("\n");
    const signature = crypto.createHmac("sha256", this.terminalSecret).update(canonical).digest("hex");
    return {
      "x-titopay-terminal-id": this.terminalId,
      "x-titopay-timestamp": timestamp,
      "x-titopay-nonce": nonce,
      "x-titopay-signature": `sha256=${signature}`
    };
  }

  async request(method, path, payload) {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const headers = this.sign(method, path, body);
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = crypto.randomUUID();
    }
    const response = await fetch(this.baseUrl + path, {
      method, headers, body: payload === undefined ? undefined : body
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) {
      throw new Error(`${json.error || "Request failed"} (HTTP ${response.status})`);
    }
    return json;
  }

  async createPayment({ amount, merchantReference, currency = "ZAR" }) {
    const result = await this.request("POST", "/v1/pos/payment-intents", {
      merchantId: this.merchantId, terminalId: this.terminalId,
      amount, currency, merchantReference
    });
    return result.payment;
  }

  async getPayment(paymentId) {
    const result = await this.request("GET", `/v1/pos/payment-intents/${paymentId}`);
    return result.payment || result;
  }

  async cancelPayment(paymentId) {
    return this.request("POST", `/v1/pos/payment-intents/${paymentId}/cancel`, {});
  }

  // Webhook verification: constant-time, timestamp-bounded, rotation-aware.
  static verifyWebhook({ headers, rawBody, secret, previousSecret, toleranceMs = 5 * 60 * 1000 }) {
    const timestamp = headers["x-titopay-timestamp"];
    const eventId = headers["x-titopay-event-id"];
    if (Math.abs(Date.now() - Number(timestamp)) > toleranceMs) return false;
    const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
    const expect = (key) => crypto.createHmac("sha256", key)
      .update(`${timestamp}\n${eventId}\n${bodyHash}`).digest("hex");
    const matches = (headerName, key) => {
      const received = String(headers[headerName] || "").replace(/^sha256=/, "");
      const expected = expect(key);
      return received.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
    };
    if (matches("x-titopay-signature", secret)) return true;
    return Boolean(previousSecret) && matches("x-titopay-signature-previous", previousSecret);
  }
}

module.exports = { TitoPay };
