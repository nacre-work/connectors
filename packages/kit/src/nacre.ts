/**
 * The SDK behind the engine's port. One place turns a `NacreError` into the
 * engine's own words: a `404` on ingest is a layer this account cannot write
 * to or that does not exist — the core makes the two indistinguishable on
 * purpose — and a `4xx` the request itself earned is a rejection the next
 * sweep will earn again, so neither is retried and both are counted.
 */
import { NacreClient, NacreError } from '@nacre.work/sdk'
import { IndexRefusal, type Index, type Mapped } from './engine.js'

export function nacreIndex(client: NacreClient): Index {
  return {
    async add(doc: Mapped) {
      try {
        const outcome = await client.documents.add({
          layer: doc.layer,
          externalId: doc.externalId,
          metadata: doc.metadata,
          ...(doc.title === undefined ? {} : { title: doc.title }),
          // Text goes in the JSON body; a binary document goes up as the
          // multipart form, under the type the source declared. The SDK
          // refuses a request carrying neither or both.
          ...(doc.bytes === undefined
            ? { content: doc.content ?? '' }
            : { bytes: doc.bytes, contentType: doc.contentType ?? '', filename: doc.externalId }),
        })
        return { documentId: outcome.documentId, unchanged: outcome.unchanged }
      } catch (e) {
        if (e instanceof NacreError) {
          if (e.status === 404) throw new IndexRefusal('layer_missing', `layer ${JSON.stringify(doc.layer)}: ${e.detail}`)
          if (e.status >= 400 && e.status < 500 && e.status !== 429) throw new IndexRefusal('rejected', `${String(e.status)}: ${e.detail}`)
        }
        throw e
      }
    },
    remove: (documentId: string) => client.documents.remove(documentId),
  }
}
