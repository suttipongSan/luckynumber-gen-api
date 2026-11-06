// npm run hash-password -- <password>
// Prints a PBKDF2 hash suitable for ADMIN_PASSWORD_HASH.
import { hashPassword } from '../src/lib/crypto'

const password = process.argv[2]
if (!password) {
  console.error('Usage: npm run hash-password -- <password>')
  process.exit(1)
}
console.log(await hashPassword(password))
