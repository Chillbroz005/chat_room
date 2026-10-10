# Security hardening notes

## Account authentication rate limits

Account signup and login requests are limited to 20 attempts per client IP and 10 attempts per normalized username in a rolling 15-minute window. Attempt identifiers are SHA-256 hashed before storage. Old attempts are cleaned up opportunistically.

### Required deployment step

Apply `migrations/0008_account_auth_attempts.sql` to the Cloudflare D1 database configured as `DB` before deploying the matching API code. For example, from a configured Wrangler project:

```sh
npx wrangler d1 migrations apply <YOUR_D1_DATABASE_NAME> --remote
```

Replace the placeholder with the database name in your Wrangler configuration. Back up production data and verify the target database before applying migrations. Do not deploy the API change before the migration: account login/signup will fail until the table exists.

## Security headers

Cloudflare Pages reads the root `_headers` file for static asset responses. The API also returns defensive headers itself. The CSP allows the local app module, inline styles used by the existing UI, Google Fonts, HTTPS images, and GIPHY API requests. Review new third-party integrations against this policy rather than broadly adding `*` sources.

## Password compatibility

New room passwords require at least eight characters in both the browser and API. Existing room password hashes and verification settings are unchanged, so existing rooms retain compatibility.

## Operational verification checklist

- Apply migration to the intended D1 database and confirm the table and indexes exist.
- Verify signup/login success, incorrect-password responses, and HTTP 429 after the configured thresholds.
- Confirm existing accounts and password-protected rooms still work.
- Check the browser console/network panel for CSP violations across room creation, chat, Google Fonts, and GIF/sticker search.
- Verify error responses do not expose exception messages.
- Test mobile layout, keyboard navigation, screen-reader labels, and image/media rendering after deployment.
- Keep `SESSION_SECRET` and `MASTER_ADMIN_CODE` in Cloudflare secrets; never commit real values.
