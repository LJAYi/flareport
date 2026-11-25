# Upstream attribution

This template adapts [oomol-lab/open-connector](https://github.com/oomol-lab/open-connector) release `v1.10.1` at commit `d3ecfdd8bed43ee83f04bf04ec69fb50e25ddc62`.

This release uses the **OpenConnector License**, a modified Apache-2.0 license with additional conditions, including restrictions on providing hosted or managed connector services to third parties without OOMOL's written authorization. It must not be described as unmodified Apache-2.0. Releases up to v1.9.4 remain under Apache-2.0.

Read the preserved [license](licenses/open-connector/LICENSE.txt), [Apache-2.0 text](licenses/open-connector/LICENSE-APACHE-2.0.txt), and [notices](licenses/open-connector/NOTICE.md) before use. FlarePort's original tooling is MIT; it does not relicense upstream code. FlarePort is not the upstream project and does not claim official endorsement.

The reviewed catalog overlay in `patches/cloudflare-catalog.patch` is carried from [LJAYi/open-connector-cloudflare](https://github.com/LJAYi/open-connector-cloudflare/blob/5bcb0d8683521e995f91e200aea4f4a8ee96e689/.github/patches/cloudflare-catalog.patch). It modifies catalog generation, lazy schema loading and request-local read coalescing in the downloaded build workspace, not the upstream repository. These upstream-derived modifications remain subject to the upstream license. The overlay also changes static asset cache headers to require revalidation. Patch conflicts fail the build instead of silently dropping the optimizations.

Two non-runtime documentation symlinks (`CLAUDE.md` and `.claude/skills/add-provider`) are omitted only when their targets match the reviewed aliases. No symlink is extracted; other links and special files remain forbidden. Source archives still require an immutable commit and SHA-256 verification.
