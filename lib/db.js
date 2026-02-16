/**
 * IndexedDB Helper - GlobalThis Wrapper
 * Re-exports db-esm.js (canonical source) via globalThis.XOfflineDB
 * Load as: <script type="module" src="lib/db.js">
 */
import {
  openDB, addThread, getThread, getAllThreads, getAllThreadsMeta,
  deleteThread, deleteAllThreads, searchThreads, getSavedIds, getStorageSize
} from './db-esm.js';

globalThis.XOfflineDB = {
  openDB, addThread, getThread, getAllThreads, getAllThreadsMeta,
  deleteThread, deleteAllThreads, searchThreads, getSavedIds, getStorageSize
};
