# Known issues

Tracked problems to fix later. Add new ones at the top.

## Uploaded files are reachable by link without an access check

**Status:** open, accepted for now (2026-11-05). Tracked on GitHub: see link below.

`GET /api/v1/files/:id` serves any uploaded file to anyone who has its URL. There is no login or sharing check; the only protection is that the file ID is a random UUID. This lets images and attachments render on public and email-shared pages, but it also means:

- Someone who was given a file URL (or saw it on a shared page) can still download it after their access is revoked or the page is unpublished.
- File URLs copied out of a private page work for anyone they're forwarded to.

**Fix outline:** record which page each upload belongs to (`files.page_id`, set by the editor/property uploaders and back-filled by scanning page content), then authorise `GET /files/:id` the same way as the page: signed-in viewers via `pageLevel`, public/email-share viewers via `publicAccess` (password/expiry/session cookies). Optionally serve S3 objects through short-lived presigned URLs instead of streaming.
