export function generateMongoId() {
  // 24 hex chars: 12 bytes (like MongoDB ObjectId, but random)
  let id = ''
  for (let i = 0; i < 24; i++) {
    id += Math.floor(Math.random() * 16).toString(16)
  }
  return id
}
