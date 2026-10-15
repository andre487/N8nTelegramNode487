'use strict';

const FormData = require('form-data');

class TelegramAlbum {
  description = {
    displayName: 'Telegram Album 487',
    name: 'telegramAlbum487',
    icon: 'file:telegram487.svg',
    group: ['output'],
    version: 1,
    description: 'Send 2–10 binary photos as a Telegram album',
    defaults: { name: 'Telegram Album 487' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'telegramApi', required: true }],
    properties: [
      {
        displayName: 'Chat ID', name: 'chatId', type: 'string', default: '', required: true,
        description: 'Target chat ID or @channelusername, as in the standard Telegram node',
      },
      {
        displayName: 'Binary Fields', name: 'binaryProperties', type: 'string',
        default: 'image0,image1', required: true,
        description: 'Comma-separated binary field names in album order (2–10 JPEG/PNG photos)',
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
    const url = `${baseUrl.href.replace(/\/$/, '')}/bot${credentials.accessToken}/sendMediaGroup`;
    const output = [];
    for (const [itemIndex] of this.getInputData().entries()) {
      const chatId = String(this.getNodeParameter('chatId', itemIndex)).trim();
      const fields = String(this.getNodeParameter('binaryProperties', itemIndex)).split(',').map(field => field.trim());
      if (!chatId || fields.length < 2 || fields.length > 10 ||
          new Set(fields).size !== fields.length || fields.some(field => !field)) {
        throw new Error('An album requires a chat ID and 2–10 distinct binary fields');
      }
      const form = new FormData();
      const streams = [];
      try {
        form.append('chat_id', chatId);
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
            if (!data.length || data.length > 10 * 1024 * 1024) {
              throw new Error('Telegram album photos must be nonempty and at most 10 MiB');
            }
          }
          const name = `photo${index}`;
          media.push({ type: 'photo', media: `attach://${name}` });
          form.append(name, data, {
            filename: `${name}.${metadata.mimeType === 'image/png' ? 'png' : 'jpg'}`,
            contentType: metadata.mimeType,
          });
        }
        form.append('media', JSON.stringify(media));
        let response;
        try {
          response = await this.helpers.httpRequest({
            method: 'POST', url, body: form, json: true, timeout: 30_000,
            disableFollowRedirect: true, returnFullResponse: true, ignoreHttpStatusErrors: true,
          });
        } catch {
          // HTTP errors may contain the credential-bearing URL. Never expose the original error/cause.
          throw new Error('Telegram album upload failed: network, timeout or binary stream error');
        }
        const body = response.body;
        if (response.statusCode !== 200 || body?.ok !== true || !Array.isArray(body.result) ||
            body.result.length !== fields.length || body.result.some(message => !Number.isInteger(message.message_id))) {
          const code = Number.isInteger(body?.error_code) ? body.error_code : response.statusCode;
          const retry = body?.parameters?.retry_after;
          throw new Error(`Telegram album upload rejected (HTTP/API ${Number.isInteger(code) ? code : 'unknown'})` +
            (Number.isInteger(retry) && retry > 0 ? `; retry after ${retry}s` : ''));
        }
        output.push({ json: { messages: body.result }, pairedItem: { item: itemIndex } });
      } finally {
        streams.forEach(stream => stream.destroy());
        form.destroy();
      }
    }
    return [output];
  }
}

module.exports = { TelegramAlbum };
