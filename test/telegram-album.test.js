'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { TelegramAlbum } = require('../nodes/TelegramAlbum/TelegramAlbum.node');

// Optional real n8n HTTP helper for compatibility checks inside an n8n container.
const httpRequest = process.env.N8N_HTTP_HELPER_PATH
  ? require(process.env.N8N_HTTP_HELPER_PATH).httpRequest
  : async options => {
    assert.equal(options.disableFollowRedirect, true);
    return new Promise((resolve, reject) => {
      const request = http.request(options.url, { method: options.method, headers: options.body.getHeaders() }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          try { resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); }
          catch (error) { reject(error); }
        });
      });
      request.on('error', reject);
      options.body.on('error', error => request.destroy(error));
      options.body.pipe(request);
    });
  };

function context(baseUrl, changes = {}) {
  const png = { mimeType: 'image/png', data: 'cG5nLWZpeHR1cmU=' };
  const jpeg = { mimeType: 'image/jpeg', id: 'stored-image' };
  const metadata = { first: png, second: jpeg };
  return {
    getCredentials: async type => {
      assert.equal(type, 'telegramApi');
      return { baseUrl, accessToken: '123:synthetic-token' };
    },
    getInputData: () => [{ binary: metadata }],
    getNodeParameter: name => ({ chatId: '-100487', binaryProperties: 'first,second' })[name],
    helpers: {
      assertBinaryData: (_, field) => { assert.ok(metadata[field]); return metadata[field]; },
      getBinaryDataBuffer: async (_, field) => {
        assert.equal(field, 'first');
        return Buffer.from(png.data, 'base64');
      },
      getBinaryStream: async id => {
        assert.equal(id, 'stored-image');
        return Readable.from([Buffer.from('jpeg-fixture')]);
      },
      httpRequest,
    },
    ...changes,
  };
}

async function withServer(handler, run) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('multipart preserves inline and stored bytes, album order and item linking', async () => {
  let seen;
  await withServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    seen = { path: request.url, type: request.headers['content-type'], body };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: [{ message_id: 7 }, { message_id: 8 }] }));
  }, async url => {
    const output = await TelegramAlbum.prototype.execute.call(context(url));
    assert.deepEqual(output[0][0].pairedItem, { item: 0 });
    assert.deepEqual(output[0][0].json.messages.map(message => message.message_id), [7, 8]);
  });
  assert.equal(seen.path, '/bot123:synthetic-token/sendMediaGroup');
  assert.match(seen.type, /^multipart\/form-data; boundary=/);
  for (const text of ['name="chat_id"', '-100487', 'name="photo0"', 'name="photo1"',
    'Content-Type: image/png', 'Content-Type: image/jpeg', 'png-fixture', 'jpeg-fixture',
    '[{"type":"photo","media":"attach://photo0"},{"type":"photo","media":"attach://photo1"}]']) {
    assert.ok(seen.body.includes(text), text);
  }
});

test('invalid album count and media fail before making an HTTP request', async () => {
  let calls = 0;
  const ctx = context('https://api.telegram.org');
  ctx.helpers.httpRequest = async () => { calls++; };
  for (const fields of ['first', Array.from({ length: 11 }, (_, i) => `photo${i}`).join(','), 'first,first', 'first,']) {
    ctx.getNodeParameter = name => name === 'operation' ? 'sendMediaGroup' : name === 'chatId' ? '487' : fields;
    await assert.rejects(TelegramAlbum.prototype.execute.call(ctx), /2–10/);
  }
  ctx.getNodeParameter = name => name === 'operation' ? 'sendMediaGroup' : name === 'chatId' ? '487' : 'first,second';
  ctx.helpers.assertBinaryData = () => ({ mimeType: 'image/gif' });
  await assert.rejects(TelegramAlbum.prototype.execute.call(ctx), /JPEG or PNG/);
  ctx.helpers.assertBinaryData = () => ({ mimeType: 'image/png' });
  ctx.helpers.getBinaryDataBuffer = async () => Buffer.alloc(10 * 1024 * 1024 + 1);
  await assert.rejects(TelegramAlbum.prototype.execute.call(ctx), /10 MiB/);
  assert.equal(calls, 0);
});

test('API failures and incomplete success do not report delivery or expose tokens', async () => {
  const ctx = context('https://api.telegram.org');
  for (const response of [
    { statusCode: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 12 } } },
    { statusCode: 200, body: { ok: false } },
    { statusCode: 200, body: { ok: true, result: [{ message_id: 1 }] } },
    { statusCode: 302, body: { ok: true, result: [{ message_id: 1 }, { message_id: 2 }] } },
  ]) {
    ctx.helpers.httpRequest = async () => response;
    await assert.rejects(TelegramAlbum.prototype.execute.call(ctx), error => {
      assert.ok(!JSON.stringify(error).includes('synthetic-token'));
      if (response.statusCode === 429) assert.match(error.message, /retry after 12s/);
      return /rejected/.test(error.message);
    });
  }
  ctx.helpers.httpRequest = async () => { throw new Error('GET /bot123:synthetic-token/sendMediaGroup failed'); };
  await assert.rejects(TelegramAlbum.prototype.execute.call(ctx), error => {
    assert.ok(!error.message.includes('synthetic-token'));
    assert.equal(error.cause, undefined);
    return /network/.test(error.message);
  });
});

test('binary streams are destroyed when upload fails', async () => {
  const ctx = context('https://api.telegram.org');
  const stream = Readable.from([Buffer.from('jpeg')]);
  ctx.helpers.getBinaryStream = async () => stream;
  ctx.helpers.httpRequest = async () => { throw new Error('failure'); };
  await assert.rejects(TelegramAlbum.prototype.execute.call(ctx));
  assert.equal(stream.destroyed, true);
});

test('rich message uploads text and two documents in one multipart request', async () => {
  let seen;
  const richMessage = { blocks: [
    { type: 'paragraph', text: [{ type: 'bold', text: 'App' }, '\nNotification <text>'] },
    { type: 'document', document: { type: 'document', media: 'attach://file0' }, caption: { text: 'Аватар' } },
    { type: 'document', document: { type: 'document', media: 'attach://file1' }, caption: { text: 'Значок приложения' } },
  ] };
  await withServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
    seen = { path: request.url, form };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
  }, async url => {
    const ctx = context(url);
    ctx.getNodeParameter = name => ({ operation: 'sendRichMessage', chatId: '487',
      binaryProperties: 'first,second', richMessage: JSON.stringify(richMessage) })[name];
    const output = await TelegramAlbum.prototype.execute.call(ctx);
    assert.equal(output[0].length, 1);
    assert.equal(output[0][0].json.message.message_id, 42);
    assert.deepEqual(output[0][0].pairedItem, { item: 0 });
  });
  assert.equal(seen.path, '/bot123:synthetic-token/sendRichMessage');
  assert.deepEqual(JSON.parse(seen.form.get('rich_message')), richMessage);
  assert.equal(await seen.form.get('file0').text(), 'png-fixture');
  assert.equal(await seen.form.get('file1').text(), 'jpeg-fixture');
  assert.equal(seen.form.has('media'), false);
});

test('rich message validation rejects ambiguous content and invalid success responses', async () => {
  const ctx = context('https://api.telegram.org');
  let richMessage;
  ctx.getNodeParameter = name => ({ operation: 'sendRichMessage', chatId: '487',
    binaryProperties: 'first,second', richMessage })[name];
  let calls = 0;
  ctx.helpers.httpRequest = async () => { calls++; return { statusCode: 200, body: { ok: true, result: [] } }; };
  for (richMessage of ['{', {}, { blocks: [] }, { html: 'a', blocks: [{ type: 'paragraph', text: 'b' }] }]) {
    await assert.rejects(TelegramAlbum.prototype.execute.call(ctx), /rich message|Rich message/);
  }
  assert.equal(calls, 0);
  richMessage = { blocks: [{ type: 'paragraph', text: 'Test' }] };
  await assert.rejects(TelegramAlbum.prototype.execute.call(ctx), /rejected/);
  assert.equal(calls, 1);
});

test('the album limit does not truncate rich-message attachments', async () => {
  const ctx = context('https://api.telegram.org');
  const fields = Array.from({ length: 11 }, (_, index) => `image${index}`);
  ctx.getNodeParameter = name => ({ operation: 'sendRichMessage', chatId: '487',
    binaryProperties: fields.join(','), richMessage: { blocks: fields.map((_, index) => ({
      type: 'photo', photo: { type: 'photo', media: `attach://file${index}` },
    })) } })[name];
  ctx.helpers.assertBinaryData = () => ({ mimeType: 'image/png' });
  ctx.helpers.getBinaryDataBuffer = async () => Buffer.from('fixture');
  ctx.helpers.httpRequest = async options => {
    assert.ok(options.body.getBuffer().includes(Buffer.from('name="file10"')));
    return { statusCode: 200, body: { ok: true, result: { message_id: 11 } } };
  };
  const output = await TelegramAlbum.prototype.execute.call(ctx);
  assert.equal(output[0][0].json.message.message_id, 11);
});
