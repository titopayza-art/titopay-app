"use strict";

const ACTIVE_ACCOUNT_STATUSES = new Set(["active", "verified", "approved"]);
const BLOCKED_ACCOUNT_STATUSES = new Set(["blocked", "closed", "deleted", "inactive", "suspended"]);
const VERIFIED_KYC_STATUSES = new Set(["approved", "verified", "complete", "completed"]);

function isVerifiedTitoPayUser(user) {
  if (!user) return false;
  const accountStatus = String(user.status || user.accountStatus || user.account_status || "").toLowerCase();
  const kycStatus = String(
    user.fica_status ||
    user.ficaStatus ||
    user.kyc_status ||
    user.kycStatus ||
    user.verification_status ||
    user.verificationStatus ||
    ""
  ).toLowerCase();
  const active = (!accountStatus || ACTIVE_ACCOUNT_STATUSES.has(accountStatus)) && !BLOCKED_ACCOUNT_STATUSES.has(accountStatus);
  const verified = user.verified === true ||
    user.is_verified === true ||
    user.isVerified === true ||
    Boolean(user.wallet_id || user.walletId || user.wallet_number || user.walletNumber) ||
    Boolean(user.verified_at || user.verifiedAt) ||
    VERIFIED_KYC_STATUSES.has(kycStatus) ||
    ["verified", "approved"].includes(accountStatus);
  return Boolean(active && verified);
}

module.exports = { isVerifiedTitoPayUser };
