"use strict";

// Is this address inside one of these CIDR blocks?
//
// Used to decide whether a request genuinely arrived through Cloudflare before
// believing the CF-Connecting-IP header it carries. Any client can send that
// header; only Cloudflare can send it *from* a Cloudflare address, because
// Cloudflare overwrites whatever the client supplied.
//
// Deliberately dependency-free and total: every helper returns null or false on
// anything it does not understand, so a malformed address can never be treated
// as trusted.

// Cloudflare's published edge ranges. Kept here so the default works out of the
// box, and overridable with TRUSTED_EDGE_CIDRS so the list can be refreshed
// without a code change if Cloudflare ever adds a block.
// Source: https://www.cloudflare.com/ips/
const CLOUDFLARE_CIDRS = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"
];

// An IPv4 address as a 32-bit BigInt, or null.
function ipv4ToBigInt(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

// An IPv6 address as a 128-bit BigInt, or null. Handles "::" compression and the
// IPv4-mapped form (::ffff:127.0.0.1) that Node hands back on a dual-stack
// socket — without this, every such address would look untrusted.
function ipv6ToBigInt(text) {
  let input = String(text);
  const mapped = input.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) {
    const tail = ipv4ToBigInt(mapped[2]);
    if (tail === null) return null;
    input = `${mapped[1]}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

// { value, bits } for either family, or null. An IPv4-mapped IPv6 address is
// normalised down to plain IPv4 so it compares against IPv4 CIDRs.
function parseAddress(text) {
  const address = String(text || "").trim().replace(/^\[|\]$/g, "").split("%")[0];
  if (!address) return null;
  const v4Mapped = address.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i);
  if (v4Mapped) {
    const value = ipv4ToBigInt(v4Mapped[1]);
    return value === null ? null : { value, bits: 32 };
  }
  if (address.includes(":")) {
    const value = ipv6ToBigInt(address);
    return value === null ? null : { value, bits: 128 };
  }
  const value = ipv4ToBigInt(address);
  return value === null ? null : { value, bits: 32 };
}

function parseCidr(text) {
  const [network, prefixText] = String(text || "").trim().split("/");
  const parsed = parseAddress(network);
  if (!parsed) return null;
  const prefix = prefixText === undefined ? parsed.bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) return null;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(parsed.bits - prefix);
  return { network: parsed.value & mask, mask, bits: parsed.bits };
}

function isInCidr(address, cidr) {
  const parsedAddress = parseAddress(address);
  const parsedCidr = typeof cidr === "string" ? parseCidr(cidr) : cidr;
  if (!parsedAddress || !parsedCidr) return false;
  if (parsedAddress.bits !== parsedCidr.bits) return false;
  return (parsedAddress.value & parsedCidr.mask) === parsedCidr.network;
}

function compileCidrs(list) {
  return (Array.isArray(list) ? list : String(list || "").split(","))
    .map((entry) => parseCidr(String(entry).trim()))
    .filter(Boolean);
}

module.exports = { CLOUDFLARE_CIDRS, parseAddress, parseCidr, isInCidr, compileCidrs };
