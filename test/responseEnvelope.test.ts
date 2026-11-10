// Every JSON body goes out as `{ statusCode, result }`. Exercised through a real Express
// app on an ephemeral port, since the envelope is a patch on `res.json`.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

import express from 'express'

import { errorHandler, notFoundHandler } from '../src/http/middleware/errorHandler.js'
import { responseEnvelope } from '../src/http/middleware/responseEnvelope.js'

let server: ReturnType<express.Express['listen']>
let base = ''

before(async () => {
  const app = express()
  app.use(responseEnvelope)
  app.use(express.json())
  app.get('/ok', (_req, res) => res.json({ hello: 'world' }))
  app.get('/created', (_req, res) => res.status(201).json([1, 2]))
  app.get('/conflict', (_req, res) => res.status(409).json({ error: 'cart_full', limit: 3 }))
  app.get('/send', (_req, res) => res.send({ via: 'send' }))
  app.get('/empty', (_req, res) => res.status(204).end())
  app.get('/text', (_req, res) => res.type('text/plain').send('plain'))
  app.post('/echo', (req, res) => res.json(req.body))
  app.use(notFoundHandler)
  app.use(errorHandler)
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve)
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  server.close()
})

async function get(path: string, init?: RequestInit) {
  const res = await fetch(base + path, init)
  return { status: res.status, body: await res.text() }
}

describe('responseEnvelope', () => {
  it('wraps a success body with its status', async () => {
    const { status, body } = await get('/ok')
    assert.equal(status, 200)
    assert.deepEqual(JSON.parse(body), { statusCode: 200, result: { hello: 'world' } })
  })

  it('carries a non-200 status and non-object results', async () => {
    const { body } = await get('/created')
    assert.deepEqual(JSON.parse(body), { statusCode: 201, result: [1, 2] })
  })

  it('wraps error bodies the same way, extras included', async () => {
    const { status, body } = await get('/conflict')
    assert.equal(status, 409)
    assert.deepEqual(JSON.parse(body), {
      statusCode: 409,
      result: { error: 'cart_full', limit: 3 },
    })
  })

  it('wraps res.send(object) once, not twice', async () => {
    const { body } = await get('/send')
    assert.deepEqual(JSON.parse(body), { statusCode: 200, result: { via: 'send' } })
  })

  it('leaves empty and non-JSON bodies alone', async () => {
    assert.deepEqual(await get('/empty'), { status: 204, body: '' })
    assert.deepEqual(await get('/text'), { status: 200, body: 'plain' })
  })

  it('wraps the 404 fallback and body-parser failures', async () => {
    const missing = await get('/nope')
    assert.deepEqual(JSON.parse(missing.body), { statusCode: 404, result: { error: 'not_found' } })

    const bad = await get('/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    assert.equal(bad.status, 400)
    assert.deepEqual(JSON.parse(bad.body), { statusCode: 400, result: { error: 'invalid_json' } })
  })
})
