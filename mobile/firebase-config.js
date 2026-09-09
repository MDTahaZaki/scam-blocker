// Firebase project configuration, loaded by mobile/index.html before app.js.
// REPLACE WITH YOUR FIREBASE PROJECT CONFIG.
//
// Use the exact same values as extension/firebase-config.js — this PWA
// talks to the same Firebase project (same `getBlocklist` / `reportUrl`
// callables, same Firestore data). Find these values in the Firebase
// console: Project settings -> General -> Your apps -> Web app -> SDK
// setup and configuration.
//
// Leaving apiKey empty runs the PWA in local-only mode: heuristic checking
// still works, but blocklist sync and "Report as Scam" are disabled until
// this is filled in.
const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: ''
};
