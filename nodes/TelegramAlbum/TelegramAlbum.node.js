'use strict';

const FormData = require('form-data');

class TelegramAlbum {
  description = {
    displayName: 'Telegram Album 487',
    name: 'telegramAlbum487',
    icon: 'file:telegram487.svg',
    group: ['output'],
    version: 1,
    description: 'Send binary photo albums or rich messages with file attachments',
    defaults: { name: 'Telegram Album 487' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'telegramApi', required: true }],
    properties: [
      {
        displayName: 'Operation', name: 'operation', type: 'options', default: 'sendMediaGroup',
        options: [
          { name: 'Send Album', value: 'sendMediaGroup' },
          { name: 'Send Rich Message', value: 'sendRichMessage' },
        ],
      },
      {
        displayName: 'Chat ID', name: 'chatId', type: 'string', default: '', required: true,
        description: 'Target chat ID or @channelusername, as in the standard Telegram node',
      },
      {
        displayName: 'Binary Fields', name: 'binaryProperties', type: 'string',
        default: 'image0,image1', required: true,
        description: 'Comma-separated binary fields: 2–10 album photos, or up to 10 rich-message files (file0, file1, ...)',
      },
      {
        displayName: 'Rich Message', name: 'richMessage', type: 'json', required: true,
        default: '{"blocks":[{"type":"paragraph","text":"Message"}]}',
        displayOptions: { show: { operation: ['sendRichMessage'] } },
        description: 'Telegram InputRichMessage JSON; refer to binary fields as attach://file0, attach://file1, ...',
      },
    ],
  };

  async execute() {
    const credentials = await this.getCredentials('telegramApi');
    const baseUrl = new URL(credentials.baseUrl || 'https://api.telegram.org');
    if (!['https:', 'http:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password ||
        baseUrl.search || baseUrl.hash || !/^[\w:-]+$/.test(credentials.accessToken || '')) {
      throw new Error('Invalid Telegram credential');
    }
    const urlBase = `${baseUrl.href.replace(/\/$/, '')}/bot${credentials.accessToken}`;
    const output = [];
    for (const [itemIndex] of this.getInputData().entries()) {
      const operation = this.getNodeParameter('operation', itemIndex, 'sendMediaGroup') || 'sendMediaGroup';
      const rich = operation === 'sendRichMessage';
      if (!['sendMediaGroup', 'sendRichMessage'].includes(operation)) throw new Error('Unsupported Telegram operation');
      const chatId = String(this.getNodeParameter('chatId', itemIndex)).trim();
      const fields = String(this.getNodeParameter('binaryProperties', itemIndex)).split(',').map(field => field.trim());
      if (rich && fields.length === 1 && fields[0] === '') fields.pop();
      if (!chatId || (!rich && fields.length < 2) || fields.length > 10 ||
          new Set(fields).size !== fields.length || fields.some(field => !field)) {
        throw new Error(rich ? 'A rich message requires a chat ID and at most 10 distinct binary fields' : 'An album requires a chat ID and 2–10 distinct binary fields');
      }
      const form = new FormData();
      const streams = [];
      try {
        form.append('chat_id', chatId);
        if (rich) {
          const input = this.getNodeParameter('richMessage', itemIndex);
          let message;
          try { message = typeof input === 'string' ? JSON.parse(input) : input; }
          catch { throw new Error('Invalid rich message JSON'); }
          if (!message || typeof message !== 'object' || Array.isArray(message) ||
              ['html', 'markdown', 'blocks'].filter(key => message[key] !== undefined).length !== 1 ||
              (message.blocks !== undefined && (!Array.isArray(message.blocks) || !message.blocks.length))) {
            throw new Error('Rich message must specify exactly one of html, markdown or nonempty blocks');
          }
          form.append('rich_message', JSON.stringify(message));
        }
        const media = [];
        for (const [index, field] of fields.entries()) {
          const metadata = this.helpers.assertBinaryData(itemIndex, field);
          if (!['image/jpeg', 'image/png'].includes(metadata.mimeType)) {
            throw new Error('Album photos must be JPEG or PNG');
          }
          let data;
          if (metadata.id) {
            data = await this.helpers.getBinaryStream(metadata.id);
            streams.push(data);
          } else {
            data = await this.helpers.getBinaryDataBuffer(itemIndex, field);
            if (!data.length || data.length > (rich ? 50 : 10) * 1024 * 1024) {
              throw new Error(rich ? 'Rich-message files must be nonempty and at most 50 MiB' : 'Telegram album photos must be nonempty and at most 10 MiB');
            }
          }
          const name = `${rich ? "file" : "photo"}${index}`;
          media.push({ type: 'photo', media: `attach://${name}` });
          form.append(name, data, {
            filename: `${field.replace(/[^a-zA-Z0-9_-]/g, '_')}.${metadata.mimeType === 'image/png' ? 'png' : 'jpg'}`,
            contentType: metadata.mimeType,
          });
        }
        if (!rich) form.append('media', JSON.stringify(media));
        let response;
        try {
          response = await this.helpers.httpRequest({
            method: 'POST', url: `${urlBase}/${operation}`, body: form, json: true, timeout: 30_000,
            disableFollowRedirect: true, returnFullResponse: true, ignoreHttpStatusErrors: true,
          });
        } catch {
          // HTTP errors may contain the credential-bearing URL. Never expose the original error/cause.
          throw new Error('Telegram upload failed: network, timeout or binary stream error');
        }
        const body = response.body;
        if (response.statusCode !== 200 || body?.ok !== true || (rich
          ? !Number.isInteger(body.result?.message_id)
          : !Array.isArray(body.result) || body.result.length !== fields.length ||
            body.result.some(message => !Number.isInteger(message.message_id)))) {
          const code = Number.isInteger(body?.error_code) ? body.error_code : response.statusCode;
          const retry = body?.parameters?.retry_after;
          throw new Error(`Telegram upload rejected (HTTP/API ${Number.isInteger(code) ? code : 'unknown'})` +
            (Number.isInteger(retry) && retry > 0 ? `; retry after ${retry}s` : ''));
        }
        output.push({ json: rich ? { message: body.result } : { messages: body.result }, pairedItem: { item: itemIndex } });
      } finally {
        streams.forEach(stream => stream.destroy());
        form.destroy();
      }
    }
    return [output];
  }
}

module.exports = { TelegramAlbum };
