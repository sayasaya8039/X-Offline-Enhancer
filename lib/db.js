/**
 * IndexedDB Helper - GlobalThis Wrapper
 * Re-exports db-esm.js (canonical source) via globalThis.XOfflineDB
 * Load as: <script type="module" src="lib/db.js">
 */
import {
  openDB, addThread, addThreads, getThread, getAllThreads, getAllThreadsMeta,
  deleteThread, deleteAllThreads, searchThreads, getSavedIds, getStorageSize,
  addImage, addImages, getImagesForThread, deleteImagesForThread
} from './db-esm.js';

globalThis.XOfflineDB = {
  openDB, addThread, addThreads, getThread, getAllThreads, getAllThreadsMeta,
  deleteThread, deleteAllThreads, searchThreads, getSavedIds, getStorageSize,
  addImage, addImages, getImagesForThread, deleteImagesForThread
};
