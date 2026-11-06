# Third-party asset inventory

| Asset | Purpose | SHA-256 | Review requirement |
| --- | --- | --- | --- |
| `assets/jsQR.min.js` | Browser-side QR decoding | `6f139698c4ccab1764764600cc6d1baf12fa00f00ee4b8781e36ed337e0fda07` | Identify the upstream release, license and CVEs before replacing it; record the new hash here. |

The PHP edition has no Composer or npm manifest. Treat every changed vendored
asset as a supply-chain change: record source, version, license, checksum,
security review, and test evidence. Generate and retain an SBOM in the release
pipeline when the application moves to managed infrastructure.
