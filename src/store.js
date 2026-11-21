// Per-user settings (plugin_setting_id and chart interval), persisted to a JSON file readable by the owner only.
// Writes are atomic (temp file + rename), so a crash mid-write never leaves a truncated file behind.

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'connections.json');

function load(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map(obj && typeof obj === 'object' ? Object.entries(obj) : []);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${path.basename(file)}: ${err.message}`);
    return new Map();
  }
}

// Returns true when the file was written.
function save(map, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`Could not write ${path.basename(file)}: ${err.message}`);
    return false;
  }
}

function createStore(file = DATA_FILE) {
  const map = load(file);
  return {
    get: (uuid) => map.get(uuid) || null,
    // Merges patch into the user's record and persists it. Returns the record, or null if it could not be
    // written (the in-memory state is rolled back so memory and disk never disagree).
    update(uuid, patch) {
      const prev = map.get(uuid);
      const next = { ...(prev || {}), ...patch, updated_at: new Date().toISOString() };
      map.set(uuid, next);
      if (save(map, file)) return next;
      if (prev) map.set(uuid, prev);
      else map.delete(uuid);
      return null;
    },
    delete(uuid) {
      if (map.delete(uuid)) save(map, file);
    },
    all: () => [...map.values()],
    size: () => map.size,
  };
}

module.exports = { createStore, DATA_FILE };
