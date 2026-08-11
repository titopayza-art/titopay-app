"use strict";

class POSProviderAdapter {
  constructor(provider) {
    this.provider = provider;
  }

  async createPaymentRequest() {
    return { supported: false, reason: "Awaiting official acquiring-bank/POS integration specification." };
  }

  async notifyPaymentStatus() {
    return { supported: false, reason: "Awaiting official acquiring-bank/POS integration specification." };
  }

  async cancelPayment() {
    return { supported: false, reason: "Awaiting official acquiring-bank/POS integration specification." };
  }

  async reversePayment() {
    return { supported: false, reason: "Awaiting official acquiring-bank/POS integration specification." };
  }

  async verifyProviderRequest() {
    return false;
  }
}

module.exports = { POSProviderAdapter };
