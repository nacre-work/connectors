#!/usr/bin/env node
/**
 * The live run's hand on a mailbox: put a message in it, take one out.
 *
 *   mail.mjs send <to> <subject> <message-id> <layer> <text>
 *   mail.mjs delete <message-id>
 *
 * `send` speaks SMTP itself, over `node:net` to the GreenMail the live stack
 * starts, because the whole protocol here is six lines and a dependency for
 * it would be the one thing in this repository that exists only for a test
 * fixture. The message carries an `X-Layer` header, which is the field the
 * connector's `IMAP_LAYER` reads in that run. `delete` is the half SMTP
 * cannot do: it goes through the same `imapflow` the connector carries —
 * resolved from the connector's own `node_modules`, so this script adds
 * nothing to the workspace — searches the folder for the Message-ID, and
 * expunges what it finds.
 *
 * The account is the one the run addresses, and its login is its address:
 * GreenMail creates a user for a delivery with the address as the login, so
 * that is the name the folder is read under.
 */
import { createRequire } from 'node:module'
import { connect } from 'node:net'

// The ports the live stack publishes; a sandbox that runs a GreenMail of its
// own elsewhere names them, the way `LIVE_*_IMAGE` points the stack elsewhere.
const SMTP_PORT = Number(process.env.LIVE_SMTP_PORT ?? 3025)
const IMAP_PORT = Number(process.env.LIVE_IMAP_PORT ?? 3143)
const ACCOUNT = { user: 'live@example.com', pass: 'live' }

function usage() {
  console.error('usage: mail.mjs send <to> <subject> <message-id> <layer> <text> | delete <message-id>')
  process.exit(2)
}

/** One SMTP session: each line sent waits for the reply code it expects, and a reply it did not expect is the run's failure. */
async function send(to, subject, messageId, layer, text) {
  const socket = connect({ host: 'localhost', port: SMTP_PORT })
  const lines = []
  const waiting = []
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      lines.push(buffer.slice(0, nl).replace(/\r$/, ''))
      buffer = buffer.slice(nl + 1)
      if (waiting.length > 0) waiting.shift()()
    }
  })
  const failed = new Promise((_, reject) => {
    socket.on('error', reject)
    socket.on('close', () => reject(new Error('the SMTP server closed the connection')))
  })
  // A reply is one or more lines; the last carries a space after the code.
  const reply = async (expected) => {
    for (;;) {
      while (lines.length === 0) await Promise.race([new Promise((resolve) => waiting.push(resolve)), failed])
      const line = lines.shift()
      if (/^\d{3} /.test(line)) {
        if (!line.startsWith(String(expected))) throw new Error(`SMTP answered ${JSON.stringify(line)}, expected ${String(expected)}`)
        return
      }
    }
  }
  const say = async (line, expected) => {
    socket.write(`${line}\r\n`)
    await reply(expected)
  }
  await reply(220)
  await say('EHLO live', 250)
  await say('MAIL FROM:<sender@example.com>', 250)
  await say(`RCPT TO:<${to}>`, 250)
  await say('DATA', 354)
  const body = text
    .split(/\r?\n/)
    .map((l) => (l.startsWith('.') ? `.${l}` : l))
    .join('\r\n')
  const message = [
    'From: Sender <sender@example.com>',
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `X-Layer: ${layer}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n')
  await say(`${message}\r\n.`, 250)
  socket.write('QUIT\r\n')
  await reply(221).catch(() => undefined)
  socket.destroy()
}

async function remove(messageId) {
  const require = createRequire(new URL('../../connectors/imap/package.json', import.meta.url))
  const { ImapFlow } = require('imapflow')
  const client = new ImapFlow({ host: 'localhost', port: IMAP_PORT, secure: false, auth: ACCOUNT, logger: false, disableAutoIdle: true })
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true })
      if (Array.isArray(uids) && uids.length > 0) await client.messageDelete(uids, { uid: true })
      console.log(`deleted ${String(Array.isArray(uids) ? uids.length : 0)} message(s) carrying ${messageId}`)
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}

const [verb, ...args] = process.argv.slice(2)
switch (verb) {
  case 'send': {
    if (args.length !== 5) usage()
    await send(...args)
    break
  }
  case 'delete': {
    if (args.length !== 1) usage()
    await remove(args[0])
    break
  }
  default:
    usage()
}
