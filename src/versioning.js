import fs from 'fs'
import path from 'path'

const VERSIONS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'versions'
)

// Ensure versions directory exists
if (!fs.existsSync(VERSIONS_DIR)) {
  fs.mkdirSync(VERSIONS_DIR)
}

/**
 * Save a new version of the .vf file with a timestamp.
 * @param {string} currentFilePath - Path to the current .vf file
 * @returns {string} - The new version filename
 */
export function saveNewVersion(currentFilePath) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)
  const baseName = path.basename(currentFilePath, '.vf')
  const newVersionName = `${baseName}_v${timestamp}.vf`
  const newVersionPath = path.join(VERSIONS_DIR, newVersionName)
  fs.copyFileSync(currentFilePath, newVersionPath)
  return newVersionName
}

/**
 * List all saved versions in the versions directory.
 * @returns {string[]} - Array of version filenames
 */
export function listVersions() {
  return fs.readdirSync(VERSIONS_DIR).filter((f) => f.endsWith('.vf'))
}

/**
 * Revert to a previous version by copying it to the target path.
 * @param {string} versionFileName - The version filename to revert to
 * @param {string} targetFilePath - The path to overwrite with the version
 */
export function revertToVersion(versionFileName, targetFilePath) {
  const versionPath = path.join(VERSIONS_DIR, versionFileName)
  if (!fs.existsSync(versionPath)) {
    throw new Error('Version file does not exist: ' + versionFileName)
  }
  fs.copyFileSync(versionPath, targetFilePath)
}

/**
 * Wrap a mutation with auto-versioning: saves a version after running the mutation.
 * @param {string} currentFilePath - Path to the current .vf file
 * @param {Function} mutationFn - Function that performs the mutation (can be async)
 * @returns {Promise<*>} - Result of mutationFn
 */
export async function withAutoVersioning(currentFilePath, mutationFn) {
  const result = await mutationFn()
  saveNewVersion(currentFilePath)
  return result
}
