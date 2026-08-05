# Contributing

FlarePort accepts adapters only for public open-source projects that can be deployed reproducibly on Cloudflare Workers.

An adapter contribution must include:

- upstream repository, license, stable release, full commit SHA, and archive checksum;
- every required Cloudflare service and user input;
- an isolated template directory suitable for a Deploy to Cloudflare subdirectory URL;
- upstream attribution and a clear boundary between upstream and adapter support;
- automated validation with no production credentials;
- a conservative default update policy.

Do not submit floating `main`, `master`, `latest`, or unverified archive URLs. Do not place real secret values, Cloudflare resource identifiers, or user data in fixtures.

Run before opening a pull request:

```bash
npm install
npm run check
```
