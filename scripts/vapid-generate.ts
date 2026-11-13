// npm run vapid:generate
// Prints a fresh VAPID key pair for Web Push and the wrangler commands that store it as Worker
// secrets. It writes no file: copy the values yourself (the private key is not kept anywhere).
import { generateVapidKeyPair } from '../src/lib/webpush'

const { publicKey, privateKey } = await generateVapidKeyPair()

console.log(`VAPID key pair (P-256, base64url)

VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}

Production: store both as Worker secrets (wrangler asks for the value; paste it there).
  npx wrangler secret put VAPID_PUBLIC_KEY
  npx wrangler secret put VAPID_PRIVATE_KEY
Optional: VAPID_SUBJECT = a mailto: or https: contact URL for the push services
(default https://pnphoto.co).

Local dev: add the same two lines to .dev.vars.

Keep the private key secret. Replacing the pair later invalidates every existing push
subscription; members have to turn notifications on again.`)
