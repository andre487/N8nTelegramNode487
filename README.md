# N8nTelegramNode487

An MIT-licensed n8n node for uploading **2–10 JPEG/PNG images as one Telegram album**, or a rich message containing text and JPEG/PNG documents.
Uses the existing **Telegram API** credential. No bot token in workflow JSON, environment
variable, intermediary chat or public image storage is required.

## Use

Add **Telegram Album 487**, select your Telegram credential, enter **Chat ID**, and list
**Binary Fields** in album order, for example `image0,image1,image2` or
`{{ Object.keys($binary).join(',') }}`. Each input item represents one album. Output is
`{ messages: [...] }`, with input item linking preserved. A successful response must contain
a message for every image. Network/API errors fail the node; no automatic request retry is
performed inside the node, since retrying a sent album can duplicate messages.

Choose **Send Rich Message** to send text and files together. Supply Telegram
`InputRichMessage` JSON in **Rich Message** and reference the binary fields in order as
`attach://file0`, `attach://file1`, etc. For example:

```json
{"blocks":[
  {"type":"paragraph","text":"Notification text"},
  {"type":"document","document":{"type":"document","media":"attach://file0"},"caption":{"text":"Avatar"}},
  {"type":"document","document":{"type":"document","media":"attach://file1"},"caption":{"text":"Application icon"}}
]}
```

A rich-message request returns `{ message: {...} }`, representing one message. Each file
must be JPEG/PNG; up to ten can be attached. Text-only rich messages may leave Binary Fields
empty. Requires Telegram Bot API support for Rich Messages, including document blocks
(Bot API 10.3+). Client rendering varies by Telegram version. Old saved album nodes keep
working without setting the new Operation field.


Use the standard node for individual photos, documents and text. Albums larger than ten
must be split upstream; a remaining single image must use **Send Photo**.

Uses n8n's binary helpers for inline/filesystem/external binary storage. Stored images are
streamed; inline images are decoded one at a time. Telegram's photo limits apply, including
10 MB per photo, dimension sum at most 10000 and aspect ratio at most 20. Sending as photos
allows Telegram to process the images; use documents when exact source bytes are needed.
The node uses the credential's Base URL, n8n's HTTP helper, a 30-second timeout, and disables
redirects. Transport errors are redacted to avoid exposing the bot token in request URLs.

## Install privately in self-hosted n8n

No public npm publication is needed. Requires Node.js 22 or later. The npm package name is
`n8n-nodes-telegram487`; the repository name is `N8nTelegramNode487`.

```sh
npm ci --ignore-scripts
npm test
npm pack
```

The tarball bundles the runtime dependency. Extract it into its own persistent custom
extension directory, for example:

```sh
mkdir -p ~/.n8n/custom/TelegramAlbum487
tar -xzf n8n-nodes-telegram487-0.2.0.tgz --strip-components=1 -C ~/.n8n/custom/TelegramAlbum487
```

Restart n8n to load it.
For Docker, persist `/home/node/.n8n`; install as the container's `node` user. Install on every
process that executes workflows, including workers in queue mode. External Code task runners
do not load this node. See [n8n private node installation](https://docs.n8n.io/integrations/creating-nodes/deploy/install-private-nodes/).

When loaded from the custom extension directory, the workflow node type is
`CUSTOM.telegramAlbum487`. When installed through n8n's community package loader, it is
`n8n-nodes-telegram487.telegramAlbum487`. The package has not been published to npm.

Keep the Telegram credential in n8n; do not export decrypted credentials to install this node.
Installing the node does not activate or change workflows.

## Tests

`npm test` verifies multipart bytes against a local HTTP server, inline and stored binary
sources, input validation, item linking, failed/incomplete responses, rate limiting, stream
cleanup and credential redaction. It sends no requests to Telegram.

To exercise the installed n8n HTTP implementation inside a container, set
`N8N_HTTP_HELPER_PATH` to the module that exports its `httpRequest` helper and run the tests.
